/**
 * test-vault-rules-standard.mjs -- the standard vault's compile rules, as
 * vaults-compile.js applies them (download slice: one copy shared by the
 * website's server and the downloaded app, docs/download-and-run-build-note.md).
 *
 * Runs the REAL vaults-compile.js handler over a fixed set of cases with the
 * database, account checks, compiler and chain tip stood in, and records what
 * it does: the status and body it answers, the exact request it sends the
 * compiler, and the exact update it writes to the vault row.
 *
 *   RECORD=1  write scripts/fixtures/vault-rules-standard.json (done ONCE,
 *             against the code BEFORE the rules moved into packages/)
 *   (default) replay and require identical behaviour.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-vault-rules-standard.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
process.env.COMPILER_URL = 'https://compiler.invalid';
process.env.COMPILER_SECRET = 'test';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const FIXTURE = new URL('./fixtures/vault-rules-standard.json', import.meta.url);

const { HDKey } = await import('@scure/bip32');
const hex = (b) => Buffer.from(b).toString('hex');
// Deterministic test keys: an account xpub at m/48'/1'/0'/2' per seed byte.
const acct = (n) => HDKey.fromMasterSeed(new Uint8Array(32).fill(n), { private: 0x04358394, public: 0x043587cf }).derive("m/48'/1'/0'/2'");
const fp = (n) => n.toString(16).padStart(8, '0');
// An xpub key with its origin, as the builder sends it.
const XK = (n) => {
  const a = acct(n);
  return { xpub: a.publicExtendedKey, fingerprint: fp(n), derivation_path: "m/48'/1'/0'/2'", pubkey: hex(a.deriveChild(0).deriveChild(0).publicKey) };
};
// A Tapit-style key: bare compressed pubkey, no xpub.
const TK = (n) => ({ pubkey: hex(acct(n + 100).deriveChild(0).deriveChild(0).publicKey) });

const BASE = {
  id: 'v1', user_id: 'u1', name: 'Family', network: 'signet', address_type: 'tr_multileaf', status: 'draft',
  founder_quorum: 2, heir_quorum: 1, recovery_quorum: null, recovery_after: 26280, inheritance_after: 52560,
  consent_quorum: null, backup_quorum: null, second_heir_quorum: null, second_inheritance_after: null,
  planned_founder_count: 3, planned_heir_count: 1,
};
const CASES = [
  { label: 'xpub founders, one heir', vault: {}, keys: { founder_keys: [XK(1), XK(2), XK(3)], heir_keys: [XK(4)] } },
  { label: 'a Tapit key among founders', vault: {}, keys: { founder_keys: [XK(1), TK(2), XK(3)], heir_keys: [TK(4)] } },
  { label: 'duplicate founder key', vault: {}, keys: { founder_keys: [XK(1), XK(1), XK(3)], heir_keys: [XK(4)] } },
  { label: 'too few founders', vault: {}, keys: { founder_keys: [XK(1), XK(2)], heir_keys: [XK(4)] } },
  { label: 'xpub missing its origin is not provisioned', vault: {}, keys: { founder_keys: [XK(1), { ...XK(2), fingerprint: '' }, XK(3)], heir_keys: [XK(4)] } },
  { label: 'backup instead of recovery', vault: { recovery_after: 0, backup_quorum: 1 }, keys: { founder_keys: [XK(1), XK(2), XK(3)], heir_keys: [XK(4)], backup_keys: [XK(5)] } },
  { label: 'second inheritance', vault: { second_heir_quorum: 1, second_inheritance_after: 105120 }, keys: { founder_keys: [XK(1), XK(2), XK(3)], heir_keys: [XK(4)], second_heir_keys: [XK(6)] } },
  { label: 'consent keys', vault: { consent_quorum: 1 }, keys: { founder_keys: [XK(1), XK(2), XK(3)], heir_keys: [XK(4)], consent_keys: [XK(7)] } },
  { label: 'recovery below the floor', vault: { recovery_after: 1000 }, keys: { founder_keys: [XK(1), XK(2), XK(3)], heir_keys: [XK(4)] } },
  { label: 'inheritance above the ceiling', vault: { inheritance_after: 9_000_000 }, keys: { founder_keys: [XK(1), XK(2), XK(3)], heir_keys: [XK(4)] } },
  { label: 'no timelocks at all', vault: { recovery_after: 0, inheritance_after: 0, planned_heir_count: 0, heir_quorum: 0 }, keys: { founder_keys: [XK(1), XK(2), XK(3)], heir_keys: [] } },
  { label: 'not a draft', vault: { status: 'compiled' }, keys: { founder_keys: [XK(1), XK(2), XK(3)], heir_keys: [XK(4)] } },
  { label: 'second heirs without primary heirs are ignored', vault: { planned_heir_count: 0, heir_quorum: 0, inheritance_after: 0, second_heir_quorum: 1, second_inheritance_after: 105120 }, keys: { founder_keys: [XK(1), XK(2), XK(3)], heir_keys: [], second_heir_keys: [XK(6)] } },
];

// Stand-ins. The compiler answers deterministically from what it was sent,
// so the recording captures the request without needing a real compiler.
let current, sentToCompiler, written, tipCalls;
const q = () => {
  const o = {
    select: () => o, eq: () => o,
    maybeSingle: async () => ({ data: current.vault, error: null }),
    update: (row) => { written = row; return o; },
    single: async () => ({ data: { ...current.vault, ...written }, error: null }),
  };
  return o;
};
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from: () => q() }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => ({ userId: 'u1', claims: { aal: 'aal2' } }), json: (statusCode, body) => ({ statusCode, body }) } });
mock.module(F('_finalize-guard.js'), { namedExports: { realBitcoinFinalizeProblem: async () => null } });
mock.module(F('_ledger.js'), { namedExports: { recordEvent: async () => {} } });
const chain = await import(F('_chain.js'));
mock.module(F('_chain.js'), { namedExports: { ...chain, fetchVerifiedTipHeight: async () => { tipCalls++; return 250_000; } } });
mock.module(F('_compiler.js'), { namedExports: {
  compilerFailureReason: (e) => String(e),
  fetchCompiler: async (_url, endpoint, payload) => {
    sentToCompiler = { endpoint, payload };
    const pk = [...(payload.founder_keys || []), ...(payload.heir_keys || [])];
    const body = { ok: true, address: 'tb1p-test-' + pk.length, descriptor: 'tr(' + pk.join(',') + ')', miniscript_policy: 'policy', leaf_scripts: { founders_now: 'aa' } };
    return new Response(JSON.stringify(body), { status: 200 });
  },
} });
const { handler } = await import(F('vaults-compile.js'));

const results = [];
for (const c of CASES) {
  current = { vault: { ...BASE, ...c.vault } };
  sentToCompiler = null; written = null; tipCalls = 0;
  const r = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1', direct_keys: c.keys }) });
  results.push({ label: c.label, status: r.statusCode, body: r.body, sentToCompiler, written, tipCalls });
}

if (process.env.RECORD) {
  writeFileSync(FIXTURE, JSON.stringify(results, null, 1) + '\n');
  console.log(`recorded ${results.length} cases`);
} else {
  const before = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(results.length, before.length);
  for (let i = 0; i < results.length; i++) assert.deepEqual(results[i], before[i], `case "${before[i].label}" behaves differently`);
  const ok = results.filter(r => r.status === 200).length;
  console.log(`  [ok] ${results.length} cases identical to the recording (${ok} compiled, ${results.length - ok} refused)`);
  console.log('vault-rules-standard tests passed (1 cases)');
}
