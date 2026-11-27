// The screen walk, kept (in-house re-audit step 4,
// docs/in-house-reaudit-build-note.md). The real web app, at phone width
// (375 x 812), in a real browser, against a faked server and a vault built
// by our own compiler from public test seeds. It caught two bugs on
// 2026-11-25 that no other test could see: a signature count stuck at
// "0 / 1" after signing, and buttons whose result opened off screen.
//
// It FAILS when: a tapped button's result is not fully on screen, the
// count after signing is wrong, Broadcast is missing once signed, or the
// page throws. Screenshots go to the OS temp folder (path printed).
//
// Not part of `npm test` (it starts a dev server and a browser).
// Run: npm run walk:screens
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
process.env.WALK_FIXTURE = path.join(os.tmpdir(), 'dt-screen-walk-fixture.json');
execFileSync(process.execPath, ['--experimental-strip-types', '--import', './scripts/register-ts-resolver.mjs', 'scripts/screen-walk/make-vault.mjs', process.env.WALK_FIXTURE], { cwd: ROOT, stdio: 'inherit' });
const { chromium } = require('playwright');
const M = require('./mock.cjs');
const PORT = 5299;
const BASE = `http://localhost:${PORT}`;
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-screen-walk-'));
const VIEW = { width: 375, height: 812 };
const report = { shots: [], taps: [], errors: [], console: [] };

function seededKey() {
  const FX = M.FX;
  return [{
    keyId: 'walk-key-1', label: 'My phone key', persona: 'Founder 1', origin: 'software', network: 'testnet',
    fingerprint: FX.origins[0].fingerprint, masterFingerprint: FX.origins[0].fingerprint, derivationPath: "m/48'/1'/0'/2'",
    xpub: FX.origins[0].xpub, pubkey: FX.pk[0], status: 'active', createdAt: '2026-11-20T12:00:00Z',
    testMnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', backedUp: true,
  }];
}

