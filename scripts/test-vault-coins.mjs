/**
 * test-vault-coins.mjs -- finding a vault's coins across all its addresses
 * (ranged slice 4: netlify/functions/_vault-coins.js, balance.js vault mode,
 * utxos.js), with the REAL compiler WebAssembly and the Core-checked vectors.
 * The chain (mempool.space) and the database are stood in.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-vault-coins.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const { bech32m } = await import('@scure/base');
const prog = (a) => Buffer.from(bech32m.fromWords(bech32m.decode(a, 120).words.slice(1))).toString('hex');

const shape = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(s => s.name === 'family');
const { callWasm } = await import(F('_ranged-wasm.js'));
const V2 = { id: '44444444-4444-4444-4444-444444444444', user_id: 'owner-1', status: 'compiled', network: 'signet',
  descriptor_version: 2, descriptor_multipath: shape.multipath_descriptor, descriptor_receive: shape.receive_descriptor, descriptor_change: shape.change_descriptor };
V2.address = callWasm('/ranged-address', { multipath: V2.descriptor_multipath, receive: V2.descriptor_receive, change: V2.descriptor_change, network: 'signet', branch: 0, index: 0 }).body.address;
const V1 = { id: '55555555-5555-5555-5555-555555555555', user_id: 'owner-1', status: 'compiled', network: 'signet', address: 'tb1pfixedaddressxxxxxxxx', descriptor_version: null };

// Chain stand-in: coins keyed by address.
let chain = {}, fetched = [];
const fakeFetch = async (url) => {
  fetched.push(url);
  if (url.endsWith('/blocks/tip/height')) return 1000;
  const m = url.match(/\/address\/([^/]+)\/utxo$/);
  return m ? (chain[m[1]] ?? []) : [];
};
mock.module(F('_chain.js'), { namedExports: { MEMPOOL: { signet: 'https://mempool.space/signet/api', testnet: 'https://mempool.space/testnet/api' }, mempoolFetch: fakeFetch } });

let db;
const q = (table) => {
  const f = {};
  const o = {
    select: () => o,
    eq: (k, v) => { f[k] = v; return o; },
    maybeSingle: async () => {
      if (table === 'vaults') return { data: db.vaults.find(v => v.id === f.id) ?? null, error: null };
      if (table === 'vault_members') return { data: db.members.includes(f.user_id) ? { id: 'm' } : null, error: null };
      return { data: null, error: null };
    },
    then: (res) => res(table === 'vault_address_branches'
      ? { data: Object.entries(db.next).map(([branch, next_index]) => ({ branch: Number(branch), next_index })), error: null }
      : { data: [], error: null }),
  };
  return o;
};
let user = 'owner-1';
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from: q }) } });
mock.module(F('_auth.js'), { namedExports: {
  requireUser: async () => (user ? { userId: user } : { error: 'Not signed in' }),
  json: (statusCode, body) => ({ statusCode, body }),
} });

const { watchedAddresses, LOOK_AHEAD } = await import(F('_vault-coins.js'));

// 1. v1: its one address.
assert.deepEqual(watchedAddresses(V1), [{ branch: 0, index: 0, address: V1.address }]);
pass('a one-address vault watches only that address');

// 2. v2, nothing issued: receive 0..10, change 0..4 -- Bitcoin Core's.
let w = watchedAddresses(V2, { 0: 0, 1: 0 });
const rec = w.filter(a => a.branch === 0), chg = w.filter(a => a.branch === 1);
assert.equal(rec.length, 1 + LOOK_AHEAD[0]); assert.equal(chg.length, 1 + LOOK_AHEAD[1]);
rec.slice(0, 10).forEach((a, i) => assert.equal(prog(a.address), prog(shape.receive[i])));
chg.forEach((a, i) => assert.equal(prog(a.address), prog(shape.change[i])));
pass("a fresh vault watches receive 0-10 and change 0-5, each Bitcoin Core's");

// 3. Watches every reserved index plus the look-ahead.
w = watchedAddresses(V2, { 0: 30, 1: 7 });
assert.equal(w.filter(a => a.branch === 0).length, 30 + LOOK_AHEAD[0]);
assert.equal(w.filter(a => a.branch === 1).length, 7 + LOOK_AHEAD[1]);
pass('every reserved index is watched, plus the look-ahead');

// 4. A stored descriptor that does not rebuild this vault: nothing watched.
assert.throws(() => watchedAddresses({ ...V2, address: 'tb1psomeotheraddress' }), /does not match/);
assert.throws(() => watchedAddresses(V2, undefined, () => ({ status: 400, body: { error: 'bad' } })), /bad/);
pass('a mismatched or refused descriptor watches nothing (throws)');

// 5. Balance by vault: sums every address, owner or member only.
const { handler: balance } = await import(F('balance.js'));
const coin = (value, confirmed) => ({ txid: 'a'.repeat(64), vout: 0, value, status: { confirmed, block_height: confirmed ? 990 : undefined } });
const r3 = rec[3].address, c1 = chg[1].address;
chain = { [V2.address]: [coin(1000, true)], [r3]: [coin(2000, true), coin(500, false)], [c1]: [coin(300, true)] };
db = { vaults: [V2, V1], members: ['member-1'], next: { 0: 4, 1: 2 } };
const get = (qs) => balance({ httpMethod: 'GET', headers: {}, queryStringParameters: qs });
let r = await get({ vault_id: V2.id });
assert.equal(r.statusCode, 200, JSON.stringify(r.body));
assert.equal(r.body.confirmed_sats, 3300); assert.equal(r.body.unconfirmed_sats, 500); assert.equal(r.body.total_sats, 3800);
assert.equal(r.body.utxo_count, 4); assert.equal(r.body.address, V2.address);
assert.equal(r.body.addresses_watched, 4 + LOOK_AHEAD[0] + 2 + LOOK_AHEAD[1]);
pass('the vault balance adds up coins on receive 0, receive 3 and change 1');

user = 'member-1'; assert.equal((await get({ vault_id: V2.id })).statusCode, 200);
user = 'stranger'; fetched = [];
r = await get({ vault_id: V2.id }); assert.equal(r.statusCode, 404); assert.equal(fetched.length, 0);
user = null; assert.equal((await get({ vault_id: V2.id })).statusCode, 401);
user = 'owner-1';
pass('a member may see it; a stranger gets "not found" and nothing is looked up; signed out is refused');

// 6. The old by-address mode is unchanged and needs no sign-in.
user = null; fetched = [];
r = await balance({ httpMethod: 'GET', headers: {}, queryStringParameters: { address: V2.address, network: 'signet' } });
assert.equal(fetched.filter(u => u.includes('/address/')).length, 2); user = 'owner-1';
pass('balance by one address still works as before');

// 7. The coin list: every coin, tagged with its branch and index.
const { handler: utxos } = await import(F('utxos.js'));
user = 'member-1';
r = await utxos({ httpMethod: 'GET', headers: {}, queryStringParameters: { vault_id: V2.id } });
assert.equal(r.statusCode, 200, JSON.stringify(r.body));
assert.equal(r.body.utxos.length, 4);
const at = (b, i) => r.body.utxos.filter(u => u.branch === b && u.index === i).length;
assert.equal(at(0, 0), 1); assert.equal(at(0, 3), 2); assert.equal(at(1, 1), 1);
assert.ok(r.body.utxos.every(u => typeof u.address === 'string'));
pass('the coin list holds every coin, each saying which address it sits on');

// 8. A one-address vault's coin list is as before.
chain = { [V1.address]: [coin(700, true)] };
r = await utxos({ httpMethod: 'GET', headers: {}, queryStringParameters: { vault_id: V1.id } });
assert.equal(r.body.utxos.length, 1); assert.equal(r.body.utxos[0].index, 0); assert.equal(r.body.utxos[0].value_sats, 700);
pass('a one-address vault lists its coins as before');

console.log(`vault-coins tests passed (${n} cases)`);
