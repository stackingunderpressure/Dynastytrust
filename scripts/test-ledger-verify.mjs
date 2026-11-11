/**
 * test-ledger-verify.mjs -- holds the BROWSER's check of the sealed
 * record (apps/web/src/lib/ledger-verify.ts) to the SERVER's
 * (netlify/functions/_ledger.js, _anchor.js, _ots.js).
 *
 * They are two separate implementations on purpose: a member's own
 * check must not be the server's code handed back to them. This test is
 * what keeps the two from drifting -- every honest and every tampered
 * record below must get the same answer, in the same words, from both;
 * and the browser's proof reader must replay the OpenTimestamps
 * reference client's own proof to its real Bitcoin block. Offline.
 * Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-ledger-verify.mjs
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as srvLedger from '../netlify/functions/_ledger.js';
import * as srvOts from '../netlify/functions/_ots.js';
import * as srvAnchor from '../netlify/functions/_anchor.js';
import * as web from '../apps/web/src/lib/ledger-verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const sha = (b) => createHash('sha256').update(b).digest();
const hex = (u8) => Buffer.from(u8).toString('hex');
const V = '11111111-1111-1111-1111-111111111111', U = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// ---- 1. the hash of an entry, and canonical JSON ----------------------
const payloads = [
  {}, { b: 1, a: [3, { z: null, y: 'x' }] }, { amount_sats: 123456789, memo: 'rent -- "March"\n', nested: { k: [true, false, 1.5] } },
  { unicode: 'caf\u00e9 \u20bf', empty: '', skip: undefined },
];
for (const p of payloads) assert.equal(web.canonicalJson(p), srvLedger.canonicalJson(p));
const entries = []; let tip = null;
const kinds = ['created', 'invite_created', 'member_joined', 'draft_compiled', 'psbt_generated', 'signed', 'broadcast'];
kinds.forEach((t, i) => {
  tip = srvLedger.nextLedgerEntry(tip, { vaultId: V, actorUserId: i === 0 ? null : U, eventType: t, payload: payloads[i % payloads.length], recordedAt: `2026-11-11T01:00:0${i}.000Z` });
  // what the API returns: the canonical text AND the parsed details
  entries.push({ ...tip, payload: JSON.parse(tip.payload_canon) });
});
for (const e of entries) assert.equal(web.ledgerEntryHash(e), e.entry_hash, `browser hash of entry ${e.seq}`);
assert.equal(web.LEDGER_GENESIS, srvLedger.LEDGER_GENESIS);
pass('the browser computes the same canonical text and the same hash as the server for every entry');

// ---- 2. the chain: same verdict, same words ---------------------------
const both = (rows) => {
  const a = web.verifyLedger(rows), b = srvLedger.verifyLedger(rows);
  assert.deepEqual(a, b);
  return a;
};
assert.deepEqual(both(entries), { ok: true, count: 7, tip: entries[6].entry_hash });
assert.deepEqual(both([...entries].reverse()), { ok: true, count: 7, tip: entries[6].entry_hash });
assert.deepEqual(both([]), { ok: true, count: 0, tip: web.LEDGER_GENESIS });
const tamper = (f) => { const c = structuredClone(entries); f(c); return both(c); };
assert.match(tamper(c => { c[2].event_type = 'member_removed'; }).reason, /entry 3 was altered/);
assert.match(tamper(c => { c[4].payload_canon = '{"amount_sats":1}'; }).reason, /entry 5 was altered/);
assert.match(tamper(c => { c[4].payload = { amount_sats: 1 }; }).reason, /entry 5: the displayed details differ/);
assert.match(tamper(c => { c[3].recorded_at = '2020-01-01T00:00:00.000Z'; }).reason, /entry 4 was altered/);
assert.match(tamper(c => { c[1].actor_user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; }).reason, /entry 2 was altered/);
assert.match(tamper(c => { c.splice(3, 1); }).reason, /entry 4 is missing or out of order/);
assert.match(tamper(c => { c.shift(); }).reason, /entry 1 is missing or out of order/);
assert.match(tamper(c => { [c[2], c[3]] = [{ ...c[3], seq: 3 }, { ...c[2], seq: 4 }]; }).reason, /entry 3 does not chain/);
// an entry rewritten AND re-hashed is caught by the next entry's link
assert.match(tamper(c => { c[2].event_type = 'x'; c[2].entry_hash = srvLedger.ledgerEntryHash(c[2]); }).reason, /entry 4 does not chain from entry 3/);
pass('altered, removed, reordered and re-hashed entries get the same refusal from the browser as from the server');

// ---- 3. the reference OpenTimestamps proof and its real block ---------
const file = readFileSync(join(here, 'vectors', 'ots-hello-world.txt.ots'));
const BLOCK_358391_MERKLE_ROOT = '8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00';
const { digest, proof } = srvOts.readOtsFile(file);
const u8 = (b) => new Uint8Array(b);
const atts = web.readAttestations(u8(digest), u8(proof));
assert.deepEqual(atts, srvOts.readAttestations(digest, proof));
assert.equal(atts.length, 1); assert.equal(atts[0].kind, 'bitcoin'); assert.equal(atts[0].height, 358391);
assert.equal(web.matchesBlock(atts[0], BLOCK_358391_MERKLE_ROOT), true);
assert.equal(web.matchesBlock(atts[0], '00'.repeat(32)), false);
assert.equal(web.matchesBlock(web.readAttestations(u8(sha('Hello World?\n')), u8(proof))[0], BLOCK_358391_MERKLE_ROOT), false);
for (const bad of [proof.subarray(0, proof.length - 5), Buffer.concat([proof, Buffer.from([0])]), Buffer.from([0x67, 0x00]), Buffer.alloc(5000, 0x08)]) {
  let webErr = null, srvErr = null;
  try { web.readAttestations(u8(digest), u8(bad)); } catch (e) { webErr = e.message; }
  try { srvOts.readAttestations(digest, bad); } catch (e) { srvErr = e.message; }
  assert.ok(webErr, 'the browser must refuse a hostile proof');
  assert.equal(webErr, srvErr);
}
pass('the browser replays the reference proof to Bitcoin block 358,391 and refuses hostile proofs exactly as the server does');

// ---- 4. stamps: same verdict, same words ------------------------------
const vb = (b) => Buffer.concat([Buffer.from([b.length]), b]);
const PENDING = Buffer.from('83dfe30d2ef90c8e', 'hex'), BITCOIN = Buffer.from('0588960d73d71901', 'hex');
function calendarReceipt(d) {
  const nonce = randomBytes(8);
  return { commitment: sha(Buffer.concat([d, nonce])).toString('hex'), proof: Buffer.concat([Buffer.from([0xf0]), vb(nonce), Buffer.from([0x08, 0x00]), PENDING, vb(vb(Buffer.from('https://cal.example')))]) };
}
function bitcoinUpgrade(commitmentHex, height) {
  const h = []; let v = height; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; h.push(b); } while (v);
  return { proof: Buffer.concat([Buffer.from([0x08, 0x00]), BITCOIN, vb(Buffer.from(h))]), root: Buffer.from(sha(Buffer.from(commitmentHex, 'hex'))).reverse().toString('hex') };
}
for (const e of entries) assert.equal(hex(web.anchorDigest({ vaultId: V, seq: e.seq, entryHash: e.entry_hash })), srvOts.anchorDigest({ vaultId: V, seq: e.seq, entryHash: e.entry_hash }).toString('hex'));
const anchors = [], roots = {};
const stamp = (seq, height) => {
  const e = entries[seq - 1];
  const d = srvOts.anchorDigest({ vaultId: V, seq, entryHash: e.entry_hash });
  const rc = calendarReceipt(d);
  const common = { seq, entry_hash: e.entry_hash, digest: d.toString('hex'), calendar: 'cal', commitment: rc.commitment };
  anchors.push({ ...common, kind: 'pending', proof_b64: rc.proof.toString('base64'), bitcoin_height: null });
  if (height) {
    const up = bitcoinUpgrade(rc.commitment, height);
    anchors.push({ ...common, kind: 'bitcoin', proof_b64: up.proof.toString('base64'), bitcoin_height: height });
    roots[height] = up.root;
  }
};
stamp(1, 900100); stamp(4, 900123); stamp(7, 0);
const bothA = (rows, anch, mr) => {
  const a = web.verifyAnchors(rows, anch, mr), b = srvAnchor.verifyAnchors(rows, anch, mr);
  assert.deepEqual(a, b);
  return a;
};
assert.deepEqual(bothA(entries, anchors, roots), { ok: true, anchoredThrough: 7, confirmedThrough: 4, bitcoinHeight: 900123, blocksChecked: true, blocksUnchecked: 0, problems: [] });
assert.equal(bothA(entries, anchors, null).blocksChecked, false);
assert.equal(bothA(entries, [], null).anchoredThrough, 0);
// only the newest block looked up: the older one is unchecked, not failed
assert.deepEqual(bothA(entries, anchors, { 900123: roots[900123] }), { ok: true, anchoredThrough: 7, confirmedThrough: 4, bitcoinHeight: 900123, blocksChecked: true, blocksUnchecked: 1, problems: [] });
assert.match(bothA(entries, anchors, { ...roots, 900123: null }).problems.join(' '), /block 900123 could not be looked up/);
assert.match(bothA(entries, anchors, { ...roots, 900123: '00'.repeat(32) }).problems.join(' '), /is not in block 900123/);
assert.match(bothA(entries.slice(0, 3), anchors, roots).problems.join(' '), /entry 4 was anchored to Bitcoin but is no longer in the ledger/);
const badA = (f) => { const c = structuredClone(anchors); f(c); return bothA(entries, c, roots); };
assert.equal(badA(c => { c[3].bitcoin_height = 1; }).ok, false);
assert.equal(badA(c => { c[3].proof_b64 = Buffer.from('garbage').toString('base64'); }).ok, false);
assert.equal(badA(c => { c[0].commitment = 'ab'.repeat(32); }).ok, false);
assert.equal(badA(c => { c[2].digest = 'cd'.repeat(32); }).ok, false);
assert.equal(badA(c => { c[2].entry_hash = 'ef'.repeat(32); }).ok, false);
assert.match(badA(c => { c[3].commitment = 'ab'.repeat(32); }).problems.join(' '), /does not connect to a receipt/);
assert.equal(badA(c => { c.splice(2, 1); }).confirmedThrough, 1, 'a Bitcoin proof with no receipt linking it to this record counts for nothing');
pass('stamps: honest, cut-off, forged and unlinked cases get the same verdict from the browser as from the server');

// ---- 5. looking the blocks up: two sources, or no green tick ----------
assert.deepEqual(web.heightsToCheck(anchors), [900123, 900100]);
assert.deepEqual(web.heightsToCheck(anchors, 1), [900123]);
const HASH = (h) => createHash('sha256').update(`block${h}`).digest('hex');
const fakeChain = (rootFor) => async (url) => {
  const src = url.startsWith('https://mempool.space/api') ? 'mempool' : url.startsWith('https://blockstream.info/api') ? 'blockstream' : null;
  assert.ok(src, `unexpected source ${url}`);
  const m = url.match(/\/block-height\/(\d+)$/);
  if (m) return { ok: true, status: 200, text: async () => HASH(m[1]) + '\n', json: async () => ({}) };
  const height = [900100, 900123].find(h => url.endsWith(`/block/${HASH(h)}`));
  const root = rootFor(src, height);
  return root ? { ok: true, status: 200, text: async () => '', json: async () => ({ merkle_root: root }) } : { ok: false, status: 503, text: async () => '', json: async () => ({}) };
};
assert.deepEqual(await web.fetchMerkleRoots([900123, 900100], fakeChain((_s, h) => roots[h])), roots);
await assert.rejects(web.fetchMerkleRoots([900123], fakeChain((s, h) => (s === 'mempool' ? roots[h] : '11'.repeat(32)))), /chain sources disagree on block 900123/);
await assert.rejects(web.fetchMerkleRoots([900123], fakeChain((s, h) => (s === 'mempool' ? roots[h] : null))), /lookup 503/);
await assert.rejects(web.fetchMerkleRoots([900123], fakeChain(() => 'not-a-root')), /returned no merkle root/);
pass('a block counts only when mempool.space and blockstream.info agree on it; one source down or lying is refused');

// ---- 6. what the member reads, and the file they keep -----------------
const chk = web.verifyAnchors(entries, anchors, roots);
assert.equal(web.entryStanding(4, chk), 'bitcoin');
assert.equal(web.entryStanding(6, chk), 'receipt');
assert.equal(web.entryStanding(8, chk), 'waiting');
assert.equal(web.ledgerEventWords('broadcast'), 'Spend sent to the Bitcoin network');
assert.equal(web.ledgerEventWords('some_new_kind'), 'some new kind');
for (const t of srvAnchor.MILESTONE_EVENTS) assert.notEqual(web.ledgerEventWords(t), t.replace(/_/g, ' '), `milestone ${t} needs plain words`);
const exported = JSON.parse(web.ledgerExportFile(V, entries, anchors, '2026-11-11T02:00:00.000Z'));
assert.equal(exported.format, 'dynastytrust-sealed-record-v1');
assert.deepEqual(srvLedger.verifyLedger(exported.entries), { ok: true, count: 7, tip: entries[6].entry_hash });
assert.equal(srvAnchor.verifyAnchors(exported.entries, exported.anchors, roots).ok, true);
pass('the downloaded file alone re-verifies; every milestone has plain words; each entry is marked proven, receipted or waiting');

console.log(`ledger-verify tests passed (${n} cases)`);
