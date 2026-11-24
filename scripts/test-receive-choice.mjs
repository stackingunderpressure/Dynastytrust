/**
 * test-receive-choice.mjs -- which receive/change address to use, and
 * "ever paid" lookups (docs/receive-address-reuse-until-paid-build-note.md;
 * operator, 2026-11-24: "If I click on an address and don't use it there is
 * no way to go back and use it it just skips to next one. Nunchick only
 * counts after it's used on chain"). Also: watching past 200 addresses.
 *
 * Run: node scripts/test-receive-choice.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const { GAP_LIMIT, currentUnpaid, unpaidRun, reusableChange } = await import(F('_receive-choice.js'));
const { watchedAddresses, vaultUsed } = await import(F('_vault-coins.js'));
const { electrumUsed, GENESIS, scripthashOf } = await import(F('_electrum.js'));
const { callWasm } = await import(F('_ranged-wasm.js'));
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const A = (idx, label = null) => ({ idx, address: `a${idx}`, label });
const issued = [A(0), A(1), A(2), A(3), A(4)];
assert.equal(currentUnpaid(issued, new Set(['a0', 'a1', 'a2', 'a3', 'a4'])), null);
assert.equal(currentUnpaid(issued, new Set(['a0', 'a2'])).idx, 4);
assert.equal(currentUnpaid([A(0)], new Set()), null);
pass('current = the newest issued address never paid; never address 0; none when all are paid');

assert.equal(unpaidRun(5, issued, new Set(['a0', 'a2'])), 2);
assert.equal(unpaidRun(5, issued, new Set()), 5);
assert.equal(unpaidRun(8, issued, new Set(['a4'])), 3); // 5-7 reserved, never recorded: still holes
assert.equal(GAP_LIMIT, 20);
pass('the unpaid run counts every number after the last paid one, recorded or not');

assert.equal(reusableChange([A(0), A(1), A(2)], new Set(['a0', 'a2'])).idx, 1);
assert.equal(reusableChange([A(0)], new Set(['a0'])), null);
pass('change reuse picks the LOWEST change address never paid');

// Watching past 200: the wasm route answers 200 at a time.
const shape = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(s => s.name === 'family');
const V = { address: null, network: 'signet', descriptor_version: 2, descriptor_multipath: shape.multipath_descriptor, descriptor_receive: shape.receive_descriptor, descriptor_change: shape.change_descriptor };
V.address = callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch: 0, index: 0 }).body.address;
const w = watchedAddresses(V, { 0: 450, 1: 3 });
const recv = w.filter((x) => x.branch === 0);
assert.equal(recv.length, 455);
assert.deepEqual(recv.map((x) => x.index), Array.from({ length: 455 }, (_, i) => i));
assert.equal(recv[454].address, callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch: 0, index: 454 }).body.address);
pass('a vault with 450 addresses handed out watches all of them plus 5 (was capped at 200)');

// "Ever paid" over Electrum: one batched get_history; a spent-out address still counts.
// Signet's real block 0 header (its hash is checked against GENESIS.signet).
const GEN_SIGNET_HEADER = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a008f4d5fae77031e8ad22203';
const watched = recv.slice(0, 3);
const log = [];
const connect = () => {
  const s = new EventEmitter();
  s.getPeerCertificate = () => ({ fingerprint256: 'x' });
  s.destroy = () => {};
  s.write = (line) => {
    const reqs = JSON.parse(line); log.push(reqs);
    const out = reqs.map((r) => ({ id: r.id, result: r.method === 'blockchain.block.header' ? GEN_SIGNET_HEADER
      : r.params[0] === scripthashOf(watched[1].address, 'signet') ? [{ tx_hash: 'ab'.repeat(32), height: 5 }, { tx_hash: 'cd'.repeat(32), height: 9 }] : [] }));
    setImmediate(() => s.emit('data', Buffer.from(JSON.stringify(out) + '\n')));
  };
  setImmediate(() => s.emit('secureConnect'));
  return s;
};
const used = await electrumUsed({ host: 'x', port: 1, publicCa: true }, 'signet', watched, { connect });
assert.deepEqual([...used], [watched[1].address]);
assert.equal(log.length, 1); assert.equal(log[0].length, 1 + watched.length);
assert.equal(GENESIS.signet, '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6');
pass('Electrum: every address in one batched history request; an address with any history is paid');

// Website fallback: confirmed or waiting transactions both count.
const site = { [watched[0].address]: { chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 1 } },
  [watched[1].address]: { chain_stats: { tx_count: 2 }, mempool_stats: { tx_count: 0 } },
  [watched[2].address]: { chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 0 } } };
const u2 = await vaultUsed('bitcoin', watched, {}, { serverFor: async () => null, fetchJson: async (url) => site[url.split('/address/')[1]] });
assert.deepEqual([...u2].sort(), [watched[0].address, watched[1].address].sort());
pass('website lookups: a waiting payment counts as paid, an empty address does not');

console.log(`receive-choice tests passed (${n} cases)`);
