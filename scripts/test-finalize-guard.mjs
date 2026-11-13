/**
 * test-finalize-guard.mjs -- threat model item C: a stolen password alone
 * cannot FINISH a real-bitcoin vault. Every place a vault becomes finished
 * (compile.js save, vaults.js non-draft create, vaults-compile,
 * vaults-compile-bloc, compile-leaves) is called for real with a
 * password-only session on a real-bitcoin vault and must refuse BEFORE the
 * compiler is ever asked; two-step (aal2) or a recorded key session (Tapit)
 * passes the guard; test coins are never stopped by it. Wired into npm test.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-finalize-guard.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const OWNER = 'u-owner', SID = '11111111-2222-3333-4444-555555555555';
let claims = { sub: OWNER, aal: 'aal1', session_id: SID };
let keySessions = [];
let compilerCalls = 0;
const draft = (network, extra = {}) => ({ id: 'v1', user_id: OWNER, name: 'V', network, address_type: 'tr_multileaf', status: 'draft', leaves: [], bloc_policy: {}, ...extra });
let vaultRow = draft('bitcoin');
const from = (t) => { const q = { select: () => q, eq: () => q, neq: () => q, is: () => q, in: () => q, order: () => q, limit: () => q,
  maybeSingle: async () => ({ data: t === 'vaults' ? vaultRow : t === 'key_sessions' ? (keySessions.find(k => k.session_id === SID) ?? null) : null, error: null }),
  single: async () => ({ data: null, error: { message: 'stop here' } }), insert: () => q, update: () => q,
  then: (res) => res({ data: [], error: null }) }; return q; };
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => ({ userId: OWNER, claims }), json: (statusCode, body) => ({ statusCode, body }) } });
mock.module(F('_compiler.js'), { namedExports: { compilerFailureReason: String, fetchCompiler: async () => { compilerCalls++; throw new Error('compiler reached'); } } });
const realChain = await import(F('_chain.js'));
mock.module(F('_chain.js'), { namedExports: { ...realChain, fetchVerifiedTipHeight: async () => { compilerCalls++; throw new Error('tip reached'); } } });
process.env.COMPILER_URL = 'http://compiler.invalid';
const H = {};
for (const f of ['compile', 'vaults', 'vaults-compile', 'vaults-compile-bloc', 'compile-leaves']) H[f] = (await import(F(f + '.js'))).handler;
const { realBitcoinFinalizeProblem } = await import(F('_finalize-guard.js'));
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const calls = {
  'compile.js (save)': () => H.compile({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ network: vaultRow.network, founder_keys: ['02' + 'a'.repeat(64)], founder_quorum: 1, save: true }) }),
  'vaults.js (bloc create)': () => H.vaults({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ mode: 'bloc', network: vaultRow.network, address: 'x', descriptor: 'x', miniscript_policy: 'x', bloc_policy: {} }) }),
  'vaults.js (legacy compiled create)': () => H.vaults({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ network: vaultRow.network, address: 'x', descriptor: 'x', miniscript_policy: 'x' }) }),
  'vaults-compile.js': () => H['vaults-compile']({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1' }), queryStringParameters: { id: 'v1', vault_id: 'v1' } }),
  'vaults-compile-bloc.js': () => H['vaults-compile-bloc']({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1', parent_keys: ['02' + 'a'.repeat(64)], kid_keys: ['02' + 'b'.repeat(64)] }), queryStringParameters: { id: 'v1', vault_id: 'v1' } }),
  'compile-leaves.js': () => H['compile-leaves']({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1' }), queryStringParameters: { id: 'v1', vault_id: 'v1' } }),
};

// 1. Real bitcoin, password-only session: refused everywhere, compiler never asked.
vaultRow = draft('bitcoin'); claims = { sub: OWNER, aal: 'aal1', session_id: SID }; keySessions = [];
for (const [name, call] of Object.entries(calls)) {
  compilerCalls = 0;
  const r = await call();
  assert.equal(r.statusCode, 403, `${name}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.needs_two_step, true, name);
  assert.equal(compilerCalls, 0, `${name}: the compiler was asked before the guard`);
}
pass('real bitcoin + password-only session: all six finishing paths refuse before compiling');

// 2. Two-step, or a recorded key session of THIS account, passes the guard;
//    a key-session record for another account does not.
const db = { from };
assert.equal(await realBitcoinFinalizeProblem(db, { sub: OWNER, aal: 'aal2', session_id: SID }, 'bitcoin'), null);
keySessions = [{ session_id: SID, user_id: OWNER }];
assert.equal(await realBitcoinFinalizeProblem(db, { sub: OWNER, aal: 'aal1', session_id: SID }, 'bitcoin'), null);
keySessions = [{ session_id: SID, user_id: 'someone-else' }];
assert.notEqual(await realBitcoinFinalizeProblem(db, { sub: OWNER, aal: 'aal1', session_id: SID }, 'bitcoin'), null);
keySessions = [];
for (const [name, call] of Object.entries(calls)) {
  claims = { sub: OWNER, aal: 'aal2', session_id: SID };
  const r = await call();
  assert.ok(!(r.statusCode === 403 && r.body?.needs_two_step), `${name}: two-step must pass the guard`);
}
pass('two-step or a recorded Tapit session of this account passes; another account\'s record does not');

// 3. Test coins: never stopped by the guard.
vaultRow = draft('signet'); claims = { sub: OWNER, aal: 'aal1', session_id: SID };
for (const [name, call] of Object.entries(calls)) {
  const r = await call();
  assert.ok(!(r.statusCode === 403 && r.body?.needs_two_step), `${name}: test coins must not be stopped`);
}
pass('test-coin vaults are never stopped by it');

console.log(`finalize-guard tests passed (${n} cases)`);
