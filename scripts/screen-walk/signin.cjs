// Tapit sign-in walk (docs/tapit-signin-inbox-build-note.md): the signed-out
// sign-in page at 375 px, faked server and faked Nostr relays. Checks that a
// remembered Tapit key gets the request straight away, addressed to it; that
// with no key nothing is sent until one is given; and the QR/Safari fallback.
// Run: npm run walk:signin
const path = require('path'); const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '../..'); const OUT = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'dt-signin-walk-'));
process.chdir(ROOT); process.env.WALK_FIXTURE = path.join(require('os').tmpdir(), 'dt-screen-walk-fixture.json');
require('child_process').execFileSync(process.execPath, ['--experimental-strip-types', '--import', './scripts/register-ts-resolver.mjs', 'scripts/screen-walk/make-vault.mjs', process.env.WALK_FIXTURE], { cwd: ROOT, stdio: 'inherit' });
const M = require(path.join(ROOT, 'scripts/screen-walk/mock.cjs'));
const { chromium } = require('playwright');
const PORT = 5297, BASE = `http://localhost:${PORT}`;
const KEY = M.FX.pk[0].slice(2).toLowerCase();
const fails = [];
async function run(browser, remembered) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
  await M.install(ctx);
  await ctx.addInitScript(([k]) => { localStorage.removeItem('sb-fakeproj-auth-token'); if (k) localStorage.setItem('dt:tapitKey:v1', k); }, [remembered ? KEY : null]);
  let challenges = 0;
  await ctx.route('**/api/wallet-signin-challenge', r => { challenges++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ challenge: { v: 1, domain: 'localhost', nonce: (challenges.toString(16)).padStart(64, '0'), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 6e5).toISOString() } }) }); });
  const frames = [];
  await ctx.routeWebSocket(/^wss?:/, ws => { ws.onMessage(m => { frames.push(String(m)); try { const j = JSON.parse(m); if (j[0] === 'EVENT') ws.send(JSON.stringify(['OK', j[1].id, true, ''])); if (j[0] === 'REQ') ws.send(JSON.stringify(['EOSE', j[1]])); } catch {} }); });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '/keys');
  await page.getByRole('button', { name: 'Sign in with Tapit' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Sign in with Tapit' }).click();
  await page.waitForTimeout(3000);
  const name = remembered ? 'remembered' : 'fresh';
  await page.screenshot({ path: path.join(OUT, `signin-${name}.png`), fullPage: true });
  const events = frames.map(f => { try { return JSON.parse(f); } catch { return null; } }).filter(j => j && j[0] === 'EVENT').map(j => j[1]);
  const sent = events.filter(e => e.kind === 9583);
  if (remembered) {
    if (!(await page.getByText('Sent to your Tapit').count())) fails.push('remembered: no "Sent to your Tapit"');
    if (!sent.length) fails.push('remembered: no sign-in request event published');
    else if (!sent.some(e => (e.tags || []).some(t => t[0] === 'p' && t[1] === KEY))) fails.push('remembered: request not addressed to the remembered key: ' + JSON.stringify(sent.map(e => e.tags)));
  } else {
    if (!(await page.getByRole('button', { name: 'Send to my Tapit' }).count())) fails.push('fresh: no "Send to my Tapit"');
    if (sent.length) fails.push('fresh: sent something before a key was given');
    await page.getByLabel('Tapit public key').fill(KEY);
    await page.getByRole('button', { name: 'Send to my Tapit' }).click();
    await page.waitForTimeout(2500);
    if (!(await page.getByText('Sent to your Tapit').count())) fails.push('fresh: no "Sent to your Tapit" after Send');
    await page.getByRole('button', { name: /Other ways: scan/ }).click(); await page.waitForTimeout(800);
    if (!(await page.getByText('Open Tapit in this browser instead').count())) fails.push('fresh: Safari link missing under Other ways');
    await page.screenshot({ path: path.join(OUT, `signin-${name}-sent.png`), fullPage: true });
  }
  const w = await page.evaluate(() => document.documentElement.scrollWidth); if (w > 375) fails.push(`${name}: page ${w}px wide`);
  if (errs.length) fails.push(`${name}: page errors ${errs.join('; ')}`);
  console.log(name, 'challenges', challenges, 'events', events.map(e => e.kind).join(','));
  await ctx.close();
}
(async () => {
  const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--config', path.join(ROOT, 'scripts/screen-walk/vite.config.mjs'), '--port', String(PORT), '--strictPort'],
    { cwd: path.join(ROOT, 'apps/web'), env: { ...process.env, VITE_SUPABASE_URL: 'https://fakeproj.supabase.co', VITE_SUPABASE_ANON_KEY: 'walk-anon-key' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
    const browser = await chromium.launch();
    await run(browser, true); await run(browser, false);
    await browser.close();
  } finally { vite.kill(); }
  console.log(fails.length ? 'FAILED\n  ' + fails.join('\n  ') : 'sign-in walk OK');
  process.exit(fails.length ? 1 : 0);
})();
