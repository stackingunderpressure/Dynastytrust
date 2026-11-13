/**
 * test-attestation-key.mjs -- the attestation endpoint
 * (netlify/functions/vault-attestations.js) against the REAL browser
 * signer (apps/web/src/lib/attest.ts). Only the database and sign-in are
 * stand-ins. Wired into `npm test`.
 *
 * Why it exists: from 2026-08-21 to 2026-11-13 the endpoint compared the
 * signer's x-only key (64 hex) with the member's stored compressed key
 * (66 hex) as text, so every I'm alive / trust-doc / death-declaration by
 * every member was refused -- found from the operator's phone screenshot.
 * The refusals that matter must still hold.
 *
 * Run:  node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/register-ts-resolver.mjs scripts/test-attestation-key.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const ks = await import('../apps/web/src/lib/keystore.ts');
const at = await import('../apps/web/src/lib/attest.ts');
const dad = ks.generateTestKey({ label: 'Dad', network: 'signet', persona: 'Dad' });
const mallory = ks.generateTestKey({ label: 'M', network: 'signet', persona: 'M' });
const members = [
  { vault_id: 'v1', user_id: 'u-dad', status: 'active', pubkey: dad.key.pubkey },
  { vault_id: 'v1', user_id: 'u-nokey', status: 'active', pubkey: null },
];
const inserted = [];
let who = 'u-dad';
const from = (t) => { const f = []; let payload; const q = {
  select: () => q, insert: (r) => { payload = r; return q; }, eq: (k, v) => { f.push(r => r[k] === v); return q; }, order: () => q, limit: () => q,
  maybeSingle: async () => ({ data: (t === 'vault_members' ? members : []).find(r => f.every(x => x(r))) ?? null, error: null }),
  single: async () => { inserted.push(payload); return { data: payload, error: null }; } }; return q; };
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => ({ userId: who }), json: (statusCode, body) => ({ statusCode, body }) } });
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from }) } });
mock.module(F('_ledger.js'), { namedExports: { recordEvent: async () => ({ error: null }) } });
const { handler, xOnlyHex } = await import(F('vault-attestations.js'));

let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const H = 'cd'.repeat(32);
const sign = (k, type = 'proof_of_life') => at.signAttestation({ mnemonic: k.mnemonic, derivationPath: k.key.derivationPath, network: 'testnet', attestationType: type, targetHash: H });
const post = (s, extra = {}) => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1', attestation_type: 'proof_of_life', target_hash: H, signature: s.signature, pubkey: s.pubkey, ...extra }) });

assert.equal(dad.key.pubkey.length, 66);
assert.equal(xOnlyHex(dad.key.pubkey), sign(dad).pubkey, 'stored compressed key and signer key are the same key');

for (const type of ['proof_of_life', 'trust_doc', 'death_declaration']) {
  const r = await post(sign(dad, type), { attestation_type: type });
  assert.equal(r.statusCode, 201, `${type}: ${JSON.stringify(r.body)}`);
}
assert.equal(inserted.length, 3);
pass("a member's own key is accepted: I'm alive, trust doc, death declaration");

const other = await post(sign(mallory));
assert.equal(other.statusCode, 403);
assert.match(other.body.error, /does not match your registered/);
pass('another real key, correctly signed, is still refused');

const good = sign(dad);
const bad = await post({ ...good, signature: good.signature.replace(/^./, c => (c === '0' ? '1' : '0')) });
assert.equal(bad.statusCode, 400);
assert.match(bad.body.error, /does not verify/);
pass('the right key with a broken signature is refused');

who = 'u-nokey';
const none = await post(sign(dad));
assert.equal(none.statusCode, 403);
assert.match(none.body.error, /no registered signing key/);
pass('a member with no key yet is refused');
assert.equal(inserted.length, 3, 'no refused attestation may be stored');

console.log(`attestation-key tests passed (${n} cases)`);
