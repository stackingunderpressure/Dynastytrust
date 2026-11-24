/**
 * test-ranged-spend.mjs -- spending a vault with a new address every time
 * (ranged slice 5: netlify/functions/_ranged-spend.js) with the REAL
 * compiler WebAssembly. The vault is the "untouched" vector shape (an
 * everyday path, an "if left untouched" path of 52,560 blocks, and a dated
 * heirs path); its path scripts come from compiling that same policy through
 * the wasm, never written by hand. Chain and database are stood in.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-ranged-spend.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const { callWasm } = await import(F('_ranged-wasm.js'));
const { buildRangedSpend, oldEnough } = await import(F('_ranged-spend.js'));
const { watchedAddresses } = await import(F('_vault-coins.js'));
const { parsePsbt, toHex } = await import('../packages/bip341-psbt-signer/dist/index.js');

const shape = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(s => s.name === 'untouched');
const compiled = callWasm('/compile-leaves', { network: 'signet', leaves: shape.policy.leaves }).body;
assert.ok(compiled.ok, JSON.stringify(compiled));
const V = {
  id: '66666666-6666-6666-6666-666666666666', name: 'Test', status: 'compiled', network: 'signet',
  address: compiled.address, leaf_scripts: compiled.leaf_scripts,
  leaves: shape.policy.leaves.map(l => ({ id: l.id, unlock: l.unlock })),
  descriptor_version: 2, descriptor_multipath: shape.multipath_descriptor, descriptor_receive: shape.receive_descriptor, descriptor_change: shape.change_descriptor,
};
const watched = watchedAddresses(V, { 0: 5, 1: 3 });
pass('the compiled vault\'s address is receive/0 of its fresh-address form');

const at = (b, i) => watched.find(w => w.branch === b && w.index === i);
const script = (b, i) => callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch: b, index: i }).body.script_pubkey;
const TIP = 300_000;
const coin = (w, value, height, k) => ({ txid: k.toString(16).padStart(64, '0'), vout: 0, value, status: { confirmed: true, block_height: height }, address: w.address, branch: w.branch, index: w.index });

let db;
const supabase = {
  from: (t) => {
    const o = { select: () => o, eq: () => o, then: (res) => res({ data: Object.entries(db.next).map(([branch, next_index]) => ({ branch: Number(branch), next_index })), error: null }),
      insert: async (row) => { db.inserted.push({ t, ...row }); return { error: null }; } };
    return o;
  },
  rpc: async (name, args) => { db.rpc.push(args); return { data: db.nextChange++, error: null }; },
};
const deps = (coins) => ({ coinsAt: async () => coins, fetchTipHeight: async () => TIP, getFeeRate: async () => 2 });
const reset = () => { db = { next: { 0: 5, 1: 3 }, inserted: [], rpc: [], nextChange: 4 }; };
const dest = callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch: 0, index: 40 }).body.address;

// 1. Everyday path from two addresses, change to a reserved, recorded change address.
reset();
let coins = [coin(at(0, 0), 30_000, TIP - 10, 1), coin(at(0, 3), 50_000, TIP - 10, 2), coin(at(1, 1), 20_000, TIP - 10, 3)];
let r = await buildRangedSpend({ supabase, vault: V, userId: 'u1', body: { destination: dest, amount_sats: 70_000, path: 'everyday' } }, deps(coins));
assert.equal(r.status, 200, JSON.stringify(r.body));
const s = r.body.summary;
assert.equal(s.input_count, 2); assert.equal(s.addresses_combined, 2);
assert.equal(db.rpc.length, 1); assert.equal(db.rpc[0].p_branch, 1);
assert.equal(db.inserted.length, 1); assert.equal(db.inserted[0].branch, 1); assert.equal(db.inserted[0].idx, 4);
assert.equal(db.inserted[0].address, s.change_address);
let p = parsePsbt(r.body.psbt_hex);
assert.equal(toHex(p.tx.outputs[1].scriptPubkey), script(1, 4));
assert.deepEqual(p.inputs.map(i => toHex(i.witnessUtxo.scriptPubkey)).sort(), [script(0, 3), script(0, 0)].sort());
assert.ok(p.inputs.every(i => i.tapLeafScript.length === 1));
assert.equal(s.relative_blocks, null); assert.equal(s.lock_time, 0);
pass('fewest coins (2 of 3), from two addresses -- said so; change to never-used change/4, reserved and recorded');

// 2. "If left untouched": only coins old enough are used; the others wait.
reset();
coins = [coin(at(0, 1), 60_000, TIP - 60_000, 4), coin(at(0, 2), 90_000, TIP - 100, 5)];
r = await buildRangedSpend({ supabase, vault: V, userId: 'u1', body: { destination: dest, amount_sats: 20_000, path: 'quiet' } }, deps(coins));
assert.equal(r.status, 200, JSON.stringify(r.body));
p = parsePsbt(r.body.psbt_hex);
assert.equal(p.inputs.length, 1); assert.equal(toHex(p.inputs[0].witnessUtxo.scriptPubkey), script(0, 1));
assert.ok(p.tx.inputs.every(i => i.sequence === 52_560));
assert.equal(r.body.summary.relative_blocks, 52_560);
assert.equal(r.body.summary.waiting.length, 1); assert.equal(r.body.summary.waiting[0].blocks_left, 52_560 - 101);
pass('"if left untouched": only the old-enough coin is spent, every input carries the 52,560-block wait; the young coin is listed as waiting');

// 3. None old enough: refused, says when the soonest is ready, nothing reserved.
reset();
r = await buildRangedSpend({ supabase, vault: V, userId: 'u1', body: { destination: dest, amount_sats: 20_000, path: 'quiet' } }, deps([coins[1]]));
assert.equal(r.status, 400); assert.match(r.body.error, /52459 blocks/); assert.equal(db.rpc.length, 0);
pass('no coin old enough: refused with when the soonest is ready, nothing reserved');

// 4. A dated path carries its lock time.
reset();
r = await buildRangedSpend({ supabase, vault: V, userId: 'u1', body: { destination: dest, amount_sats: 20_000, path: 'heirs' } }, deps([coins[0]]));
assert.equal(r.status, 200); assert.equal(parsePsbt(r.body.psbt_hex).tx.locktime, 400_000);
pass('a dated path sets its lock time');

// 5. Refusals: an unknown path; a leaf that is not this vault's; a wait that does not match the record.
reset();
r = await buildRangedSpend({ supabase, vault: V, userId: 'u1', body: { destination: dest, amount_sats: 20_000, path: 'nope' } }, deps([coins[0]]));
assert.equal(r.status, 400);
const other = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(x => x.name === 'family');
const otherLeaves = callWasm('/compile-leaves', { network: 'signet', leaves: other.policy.leaves }).body.leaf_scripts;
reset();
r = await buildRangedSpend({ supabase, vault: { ...V, leaf_scripts: { everyday: otherLeaves.everyday } }, userId: 'u1', body: { destination: dest, amount_sats: 20_000, path: 'everyday' } }, deps([coins[0]]));
assert.equal(r.status, 422); assert.equal(db.inserted.length, 0);
reset();
const lying = { ...V, leaves: V.leaves.map(l => (l.id === 'quiet' ? { ...l, unlock: { type: 'older', blocks: 10 } } : l)) };
r = await buildRangedSpend({ supabase, vault: lying, userId: 'u1', body: { destination: dest, amount_sats: 20_000, path: 'quiet' } }, deps([coins[0]]));
assert.equal(r.status, 500); assert.equal(db.inserted.length, 0);
pass('unknown path, another vault\'s leaf, and a wait that differs from the leaf: all refused, no change address recorded');

// 6. A sweep has no change: nothing reserved.
reset();
r = await buildRangedSpend({ supabase, vault: V, userId: 'u1', body: { destination: dest, sweep: true, path: 'everyday' } }, deps([coins[0]]));
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(db.rpc.length, 0); assert.equal(parsePsbt(r.body.psbt_hex).tx.outputs.length, 1);
pass('a sweep reserves no change address');

// 7. oldEnough counts the next block.
const o = oldEnough([{ txid: 'a', vout: 0, value: 1, status: { block_height: 100 } }], 109, 10);
assert.equal(o.ready.length, 1);
assert.equal(oldEnough([{ txid: 'a', vout: 0, value: 1, status: { block_height: 100 } }], 108, 10).ready.length, 0);
pass('a coin is old enough once tip - height + 1 reaches the wait');

console.log(`ranged-spend tests passed (${n} cases)`);
