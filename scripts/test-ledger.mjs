/**
 * test-ledger.mjs -- proves the pure rules of the vault's tamper-evident
 * record (netlify/functions/_ledger.js): the canonical form, the chain,
 * and that every kind of after-the-fact change is detected. Wired into
 * `npm test`. The database half (append-only, no forks, hash recomputed
 * by Postgres) is proven separately against a real Postgres by
 * `npm run test:ledger-db`.
 *
 * Run:  node scripts/test-ledger.mjs
 */
import assert from 'node:assert/strict';
import { canonicalJson, ledgerEntryHash, nextLedgerEntry, verifyLedger, appendLedger, recordEvent, LEDGER_GENESIS } from '../netlify/functions/_ledger.js';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const V = '11111111-1111-1111-1111-111111111111', U = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// canonical form: key order and whitespace never change the hash
assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }], z: undefined }), '{"a":[2,{"c":"x","d":null}],"b":1}');
assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
assert.equal(canonicalJson('line\n"q"'), '"line\\n\\"q\\""');
assert.equal(canonicalJson(NaN), 'null');
pass('canonical JSON is independent of key order and has no ambiguity');

// a fixed known answer, so the hash recipe cannot drift silently
const fixed = { prev_hash: LEDGER_GENESIS, vault_id: V, seq: 1, recorded_at: '2026-11-10T22:00:00.000Z', actor_user_id: U, event_type: 'created', payload_canon: '{"name":"Family"}' };
// (independently reproduced with `printf ... | sha256sum` when this test was written)
const KNOWN = '9a2aac5b0514534be850f122e73a6a80aab40dd1105c49d612eaef8bb1ad52cf';
assert.equal(ledgerEntryHash(fixed), KNOWN, 'the hash recipe changed -- every existing ledger would stop verifying');
assert.equal(ledgerEntryHash({ ...fixed, actor_user_id: null }) !== KNOWN, true);
pass('entry hash matches a known answer reproduced outside this code');

// build a chain
const chain = []; let tip = null;
for (const [t, p] of [['created', { name: 'Family' }], ['invite_created', { role: 'heir' }], ['member_joined', { role: 'heir' }], ['draft_compiled', { address: 'tb1p...' }], ['signed', { proposal_id: 'p1' }]]) {
  tip = nextLedgerEntry(tip, { vaultId: V, actorUserId: U, eventType: t, payload: p, recordedAt: `2026-11-10T22:00:0${chain.length}.000Z` });
  chain.push({ ...tip, payload: p });
}
assert.deepEqual(verifyLedger(chain), { ok: true, count: 5, tip: tip.entry_hash });
assert.deepEqual(verifyLedger([...chain].reverse()), { ok: true, count: 5, tip: tip.entry_hash });
assert.deepEqual(verifyLedger([]), { ok: true, count: 0, tip: LEDGER_GENESIS });
pass('an honest chain verifies, in any delivery order; an empty ledger is valid');

// every kind of change is caught, and the report names where
const mut = (f) => { const c = structuredClone(chain); f(c); return verifyLedger(c); };
assert.equal(mut(c => { c[1].payload_canon = '{"role":"founder"}'; }).brokenAt, 2);
assert.equal(mut(c => { c[1].payload = { role: 'founder' }; c[1].payload_canon = '{"role":"founder"}'; c[1].entry_hash = ledgerEntryHash(c[1]); }).brokenAt, 3, 're-hashing an edited entry breaks the NEXT link');
assert.equal(mut(c => { c[2].actor_user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; }).brokenAt, 3);
assert.equal(mut(c => { c[3].recorded_at = '2020-01-01T00:00:00.000Z'; }).brokenAt, 4);
assert.equal(mut(c => { c[0].event_type = 'deleted'; }).brokenAt, 1);
assert.equal(mut(c => { c.splice(2, 1); }).ok, false, 'a removed entry');
assert.equal(mut(c => { c.pop(); c.pop(); }).ok, true, 'a truncated TAIL verifies on its own -- only an external anchor of the tip can catch that');
assert.equal(mut(c => { c.push({ ...c[4] }); }).ok, false, 'a duplicated entry');
assert.equal(mut(c => { c[4].payload = { proposal_id: 'p2' }; }).ok, false, 'shown details differ from sealed details');
assert.equal(mut(c => { [c[1], c[2]] = [c[2], c[1]]; c[1].seq = 2; c[2].seq = 3; }).ok, false, 'reordered entries');
pass('edits, re-hashed edits, changed actor or time, removals, duplicates and reorders are all detected');

// appendLedger retries a lost race from the new tip, and gives up on a real error
const fake = (script) => {
  let tipRow = null; const calls = [];
  return { calls, from() { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: tipRow, error: null }), insert: async () => ({ error: null }) }; return q; },
    async rpc(_name, args) { calls.push(args); const r = script(calls.length, args); if (r?.advance) tipRow = r.advance; return r?.res ?? { data: args, error: null }; } };
};
const other = nextLedgerEntry(null, { vaultId: V, actorUserId: U, eventType: 'x', payload: {} });
const raced = fake((i) => (i === 1 ? { res: { data: null, error: { message: 'ledger conflict: expected seq 2, got 1' } }, advance: { seq: 1, entry_hash: other.entry_hash } } : null));
const got = await appendLedger(raced, { vaultId: V, actorUserId: U, eventType: 'y', payload: { a: 1 } });
assert.equal(raced.calls.length, 2);
assert.equal(got.p_seq, 2); assert.equal(got.p_prev_hash, other.entry_hash);
await assert.rejects(appendLedger(fake(() => ({ res: { data: null, error: { message: 'permission denied' } } })), { vaultId: V, actorUserId: U, eventType: 'y', payload: {} }), /ledger append failed: permission denied/);
pass('a lost race is retried from the new tip; a real error is not retried and is reported');

// recordEvent never fails the action it describes when the ledger is unavailable
const errs = []; const realErr = console.error; console.error = (m) => errs.push(String(m));
try {
  const r = await recordEvent(fake(() => ({ res: { data: null, error: { message: 'relation "vault_ledger" does not exist' } } })), { vault_id: V, user_id: U, event_type: 'signed', metadata: {} });
  assert.equal(r.error, null);
} finally { console.error = realErr; }
assert.equal(errs.length, 1); assert.match(errs[0], /NOT SEALED: signed/);
pass('if the ledger cannot be written the action still completes and the gap is logged loudly');

console.log(`ledger tests passed (${n} cases)`);
