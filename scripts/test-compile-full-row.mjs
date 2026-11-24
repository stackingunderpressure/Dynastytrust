/**
 * test-compile-full-row.mjs -- a compiled path-builder vault comes back with
 * every column the vault page reads.
 *
 * VaultWizard's "Open vault" hands the compile answer to the vault page as
 * its starting state, and that state survives a reload. compile-leaves.js
 * once answered with a short column list (no founder/heir/backup key arrays)
 * and the page crashed right after the wizard, on every reload (live signet
 * walk, 2026-11-19: "TypeError: e is not iterable").
 *
 * Runs the REAL handler with the database, sign-in, compiler and chain tip
 * stood in, and checks the columns the save asks to have returned.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-compile-full-row.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
process.env.COMPILER_URL = 'https://compiler.invalid';
process.env.COMPILER_SECRET = 'test';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;

const { HDKey } = await import('@scure/bip32');
const hex = (b) => Buffer.from(b).toString('hex');
const PK = (n) => hex(HDKey.fromMasterSeed(new Uint8Array(32).fill(n)).derive("m/86'/1'/0'/0/0").publicKey);

const VAULT = {
  id: 'v1', user_id: 'u1', name: 'Family', network: 'signet', address_type: 'tr_multileaf', status: 'draft',
  leaves: [
    { id: 'primary', label: 'Founder', keys: [PK(1)], quorum: 1, unlock: { type: 'immediate' } },
    { id: 'path_1', label: 'Recovery', keys: [PK(2)], quorum: 1, unlock: { type: 'after', blocks: 52_560 } },
  ],
  consent_keys: [], consent_quorum: null,
};

let written = null, savedSelect = null;
const q = (table) => {
  const o = {
    select: (cols) => { if (written) savedSelect = cols; return o; },
    eq: () => o,
    maybeSingle: async () => ({ data: VAULT, error: null }),
    update: (row) => { written = row; return o; },
    single: async () => ({ data: { ...VAULT, ...written }, error: null }),
    then: (res) => res(table === 'vault_members' ? { data: [], error: null } : { data: null, error: null }),
  };
  return o;
};
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from: (t) => q(t) }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => ({ userId: 'u1', claims: { aal: 'aal2' } }), json: (statusCode, body) => ({ statusCode, body }) } });
mock.module(F('_finalize-guard.js'), { namedExports: { realBitcoinFinalizeProblem: async () => null } });
mock.module(F('_ledger.js'), { namedExports: { recordEvent: async () => {} } });
// The compiler here is a stand-in with made-up addresses, so the fresh-address
// step (real wasm, scripts/test-ranged-compile.mjs) answers "fixed" here.
mock.module(F('_ranged-compile.js'), { namedExports: { rangedFields: () => ({ fields: {}, addresses: 'fixed', reason: 'test' }) } });
const chain = await import(F('_chain.js'));
mock.module(F('_chain.js'), { namedExports: { ...chain, fetchVerifiedTipHeight: async () => 300_000 } });
mock.module(F('_compiler.js'), { namedExports: {
  compilerFailureReason: (e) => String(e),
  fetchCompiler: async (_url, _endpoint, payload) => {
    const leaf_scripts = Object.fromEntries(payload.leaves.map(l => [l.id, l.keys.map(k => String(k).slice(2)).join('')]));
    return new Response(JSON.stringify({ ok: true, address: 'tb1p-test', descriptor: 'tr(x)', miniscript_policy: 'p', leaf_scripts }), { status: 200 });
  },
} });

const { handler } = await import(F('compile-leaves.js'));
const { VAULT_FIELDS } = await import(F('_vault-fields.js'));
const r = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1' }) });
assert.equal(r.statusCode, 200, `compile refused: ${JSON.stringify(r.body)}`);
assert.equal(savedSelect, VAULT_FIELDS, 'compile-leaves returns a short vault row');
for (const col of ['founder_keys', 'heir_keys', 'backup_keys', 'second_heir_keys', 'leaves', 'key_origins']) {
  assert.ok(VAULT_FIELDS.split(',').map(s => s.trim()).includes(col), `VAULT_FIELDS is missing ${col}`);
}
console.log('  [ok] a compiled path-builder vault comes back with the full vault row');
console.log('compile-full-row tests passed (1 cases)');
