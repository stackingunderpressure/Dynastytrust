/**
 * test-vault-addresses.mjs -- the v2 address-issuing function
 * (netlify/functions/vault-addresses.js), with the REAL compiler WebAssembly
 * and the database, sign-in and rate limit stood in.
 *
 * The database half (row locks, the lock on compiled vaults, the address
 * guard, rollback) is proven on a real Postgres by
 * scripts/ranged-migration-pg.sh; this proves the function around it:
 * who may ask, what is refused before anything is reserved, that the
 * address comes from the stored descriptors (the Core-checked vectors), and
 * that a failure never hands out an address that was not recorded.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-vault-addresses.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const shape = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(s => s.name === 'family');
// Signet and regtest addresses share the witness program; the vault here is
// signet, the vectors regtest, so the expected values are compared by script.
const { callWasm } = await import(F('_ranged-wasm.js'));

const OWNER = 'owner-1', MEMBER = 'member-1', STRANGER = 'stranger-1';
const V2 = { id: '33333333-3333-3333-3333-333333333333', user_id: OWNER, status: 'compiled', network: 'signet',
  descriptor_version: 2, descriptor_multipath: shape.multipath_descriptor, descriptor_receive: shape.receive_descriptor, descriptor_change: shape.change_descriptor };
V2.address = callWasm('/ranged-address', { multipath: V2.descriptor_multipath, receive: V2.descriptor_receive, change: V2.descriptor_change, network: 'signet', branch: 0, index: 0 }).body.address;

let state;
function reset(vault, opts = {}) {
  state = { vault, user: OWNER, next: opts.next ?? 0, inserted: [], reserved: 0, insertError: opts.insertError ?? null, rpcError: opts.rpcError ?? null };
}
const q = (table) => {
  const filters = {};
  const o = {
    select: () => o,
    eq: (k, v) => { filters[k] = v; return o; },
    maybeSingle: async () => {
      if (table === 'vaults') return { data: state.vault && filters.id === state.vault.id ? state.vault : null, error: null };
      if (table === 'vault_members') return { data: filters.user_id === MEMBER ? { id: 'm1' } : null, error: null };
      return { data: null, error: null };
    },
    insert: async (row) => {
      if (state.insertError) return { error: { message: state.insertError } };
      state.inserted.push(row);
      return { error: null };
    },
  };
  return o;
};
const supabase = {
  from: (t) => q(t),
  rpc: async (name, args) => {
    if (name === 'rate_hit') return { data: 1, error: null };
    if (name === 'reserve_vault_address_index') {
      if (state.rpcError) return { data: null, error: { message: state.rpcError } };
      assert.equal(args.p_branch, 0);
      state.reserved++;
      return { data: state.next++, error: null };
    }
    return { data: null, error: null };
  },
};
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => supabase } });
mock.module(F('_auth.js'), { namedExports: {
  requireUser: async () => (state.user ? { userId: state.user } : { error: 'Not signed in' }),
  json: (statusCode, body) => ({ statusCode, body }),
} });
const { handler } = await import(F('vault-addresses.js'));
const call = (body) => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
const scriptOf = (i) => callWasm('/ranged-address', { multipath: shape.multipath_descriptor, receive: shape.receive_descriptor, change: shape.change_descriptor, network: 'signet', branch: 0, index: i }).body.script_pubkey;

// 1. Issues the next receive address, from the stored descriptors.
reset(V2, { next: 3 });
let r = await call({ vault_id: V2.id, label: ' Donations ' });
assert.equal(r.statusCode, 200, JSON.stringify(r.body));
assert.equal(r.body.index, 3);
assert.equal(state.inserted.length, 1);
const row = state.inserted[0];
assert.equal(row.idx, 3); assert.equal(row.branch, 0); assert.equal(row.issued_by, OWNER); assert.equal(row.label, 'Donations');
assert.equal(row.address, r.body.address);
assert.equal(row.descriptor_checksum, shape.receive_descriptor.split('#')[1]);
assert.equal(row.script_pubkey, scriptOf(3));
pass('the owner gets receive index 3 from the stored descriptors, recorded with its checksum, label trimmed');

// The address itself matches Bitcoin Core's vector for receive/3 (regtest
// vs signet differ only in the prefix; compare the witness program).
const { bech32m } = await import('@scure/base');
const prog = (a) => Buffer.from(bech32m.fromWords(bech32m.decode(a, 120).words.slice(1))).toString('hex');
assert.equal(prog(r.body.address), prog(shape.receive[3]));
pass("and it is Bitcoin Core's receive/3 for this vault");

// 2. A member may ask; a stranger may not; nobody signed out.
reset(V2); state.user = MEMBER;
assert.equal((await call({ vault_id: V2.id })).statusCode, 200);
reset(V2); state.user = STRANGER;
r = await call({ vault_id: V2.id });
assert.equal(r.statusCode, 403); assert.equal(state.reserved, 0);
reset(V2); state.user = null;
assert.equal((await call({ vault_id: V2.id })).statusCode, 401);
pass('a member can ask; a stranger and a signed-out caller cannot, and nothing is reserved');

// 3. Refused before anything is reserved.
for (const [label, vault, code] of [
  ['a v1 vault (one fixed address)', { ...V2, descriptor_version: 1, descriptor_multipath: null }, 400],
  ['a draft', { ...V2, status: 'draft' }, 400],
  ['a vault whose stored descriptor does not rebuild its own address', { ...V2, address: 'tb1pnotthisvault' }, 500],
  ['a vault whose stored receive half is not the multipath one', { ...V2, descriptor_receive: shape.change_descriptor }, 500],
]) {
  reset(vault);
  r = await call({ vault_id: V2.id });
  assert.equal(r.statusCode, code, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(state.reserved, 0, `${label}: reserved an index`);
  assert.equal(state.inserted.length, 0);
}
reset(null);
assert.equal((await call({ vault_id: V2.id })).statusCode, 404);
assert.equal((await call({ vault_id: 'nope' })).statusCode, 400);
pass('v1, draft, a descriptor that does not rebuild the vault, a mismatched half, unknown vault: refused, nothing reserved');

// 4. A failure after reserving never returns an address.
reset(V2, { insertError: 'duplicate key value violates unique constraint' });
r = await call({ vault_id: V2.id });
assert.equal(r.statusCode, 500); assert.equal(r.body.address, undefined);
reset(V2, { rpcError: 'boom' });
r = await call({ vault_id: V2.id });
assert.equal(r.statusCode, 500); assert.equal(state.inserted.length, 0);
pass('if recording fails, or reserving fails, no address is handed out');

// 5. Consecutive calls get consecutive, different addresses.
reset(V2);
const got = [];
for (let i = 0; i < 5; i++) got.push((await call({ vault_id: V2.id })).body.address);
assert.equal(new Set(got).size, 5);
got.forEach((a, i) => assert.equal(prog(a), prog(shape.receive[i])));
pass("five calls: indexes 0-4, five different addresses, each Bitcoin Core's");

console.log(`vault-addresses tests passed (${n} cases)`);