async function newPage(browser) {
  M.resetVk();
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await M.install(context);
  await context.addInitScript(([k]) => { try { localStorage.setItem('dynastytrust:keyring:v1', k); } catch { /* */ } }, [JSON.stringify(seededKey())]);
  const page = await context.newPage();
  page.on('pageerror', e => report.errors.push(`${page.url()} :: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/WebSocket|realtime/.test(m.text())) report.console.push(`${page.url()} :: ${m.text().slice(0, 300)}`); });
  return { context, page };
}

async function shot(page, name, what) {
  const top = path.join(SHOTS, `${name}-viewport.png`);
  const full = path.join(SHOTS, `${name}-full.png`);
  await page.screenshot({ path: top });
  await page.screenshot({ path: full, fullPage: true });
  const dims = await page.evaluate(() => ({ scrollY: Math.round(scrollY), docHeight: document.documentElement.scrollHeight, docWidth: document.documentElement.scrollWidth }));
  report.shots.push({ name, what, viewport: top, full, ...dims });
}

// Record what appears or changes after a tap.
async function arm(page) {
  await page.evaluate(() => {
    window.__muts = [];
    window.__mo && window.__mo.disconnect();
    window.__mo = new MutationObserver(list => { for (const m of list) window.__muts.push(m); });
    window.__mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'src', 'value', 'open'] });
  });
}
async function collect(page) {
  return page.evaluate(() => {
    window.__mo.disconnect();
    const els = new Set();
    for (const m of window.__muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) els.add(n);
          else if (n.parentElement) els.add(n.parentElement);
        }
      } else if (m.type === 'characterData') { if (m.target.parentElement) els.add(m.target.parentElement); }
      else if (m.type === 'attributes') { const r = m.target.getBoundingClientRect(); if (r.height < innerHeight * 1.2) els.add(m.target); }
    }
    // keep outermost connected, visible elements
    const list = [...els].filter(e => e.isConnected && e !== document.body && e !== document.documentElement);
    const outer = list.filter(e => !list.some(o => o !== e && o.contains(e)));
    const sy = scrollY;
    const out = [];
    for (const e of outer) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const where = r.bottom <= 0 ? 'ABOVE viewport' : r.top >= innerHeight ? 'BELOW viewport' : (r.top >= 0 && r.bottom <= innerHeight ? 'fully inside viewport' : 'partly inside viewport');
      out.push({ tag: e.tagName.toLowerCase(), text: (e.innerText || e.getAttribute('alt') || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 90),
        viewportY: Math.round(r.top), docY: Math.round(r.top + sy), x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), position: where, fixed: cs.position === 'fixed' });
    }
    return out.slice(0, 12);
  });
}
async function landmarksOf(page, landmarks) {
  const out = [];
  for (const lm of landmarks) {
    const loc = page.getByText(lm, { exact: false }).first();
    if (!(await loc.count())) { out.push({ landmark: String(lm), found: false }); continue; }
    const bb = await loc.boundingBox();
    const sy = await page.evaluate(() => scrollY);
    if (!bb) { out.push({ landmark: String(lm), found: true, visible: false }); continue; }
    const where = bb.y + bb.height <= 0 ? 'ABOVE viewport' : bb.y >= VIEW.height ? 'BELOW viewport' : (bb.y >= 0 && bb.y + bb.height <= VIEW.height ? 'fully inside viewport' : 'partly inside viewport');
    out.push({ landmark: String(lm), viewportY: Math.round(bb.y), docY: Math.round(bb.y + sy), h: Math.round(bb.height), position: where });
  }
  return out;
}
async function tap(page, locator, label, waitMs = 1500, landmarks = []) {
  await locator.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => Math.round(scrollY));
  const bb = await locator.boundingBox();
  await arm(page);
  await locator.click();
  await page.waitForTimeout(waitMs);
  const after = await page.evaluate(() => Math.round(scrollY));
  const changed = await collect(page);
  const marks = await landmarksOf(page, landmarks);
  const entry = { label, landmarks: marks, button: bb && { viewportY: Math.round(bb.y), docY: Math.round(bb.y + before), h: Math.round(bb.height) }, scrollYBefore: before, scrollYAfter: after, changed };
  report.taps.push(entry);
  return entry;
}


const failures = [];
function expectInView(entry, names) {
  for (const name of names) {
    const m = entry.landmarks.find(l => l.landmark === name);
    if (!m || m.found === false || m.position !== 'fully inside viewport') failures.push(`${entry.label}: "${name}" is ${m ? (m.position || 'not visible') : 'missing'}`);
  }
}
function expectAbsent(entry, name) {
  const m = entry.landmarks.find(l => l.landmark === name);
  if (m && m.found !== false) failures.push(`${entry.label}: "${name}" should be gone`);
}

async function main() {
  const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--config', path.join(__dirname, 'vite.config.mjs'), '--port', String(PORT), '--strictPort'],
    { cwd: path.join(ROOT, 'apps/web'), env: { ...process.env, VITE_SUPABASE_URL: 'https://fakeproj.supabase.co', VITE_SUPABASE_ANON_KEY: 'walk-anon-key' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE); if (r.ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 500)); }
    const browser = await chromium.launch();
    const VAULT_URL = `${BASE}/vaults/${M.VAULT_ID}`;
    const ready = async (page) => { await page.getByText('Everyday signers', { exact: false }).first().waitFor({ timeout: 30000 }); await page.waitForTimeout(2500); };

    { // Receive: the address to give out now, its number, Copy -- on screen, and the line stays.
      const { context, page } = await newPage(browser);
      await page.goto(VAULT_URL); await ready(page);
      await shot(page, 'overview', 'Overview on load');
      expectInView(await tap(page, page.getByRole('button', { name: 'Receive', exact: true }), 'Receive', 2500, ['Address number', 'Copy address']), ['Address number', 'Copy address']);
      const cp = await tap(page, page.getByRole('button', { name: 'Copy address', exact: true }), 'Copy address', 4000, ['Address number']);
      expectInView(cp, ['Address number']);
      await shot(page, 'receive', 'Receive, 4 seconds after copying');
      await context.close();
    }
    { // Send: the form on screen after Send; review on screen; after one signature, 1 / 1 and Broadcast.
      const { context, page } = await newPage(browser);
      await page.goto(VAULT_URL); await ready(page);
      expectInView(await tap(page, page.getByRole('button', { name: 'Send', exact: true }).first(), 'Send (under the balance)', 2000, ['SEND TO', 'Review & sign']), ['SEND TO', 'Review & sign']);
      await page.locator('input').filter({ hasNot: page.locator('[type=checkbox]') }).nth(0).fill('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
      await page.locator('input[type=number]').first().fill('0.00005');
      expectInView(await tap(page, page.getByRole('button', { name: /Review & sign/ }), 'Review & sign', 4000, ['My phone key']), ['My phone key']);
      const signed = await tap(page, page.getByText('Tap to sign', { exact: false }).first(), 'Tap to sign (Send)', 4000, ['1 / 1', 'Broadcast transaction', 'more signature']);
      expectInView(signed, ['1 / 1', 'Broadcast transaction']);
      expectAbsent(signed, 'more signature');
      await shot(page, 'send-signed', 'Send after one signature');
      // Broadcast: the done screen and its txid on screen, the spend recorded
      // with that txid, sent exactly once, and no Broadcast button left to press.
      M.state.broadcasts.length = 0; M.state.patches.length = 0;
      const sent = await tap(page, page.getByRole('button', { name: /Broadcast transaction/ }).first(), 'Broadcast (Send)', 1500, ['Transaction broadcast', 'Broadcast transaction', 'Record it in history']);
      expectInView(sent, ['Transaction broadcast']);
      expectAbsent(sent, 'Broadcast transaction');
      expectAbsent(sent, 'Record it in history');
      const txid = M.state.finalTxid;
      if (!txid) failures.push('Broadcast (Send): the finalizer gave no txid');
      else expectInView({ label: 'Broadcast (Send)', landmarks: await landmarksOf(page, [txid]) }, [txid]);
      if (M.state.broadcasts.length !== 1) failures.push(`Broadcast (Send): sent ${M.state.broadcasts.length} times, expected 1`);
      const rec = M.state.patches.filter(x => x.status === 'broadcast');
      if (rec.length !== 1 || rec[0].txid !== txid) failures.push(`Broadcast (Send): recorded ${JSON.stringify(M.state.patches)}, expected one "broadcast" with txid ${txid}`);
      await shot(page, 'send-done', 'Send after Broadcast');
      await context.close();
    }
    { // Send: once a signature is collected, Cancel asks first, and nothing is
      // cancelled until it's confirmed. (With no signatures it cancels at once.)
      const { context, page } = await newPage(browser);
      await page.goto(VAULT_URL); await ready(page);
      M.state.patches.length = 0;
      await tap(page, page.getByRole('button', { name: 'Send', exact: true }).first(), 'Send (for Cancel)', 2000, ['Review & sign']);
      await page.locator('input').filter({ hasNot: page.locator('[type=checkbox]') }).nth(0).fill('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
      await page.locator('input[type=number]').first().fill('0.00005');
      await tap(page, page.getByRole('button', { name: /Review & sign/ }), 'Review & sign (for Cancel)', 4000, ['My phone key']);
      await tap(page, page.getByText('Tap to sign', { exact: false }).first(), 'Tap to sign (for Cancel)', 4000, ['1 / 1']);
      M.state.patches.length = 0;
      const ask = await tap(page, page.getByRole('button', { name: 'Cancel this spend', exact: true }).first(), 'Cancel this spend', 1000, ['Cancel this spend?', 'My phone key']);
      expectInView(ask, ['Cancel this spend?']);
      if (M.state.patches.length) failures.push(`Cancel this spend: changed the request before it was confirmed: ${JSON.stringify(M.state.patches)}`);
      await shot(page, 'send-cancel-ask', 'Cancel asks first');
      await context.close();
    }
    { // More: the four other tabs appear on screen.
      const { context, page } = await newPage(browser);
      await page.goto(VAULT_URL); await ready(page);
      expectInView(await tap(page, page.getByRole('button', { name: 'More', exact: true }), 'More', 1000, ['Requests', 'Activity']), ['Requests', 'Activity']);
      await context.close();
    }
    { // Request page: sign, and Broadcast is on screen.
      const { context, page } = await newPage(browser);
      await page.goto(`${BASE}/vaults/${M.VAULT_ID}/proposals/${M.PROPOSAL_ID}`);
      await page.getByText('Sign with your key', { exact: false }).first().waitFor({ timeout: 30000 });
      const s = await tap(page, page.getByRole('button', { name: /My phone key/ }).first(), 'Sign on the request page', 4000, ['Broadcast transaction']);
      expectInView(s, ['Broadcast transaction']);
      await shot(page, 'request-signed', 'Request page after signing');
      await context.close();
    }
    await browser.close();
  } finally {
    vite.kill();
  }
  for (const e of report.errors) failures.push(`page error: ${e}`);
  console.log(`screenshots: ${SHOTS}`);
  for (const t of report.taps) console.log(`  tap "${t.label}": scroll ${t.scrollYBefore} -> ${t.scrollYAfter}`);
  if (failures.length) {
    console.error(`\nscreen walk FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nscreen walk OK -- ${report.taps.length} taps, every result on screen, no page errors`);
}
main().catch(e => { console.error(e); process.exit(1); });
