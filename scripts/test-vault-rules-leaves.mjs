/**
 * test-vault-rules-leaves.mjs -- the path-builder ("leaves") vault's compile
 * rules, as compile-leaves.js applies them (download slice: one copy shared
 * by the website's server and the downloaded app,
 * docs/download-and-run-build-note.md).
 *
 * Runs the REAL compile-leaves.js handler over a fixed set of cases with the
 * database, account checks, compiler and chain tip stood in, and records what
 * it does: the status and body it answers, the exact request it sends the
 * compiler, and the exact update it writes to the vault row.
 *
 *   RECORD=1  write scripts/fixtures/vault-rules-leaves.json (done ONCE,
 *             against the code BEFORE the rules moved into packages/)
 *   (default) replay and require identical behaviour.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-vault-rules-leaves.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
process.env.COMPILER_URL = 'https://compiler.invalid';
process.env.COMPILER_SECRET = 'test';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const FIXTURE = new URL('./fixtures/vault-rules-leaves.json', import.meta.url);

const { HDKey } = await import('@scure/bip32');
const hex = (b) => Buffer.from(b).toString('hex');
const node = (n) => HDKey.fromMasterSeed(new Uint8Array(32).fill(n), { private: 0x04358394, public: 0x043587cf }).derive("m/86'/1'/0'");
const PK = (n) => hex(node(n).deriveChild(0).deriveChild(0).publicKey);
const XPRV = node(9).privateExtendedKey;

const leaf = (o) => ({ label: o.id, ...o });
const EVERYDAY = leaf({ id: 'everyday', keys: [PK(1), PK(2), PK(3)], quorum: 2, unlock: { type: 'immediate' } });
const KIDS = leaf({ id: 'kids', keys: [PK(4), PK(5)], quorum: 1, unlock: { type: 'after', blocks: 52_560 } });
const BASE = { id: 'v1', user_id: 'u1', name: 'Family', network: 'signet', address_type: 'tr_multileaf', status: 'draft', leaves: [EVERYDAY, KIDS], consent_keys: [], consent_quorum: null };
const ORIGINS = [
  { pubkey: PK(1), fingerprint: '00000001', derivation_path: "m/86'/1'/0'/0/0" },
  { pubkey: PK(2), fingerprint: 2, derivation_path: "m/86'/1'/0'/0/0" },
  null,
  { pubkey: PK(3), fingerprint: '00000003' },
];

const CASES = [
  { label: 'everyday 2 of 3 plus kids after a date', vault: {} },
  { label: 'with key origins (junk entries dropped)', vault: {}, body: { key_origins: ORIGINS } },
  { label: 'a self-refreshing (older) path is forwarded unchanged', vault: { leaves: [EVERYDAY, KIDS, leaf({ id: 'quiet', keys: [PK(1), PK(2), PK(3)], quorum: 1, unlock: { type: 'older', blocks: 52_000 } })] } },
  { label: 'must-sign key honoured by the compiler', vault: { leaves: [{ ...EVERYDAY, required_keys: [PK(6)] }, KIDS] } },
  { label: 'must-sign key dropped by the compiler: refused, nothing saved', vault: { name: 'drop-must-sign', leaves: [{ ...EVERYDAY, required_keys: [PK(6)] }, KIDS] } },
  { label: 'must-sign key also among the keys', vault: { leaves: [{ ...EVERYDAY, required_keys: [PK(1)] }, KIDS] } },
  { label: 'must-sign key not readable', vault: { leaves: [{ ...EVERYDAY, required_keys: ['nope'] }, KIDS] } },
  { label: 'consent keys and quorum', vault: { consent_keys: [PK(7)], consent_quorum: 1 } },
  { label: 'private key among the consent keys', vault: { consent_keys: [XPRV], consent_quorum: 1 } },
  { label: 'private key among a path\'s keys', vault: { leaves: [{ ...EVERYDAY, keys: [PK(1), XPRV, PK(3)] }, KIDS] } },
  { label: 'quorum 0', vault: { leaves: [{ ...EVERYDAY, quorum: 0 }, KIDS] } },
  { label: 'quorum above the key count', vault: { leaves: [{ ...EVERYDAY, quorum: 4 }, KIDS] } },
  { label: 'quorum not a whole number', vault: { leaves: [{ ...EVERYDAY, quorum: 1.5 }, KIDS] } },
  { label: 'a path with no id', vault: { leaves: [{ ...EVERYDAY, id: '' }, KIDS] } },
  { label: 'a path with no keys', vault: { leaves: [EVERYDAY, { ...KIDS, keys: [] }] } },
  { label: 'date below the floor', vault: { leaves: [EVERYDAY, { ...KIDS, unlock: { type: 'after', blocks: 1000 } }] } },
  { label: 'date above the ceiling', vault: { leaves: [EVERYDAY, { ...KIDS, unlock: { type: 'after', blocks: 9_000_000 } }] } },
  { label: 'immediate only: no tip needed', vault: { leaves: [EVERYDAY] } },
  { label: 'no paths at all', vault: { leaves: [] } },
  { label: 'not a draft', vault: { status: 'compiled' } },
  { label: 'decay carried through', vault: { leaves: [EVERYDAY, { ...KIDS, decay: { step_blocks: 26_280, floor_quorum: 1 } }] } },
];

// Stand-ins. The compiler answers deterministically from what it was sent,
// so the recording captures the request without needing a real compiler.
let current, sentToCompiler, written, tipCalls;
const q = (table) => {
  const o = {
    select: () => o, eq: () => o,
    maybeSingle: async () => ({ data: current.vault, error: null }),
    update: (row) => { written = row; return o; },
    single: async () => ({ data: { ...current.vault, ...written }, error: null }),
    // vault_members: none (the owner holds every key).
    then: (res) => res(table === 'vault_members' ? { data: [], error: null } : { data: null, error: null }),
  };
  return o;
};
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from: (t) => q(t) }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => ({ userId: 'u1', claims: { aal: 'aal2' } }), json: (statusCode, body) => ({ statusCode, body }) } });
mock.module(F('_finalize-guard.js'), { namedExports: { realBitcoinFinalizeProblem: async () => null } });
mock.module(F('_ledger.js'), { namedExports: { recordEvent: async () => {} } });
const chain = await import(F('_chain.js'));
mock.module(F('_chain.js'), { namedExports: { ...chain, fetchVerifiedTipHeight: async () => { tipCalls++; return 250_000; } } });
mock.module(F('_compiler.js'), { namedExports: {
  compilerFailureReason: (e) => String(e),
  fetchCompiler: async (_url, endpoint, payload) => {
    sentToCompiler = { endpoint, payload };
    // Each path's "script" carries its keys, and its must-sign keys unless
    // this case plays an old compiler that ignores them.
    const drop = payload.name === 'drop-must-sign';
    const leaf_scripts = Object.fromEntries(payload.leaves.map(l => [l.id,
      [...l.keys, ...(drop ? [] : l.required_keys ?? [])].map(k => String(k).slice(2)).join('')]));
    const body = { ok: true, address: 'tb1p-test-' + payload.leaves.length, descriptor: 'tr(' + payload.leaves.map(l => l.id).join(',') + ')', miniscript_policy: 'policy', leaf_scripts };
    return new Response(JSON.stringify(body), { status: 200 });
  },
} });
const { handler } = await import(F('compile-leaves.js'));

const results = [];
for (const c of CASES) {
  current = { vault: { ...BASE, ...c.vault } };
  sentToCompiler = null; written = null; tipCalls = 0;
  const r = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1', ...(c.body ?? {}) }) });
  results.push({ label: c.label, status: r.statusCode, body: r.body, sentToCompiler, written, tipCalls });
}

if (process.env.RECORD) {
  writeFileSync(FIXTURE, JSON.stringify(results, null, 1) + '\n');
  const ok = results.filter(r => r.status === 200).length;
  console.log(`recorded ${results.length} cases (${ok} compiled, ${results.length - ok} refused)`);
} else {
  const before = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(results.length, before.length);
  for (let i = 0; i < results.length; i++) assert.deepEqual(results[i], before[i], `case "${before[i].label}" behaves differently`);
  const ok = results.filter(r => r.status === 200).length;
  console.log(`  [ok] ${results.length} cases identical to the recording (${ok} compiled, ${results.length - ok} refused)`);
  console.log('vault-rules-leaves tests passed (1 cases)');
}
