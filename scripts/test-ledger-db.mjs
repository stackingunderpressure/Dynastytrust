// Driven by scripts/test-ledger-db.sh against a throwaway Postgres.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { nextLedgerEntry, verifyLedger, LEDGER_GENESIS } from '../netlify/functions/_ledger.js';

const PORT = process.env.PGPORT;
const sql = (q, role) => execFileSync('psql', ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c',
  (role ? `set role ${role}; ` : '') + q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fails = (q, role, needle, label) => {
  let err = null;
  try { sql(q, role); } catch (e) { err = String(e.stderr || e.message); }
  assert.ok(err, `${label}: the database ALLOWED it`);
  assert.ok(err.includes(needle), `${label}: refused for the wrong reason: ${err.slice(0, 200)}`);
  console.log(`  [ok] REFUSED: ${label}`);
};
const lit = (s) => (s === null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const append = (e, role = 'service_role') => sql(
  `select seq from append_vault_ledger(${lit(e.vault_id)}::uuid, ${e.seq}, ${lit(e.prev_hash)}, ${lit(e.entry_hash)}, ${lit(e.recorded_at)}, ${lit(e.actor_user_id)}::uuid, ${lit(e.event_type)}, ${lit(e.payload_canon)})`, role);
const rows = (vault) => JSON.parse(sql(`select coalesce(json_agg(l order by seq), '[]') from vault_ledger l where vault_id = ${lit(vault)}`) || '[]');

const V = '11111111-1111-1111-1111-111111111111', V2 = '22222222-2222-2222-2222-222222222222';
const alice = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', mallory = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// 1. Honest appends: the database's own hash agrees with the JS hash, including awkward text.
let tip = null; const made = [];
for (const [type, payload] of [['created', { name: "O'Brien family — vault", n: 1 }], ['member_joined', { role: 'heir', note: 'line1\nline2 "quoted" \\ back' }], ['signed', { amount_sats: 900000, nested: { b: 2, a: [1, null, true] } }]]) {
  const e = nextLedgerEntry(tip, { vaultId: V, actorUserId: alice, eventType: type, payload, recordedAt: `2026-11-10T22:00:0${made.length}.000Z` });
  assert.equal(append(e), String(e.seq)); made.push(e); tip = e;
}
const sys = nextLedgerEntry(tip, { vaultId: V, actorUserId: null, eventType: 'anchored', payload: {}, recordedAt: '2026-11-10T22:00:09.000Z' });
append(sys); made.push(sys); tip = sys;
const stored = rows(V);
assert.equal(stored.length, 4);
assert.deepEqual(verifyLedger(stored), { ok: true, count: 4, tip: tip.entry_hash });
assert.equal(stored[0].prev_hash, LEDGER_GENESIS);
pass('four entries appended; the database\'s hash and the JS hash agree; the stored chain verifies');

// 2. Forks, gaps, wrong links and wrong hashes are refused by the database itself.
const fork = nextLedgerEntry(made[1], { vaultId: V, actorUserId: mallory, eventType: 'forged', payload: {}, recordedAt: '2026-11-10T22:01:00.000Z' });
fails(`select append_vault_ledger(${lit(V)}::uuid, ${fork.seq}, ${lit(fork.prev_hash)}, ${lit(fork.entry_hash)}, ${lit(fork.recorded_at)}, ${lit(mallory)}::uuid, 'forged', '{}')`, 'service_role', 'ledger conflict', 'a second entry at an existing position (a fork)');
const gap = { ...nextLedgerEntry(tip, { vaultId: V, actorUserId: mallory, eventType: 'x', payload: {}, recordedAt: 'T' }), seq: 9 };
fails(`select append_vault_ledger(${lit(V)}::uuid, 9, ${lit(gap.prev_hash)}, ${lit(gap.entry_hash)}, 'T', ${lit(mallory)}::uuid, 'x', '{}')`, 'service_role', 'ledger conflict', 'skipping ahead (a gap)');
const good = nextLedgerEntry(tip, { vaultId: V, actorUserId: mallory, eventType: 'x', payload: { a: 1 }, recordedAt: 'T' });
fails(`select append_vault_ledger(${lit(V)}::uuid, ${good.seq}, ${lit(good.prev_hash)}, ${lit(good.entry_hash)}, 'T', ${lit(mallory)}::uuid, 'x', '{"a":2}')`, 'service_role', 'does not match its contents', 'contents that do not match the hash');
fails(`select append_vault_ledger(${lit(V)}::uuid, ${good.seq}, ${lit('f'.repeat(64))}, ${lit(good.entry_hash)}, 'T', ${lit(mallory)}::uuid, 'x', '{"a":1}')`, 'service_role', 'ledger conflict', 'a wrong previous hash');

// 3. Append-only for EVERY role, including the service role and the table owner.
for (const role of ['service_role', null]) {
  const who = role ?? 'the database owner';
  fails(`update vault_ledger set event_type = 'rewritten' where vault_id = ${lit(V)} and seq = 2`, role, 'append-only', `${who} editing an entry`);
  fails(`delete from vault_ledger where vault_id = ${lit(V)} and seq = 4`, role, 'append-only', `${who} deleting an entry`);
}
fails(`truncate vault_ledger`, null, 'append-only', 'truncating the whole ledger');
fails(`insert into vault_ledger (vault_id, seq, recorded_at, event_type, payload_canon, prev_hash, entry_hash) values (${lit(V)}, 5, 'T', 'x', '{}', ${lit(tip.entry_hash)}, ${lit('a'.repeat(64))})`, 'authenticated', 'permission denied', 'a signed-in browser inserting directly');
fails(`select append_vault_ledger(${lit(V)}::uuid, ${good.seq}, ${lit(good.prev_hash)}, ${lit(good.entry_hash)}, 'T', ${lit(mallory)}::uuid, 'x', '{"a":1}')`, 'authenticated', 'permission denied', 'a signed-in browser calling the append function');
assert.deepEqual(verifyLedger(rows(V)), { ok: true, count: 4, tip: tip.entry_hash });
pass('after every attack the stored chain is unchanged and still verifies');

// 4. Reading: members only. Vaults are independent chains.
sql(`insert into vault_members values (${lit(V)}, ${lit(alice)}, 'active'), (${lit(V)}, ${lit(mallory)}, 'removed')`);
const count = (uid) => sql(`set test.uid = ${lit(uid)}; set role authenticated; select count(*) from vault_ledger where vault_id = ${lit(V)}`);
assert.equal(count(alice), '4'); assert.equal(count(mallory), '0');
const other = nextLedgerEntry(null, { vaultId: V2, actorUserId: alice, eventType: 'created', payload: {}, recordedAt: 'T' });
append(other); assert.equal(rows(V2).length, 1); assert.equal(rows(V2)[0].prev_hash, LEDGER_GENESIS);
pass('an active member can read the ledger, a removed one cannot; each vault has its own chain');

// 5. The old events table can no longer be rewritten from the browser.
sql(`insert into vault_events (vault_id, user_id, event_type) values (${lit(V)}, ${lit(alice)}, 'created')`);
fails(`set test.uid = ${lit(alice)}; set role authenticated; update vault_events set event_type = 'rewritten'`, null, 'permission denied', 'a signed-in user editing their own old event row');
fails(`set test.uid = ${lit(alice)}; set role authenticated; delete from vault_events`, null, 'permission denied', 'a signed-in user deleting their own old event row');
assert.equal(sql(`set test.uid = ${lit(alice)}; set role authenticated; select count(*) from vault_events`), '1');
pass('vault_events is read-only from the browser');

// 6. Tampering done BEHIND the database's back (a restored/edited dump) is caught by verification.
const copy = rows(V);
const edited = structuredClone(copy); edited[1].payload_canon = edited[1].payload_canon.replace('heir', 'founder');
assert.equal(verifyLedger(edited).brokenAt, 2);
const removed = copy.filter(r => r.seq !== 2);
assert.equal(verifyLedger(removed).ok, false);
const swapped = structuredClone(copy); [swapped[1].event_type, swapped[2].event_type] = [swapped[2].event_type, swapped[1].event_type];
assert.equal(verifyLedger(swapped).ok, false);
const shown = structuredClone(copy); shown[2].payload.amount_sats = 1;
assert.match(verifyLedger(shown).reason, /displayed details differ/);
pass('an edited, removed or reordered entry -- or details that differ from what was sealed -- fails verification');

console.log(`ledger-db tests passed (${n} groups)`);
