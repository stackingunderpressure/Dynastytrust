// A duress hold must stop EVERY way this app moves a spend forward, not only
// the Send screen (blind review 2026-11-25, finding 1:
// docs/audits/2026-11-25-blind-review-new-code.md). Two parts:
//   1. the shared guard refuses while vaults.duress is true, and only then;
//   2. every server function that builds, records, merges or files a spend
//      calls it, and the request page checks the hold before signing or
//      broadcasting -- so a new path cannot quietly skip it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const { refuseIfHeld } = await import('../netlify/functions/_duress-guard.js');
const fake = (row, error = null) => ({ from: () => { const o = { select: () => o, eq: () => o, maybeSingle: async () => ({ data: row, error }) }; return o; } });

let n = 0;
const ok = (l) => { n++; console.log(`  [ok] ${l}`); };

const held = await refuseIfHeld(fake({ duress: true }), 'v1');
assert.equal(held?.statusCode, 409);
assert.match(JSON.parse(held.body).error, /halted/i);
ok('a held vault is refused with 409');
assert.equal(await refuseIfHeld(fake({ duress: false }), 'v1'), null);
ok('a vault not on hold passes');
const unknown = await refuseIfHeld(fake(null, { message: 'db down' }), 'v1');
assert.equal(unknown?.statusCode, 503);
ok('if the hold cannot be read, it fails closed (503), never open');

for (const f of ['signer-sessions.js', 'psbt-binary.js', 'psbt-merge.js', 'proposals.js']) {
  const src = readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8');
  assert.match(src, /refuseIfHeld\(/, `${f} does not check the duress hold`);
}
ok('signer-sessions, psbt-binary, psbt-merge and proposals all check the hold');
const page = readFileSync(new URL('../apps/web/src/pages/ProposalDetail.tsx', import.meta.url), 'utf8');
assert.match(page, /vault\.duress/, 'the request page never reads the hold');
assert.match(page, /if \(vault\??\.duress\)[^\n]*return/, 'the request page does not stop on the hold');
ok('the request page reads the hold and stops signing and broadcasting on it');

console.log(`duress-guard tests passed (${n} cases)`);
