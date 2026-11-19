/**
 * test-timelock-wording.mjs -- the words people read about a FIXED-date
 * timelock never say it resets, refreshes, or waits for inactivity.
 *
 * DynastyTrust has two kinds of timelock: "after a fixed date" (after(),
 * absolute CLTV -- nothing moves it) and "if left untouched" (older(),
 * relative CSV -- restarts every time the coins move; path builder only,
 * capped at ~13.7 months). Every preset template compiles through the
 * standard builder, which only ever makes the fixed-date kind. A live walk
 * (operator, 2026-11-19) found Sage and three templates describing those
 * fixed dates as resetting with activity -- a family could believe their
 * heirs stay locked out while they keep spending, and never rotate.
 *
 * Checks: (1) no preset template's text uses inactivity/refresh wording;
 * (2) Sage's prompt carries the fact sheet first and its template digest
 * has no such wording.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-timelock-wording.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VAULT_TEMPLATES } from '../apps/web/src/lib/vault-templates.ts';
import { buildStandardTrustDoc, buildBlocTrustDoc } from '../apps/web/src/lib/trust-doc.ts';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// Wording that only fits the "if left untouched" kind.
const RESETTING = /no activity|inactivity|silen(t|ce)|refresh(es)? the (timelock|timer|clock)|reset(s)? the (clock|timer|timelock)|re-anchor|stop touching/i;

function strings(x, out = []) {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach(v => strings(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach(v => strings(v, out));
  return out;
}

// 1. Every preset template builds fixed dates only, so none may describe one as resetting.
for (const t of VAULT_TEMPLATES) {
  for (const s of strings(t)) {
    assert.ok(!RESETTING.test(s), `template "${t.id}" describes a fixed date as resetting: ${s.slice(0, 160)}`);
  }
}
pass(`${VAULT_TEMPLATES.length} preset templates never describe a fixed date as resetting`);

// 1b. The trust document each preset generates -- what an owner keeps --
//     says the same true thing.
let docs = 0;
for (const t of VAULT_TEMPLATES) {
  if (!t.config) continue;
  const doc = 'plannedParents' in t.config
    ? buildBlocTrustDoc({ vaultName: 'Test', config: t.config })
    // recoveryEnabled is set the way the app sets it (recovery_after > 0,
    // VaultWizard / standardConfigFromCompiledVault); the preset configs
    // leave it out, which would send every one down the Gift Locker branch.
    : buildStandardTrustDoc({ vaultName: 'Test', config: { ...t.config, recoveryEnabled: (t.config.recoveryEnabled ?? t.config.recoveryAfter > 0) } });
  for (const s of strings(doc)) {
    assert.ok(!RESETTING.test(s), `trust document for "${t.id}" describes a fixed date as resetting: ${s.slice(0, 160)}`);
  }
  docs++;
}
assert.ok(docs >= 10, `expected the presets' trust documents, built ${docs}`);
pass(`${docs} generated trust documents never describe a fixed date as resetting`);

// 2. Sage: the fact sheet leads the prompt; the template digest is clean.
const src = readFileSync(new URL('../netlify/functions/assistant.js', import.meta.url), 'utf8');
assert.match(src, /return `\$\{FACT_SHEET\}/, 'the fact sheet must open the system prompt');
// The page paths Sage is told about must be exactly the ones the chat links.
const { SAGE_PAGES } = await import('../apps/web/src/lib/sage-text.ts');
const style = src.slice(src.indexOf('const REPLY_STYLE'), src.indexOf('function buildSystemPrompt'));
const told = [...new Set(style.match(/(?<![\w/])\/[a-z][a-z-]*(?![\w/-])/g))].sort();
assert.deepEqual(told, [...SAGE_PAGES].sort(), `Sage is told about ${told} but the chat links ${SAGE_PAGES}`);
assert.match(src, /\$\{FACT_SHEET\}\n\$\{REPLY_STYLE\}/, 'reply style must follow the fact sheet');
assert.match(src, /NOTHING moves it/, 'fact sheet must say a fixed date never moves');
assert.match(src, /everyday path \(spend right away\) CAN be forced/, 'fact sheet must say the everyday path can be forced');
assert.match(src, /call emergency services/, 'fact sheet must lead with emergency services');
const digest = src.slice(src.indexOf('const TEMPLATE_DIGEST'), src.indexOf('TIMELOCK RULE OF THUMB'));
assert.ok(digest.length > 1000, 'template digest not found');
assert.ok(!RESETTING.test(digest), `Sage's template digest describes a fixed date as resetting: ${(digest.match(RESETTING) || [''])[0]}`);
pass("Sage's prompt opens with the fact sheet; its template digest never says a fixed date resets");

console.log(`timelock-wording tests passed (${n} cases)`);
