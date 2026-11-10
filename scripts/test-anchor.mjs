/**
 * test-anchor.mjs -- proves the anchoring rules (netlify/functions/
 * _anchor.js): what gets anchored when, and that a ledger whose recent
 * entries were cut off or replaced no longer matches its anchors.
 * Wired into `npm test`. Offline: calendars and block lookups are
 * stand-ins here; the real calendar round trip and the real proof
 * parser are covered by scripts/test-ots.mjs.
 *
 * Run:  node scripts/test-anchor.mjs
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { nextLedgerEntry } from '../netlify/functions/_ledger.js';
import { anchorDigest } from '../netlify/functions/_ots.js';
import { verifyAnchors, anchorTip, upgradePending, isMilestone } from '../netlify/functions/_anchor.js';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const sha = (b) => createHash('sha256').update(b).digest();
const V = '11111111-1111-1111-1111-111111111111', U = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const vb = (b) => Buffer.concat([Buffer.from([b.length]), b]);

// A stand-in calendar that speaks the real wire format: append a nonce,
// hash, attest "pending"; later: hash again, attest "bitcoin at height".
const PENDING = Buffer.from('83dfe30d2ef90c8e', 'hex'), BITCOIN = Buffer.from('0588960d73d71901', 'hex');
function calendarReceipt(digest, uri = 'https://cal.example') {
  const nonce = randomBytes(8);
  const commitment = sha(Buffer.concat([digest, nonce]));
  const proof = Buffer.concat([Buffer.from([0xf0]), vb(nonce), Buffer.from([0x08, 0x00]), PENDING, vb(vb(Buffer.from(uri)))]);
  return { proof, commitment: commitment.toString('hex') };
}
function bitcoinUpgrade(commitmentHex, height) {
  const root = sha(Buffer.from(commitmentHex, 'hex'));
  const h = []; let v = height; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; h.push(b); } while (v);
  const proof = Buffer.concat([Buffer.from([0x08, 0x00]), BITCOIN, vb(Buffer.from(h))]);
  return { proof, merkleRootDisplayHex: Buffer.from(root).reverse().toString('hex') };
}

// A ledger of five entries, anchored at 2 (pending) and at 4 (pending + bitcoin).
const entries = []; let tip = null;
for (const t of ['created', 'invite_created', 'member_joined', 'draft_compiled', 'signed']) {
  tip = nextLedgerEntry(tip, { vaultId: V, actorUserId: U, eventType: t, payload: {}, recordedAt: `2026-11-10T22:00:0${entries.length}.000Z` });
  entries.push(tip);
}
const row = (seq, kind, extra = {}) => {
  const e = entries[seq - 1];
  const digest = anchorDigest({ vaultId: V, seq, entryHash: e.entry_hash });
  const rc = extra.rc ?? calendarReceipt(digest);
  if (kind === 'pending') return { seq, entry_hash: e.entry_hash, digest: digest.toString('hex'), calendar: 'cal', kind, commitment: rc.commitment, proof_b64: rc.proof.toString('base64'), bitcoin_height: null, rc };
  const up = bitcoinUpgrade(rc.commitment, 900123);
  return { seq, entry_hash: e.entry_hash, digest: digest.toString('hex'), calendar: 'cal', kind, commitment: rc.commitment, proof_b64: up.proof.toString('base64'), bitcoin_height: 900123 };
};
const p2 = row(2, 'pending'), p4 = row(4, 'pending'), b4 = row(4, 'bitcoin', { rc: p4.rc });
const anchors = [p2, p4, b4];
const ROOT4 = bitcoinUpgrade(p4.commitment, 900123).merkleRootDisplayHex;
assert.deepEqual(verifyAnchors(entries, anchors, { 900123: ROOT4 }), { ok: true, anchoredThrough: 4, confirmedThrough: 4, bitcoinHeight: 900123, blocksChecked: true, problems: [] });
assert.equal(verifyAnchors(entries, anchors).blocksChecked, false, 'without block data the result must say the block was not checked');
assert.deepEqual(verifyAnchors(entries, []), { ok: true, anchoredThrough: 0, confirmedThrough: 0, bitcoinHeight: null, blocksChecked: false, problems: [] });
// the proof must be in the REAL block, and an unreachable block is not a pass
assert.match(verifyAnchors(entries, anchors, { 900123: '00'.repeat(32) }).problems.join(' '), /is not in block 900123/);
assert.match(verifyAnchors(entries, anchors, {}).problems.join(' '), /could not be looked up/);
pass('an honest ledger matches its anchors: anchored through entry 4, confirmed in a Bitcoin block');

// THE POINT: what a hash chain alone cannot see.
const cut = entries.slice(0, 3);                                   // recent entries cut off
let r = verifyAnchors(cut, anchors);
assert.equal(r.ok, false); assert.match(r.problems.join(' '), /entry 4 was anchored to Bitcoin but is no longer in the ledger/);
// a different but perfectly self-consistent chain put in its place
const swapped = []; let t2 = null;
for (const t of ['created', 'invite_created', 'member_joined', 'something_else', 'signed']) {
  t2 = nextLedgerEntry(t2, { vaultId: V, actorUserId: U, eventType: t, payload: {}, recordedAt: `2026-11-10T22:00:0${swapped.length}.000Z` });
  swapped.push(t2);
}
r = verifyAnchors(swapped, anchors);
assert.equal(r.ok, false); assert.match(r.problems.join(' '), /entry 4 is not the entry that was anchored/);
pass('a ledger with its tail cut off, or replaced by another consistent chain, no longer matches its anchors');

// Forged or mismatched anchor rows are not counted.
const bad = (f) => { const c = structuredClone(anchors.map(({ rc, ...a }) => a)); f(c); return verifyAnchors(entries, c); };
assert.equal(bad(c => { c[2].bitcoin_height = 1; }).ok, false, 'claimed height the proof does not reach');
assert.equal(bad(c => { c[2].proof_b64 = Buffer.from('garbage').toString('base64'); }).ok, false, 'unreadable proof');
assert.equal(bad(c => { c[0].commitment = 'ab'.repeat(32); }).ok, false, 'receipt that leads elsewhere');
assert.equal(bad(c => { c[1].digest = 'cd'.repeat(32); }).ok, false, 'anchor made over a different digest');
assert.match(bad(c => { c[2].commitment = 'ab'.repeat(32); }).problems.join(' '), /does not connect to a receipt/, 'bitcoin proof from a different commitment');
// a Bitcoin proof with NO receipt linking it to our digest counts for nothing, however valid it is on its own
assert.equal(bad(c => { c.splice(1, 1); }).confirmedThrough, 0);
pass('anchor rows with a wrong height, digest, commitment or unreadable proof are rejected');

// What is anchored at once, and what waits for the daily sweep.
for (const e of ['created', 'draft_compiled', 'broadcast', 'member_joined', 'member_removed', 'deleted']) assert.equal(isMilestone(e), true, e);
for (const e of ['invite_created', 'psbt_generated', 'signed', 'message_sent', 'cancelled']) assert.equal(isMilestone(e), false, e);
pass('vault created/finalized, spend broadcast and membership changes anchor immediately; the rest daily');

// anchorTip + upgradePending against a stand-in database and calendar.
function fakeDb() {
  const ledger = entries.map(e => ({ ...e })), rows = [];
  const q = (table) => {
    const f = []; let lim = Infinity, desc = false;
    const api = {
      select: () => api, eq: (k, v) => { f.push([k, v]); return api; }, order: (_k, o) => { desc = o?.ascending === false; return api; }, limit: (x) => { lim = x; return api; },
      get data() { let d = (table === 'vault_ledger' ? ledger : rows).filter(r => f.every(([k, v]) => String(r[k]) === String(v))); if (desc) d = [...d].sort((a, b) => b.seq - a.seq); return d.slice(0, lim); },
      maybeSingle: async () => ({ data: api.data[0] ?? null, error: null }),
      then: (res) => res({ data: api.data, error: null }),
      insert: async (r) => { if (rows.some(x => x.vault_id === r.vault_id && x.seq === r.seq && x.calendar === r.calendar && x.kind === r.kind)) return { error: { message: 'duplicate key' } }; rows.push(r); return { error: null }; },
    };
    return api;
  };
  return { rows, from: q };
}
const db = fakeDb();
const submit = async (digest, cal) => { if (cal === 'down') throw new Error('calendar down'); return calendarReceipt(digest, cal); };
const first = await anchorTip(db, V, 'milestone:test', { calendars: ['a', 'b', 'down'], submit });
assert.deepEqual(first, { seq: 5, submitted: 2 });
assert.equal(db.rows.length, 2);
const again = await anchorTip(db, V, 'daily', { calendars: ['a', 'b', 'down'], submit });
assert.equal(again.submitted, 0, 'a position already anchored at a calendar is not submitted to it again');
assert.equal(verifyAnchors(entries, db.rows).anchoredThrough, 5);
pass('anchorTip submits the tip to each calendar once; one calendar being down does not stop the others');

const ups = new Map(db.rows.map(r => [r.commitment, bitcoinUpgrade(r.commitment, 900200)]));
let res = await upgradePending(db, {
  upgrade: async (c, cal) => (cal === 'a' ? { proof: ups.get(c).proof, attestations: [{ kind: 'bitcoin', height: 900200, commitment: sha(Buffer.from(c, 'hex')).toString('hex') }] } : null),
  rootAt: async () => ups.get(db.rows.find(r => r.calendar === 'a').commitment).merkleRootDisplayHex,
});
assert.deepEqual(res, { upgraded: 1, stillPending: 1 });
assert.deepEqual(verifyAnchors(entries, db.rows), { ok: true, anchoredThrough: 5, confirmedThrough: 5, bitcoinHeight: 900200, blocksChecked: false, problems: [] });
// a calendar that claims a block the proof is not actually in is NOT recorded
const before = db.rows.length;
res = await upgradePending(db, {
  upgrade: async (c) => ({ proof: ups.get(c).proof, attestations: [{ kind: 'bitcoin', height: 900200, commitment: sha(Buffer.from(c, 'hex')).toString('hex') }] }),
  rootAt: async () => '00'.repeat(32),
});
assert.equal(res.upgraded, 0); assert.equal(db.rows.length, before);
pass('a receipt is upgraded only when its proof matches the real block; a proof that does not match is not recorded');

console.log(`anchor tests passed (${n} cases)`);
