/**
 * test-authz.mjs -- proves the shared authorization rules in
 * netlify/functions/_authz.js, the single place the 2026-11-10 audit's
 * fixes hang off. Wired into `npm test`.
 *
 * These are the pure rules. The handlers that call them are syntax- and
 * bundle-checked but NOT exercised against a live database here.
 *
 * Run:  node scripts/test-authz.mjs
 */
import assert from 'node:assert/strict';
import {
  canMutate, isTerminalProposalStatus, redactMember, redactInvite,
  stripPathKeys, sanitizeTrancheUpdate, isNewerProof,
} from '../netlify/functions/_authz.js';

let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// view-only members change nothing; everyone else may; garbage may not
for (const r of ['owner', 'founder', 'heir', 'beneficiary']) assert.equal(canMutate(r), true, r);
for (const r of ['viewer', '', null, undefined, 42]) assert.equal(canMutate(r), false, String(r));
pass('viewer (and a missing role) cannot mutate; owner/founder/heir/beneficiary can');

for (const s of ['broadcast', 'cancelled', 'fulfilled']) assert.equal(isTerminalProposalStatus(s), true);
for (const s of ['draft', 'pending', 'signed', undefined]) assert.equal(isTerminalProposalStatus(s), false);
pass('terminal proposal statuses are locked, live ones are not');

// xpub redaction: owner sees all, a member sees their own, others see null
const m = { id: 'm1', user_id: 'alice', label: 'Alice', fingerprint: 'aabbccdd', xpub: 'tpubSECRET' };
assert.equal(redactMember(m, { callerIsOwner: true, callerUserId: 'owner' }).xpub, 'tpubSECRET');
assert.equal(redactMember(m, { callerIsOwner: false, callerUserId: 'alice' }).xpub, 'tpubSECRET');
const seen = redactMember(m, { callerIsOwner: false, callerUserId: 'bob' });
assert.equal(seen.xpub, null);
assert.equal(seen.fingerprint, 'aabbccdd');
assert.equal(m.xpub, 'tpubSECRET', 'input must not be mutated');
pass("another member's xpub is redacted; labels and fingerprints stay");

// invite token never leaves; email only for the owner
const inv = { id: 'i1', token: 'JOIN-AS-FOUNDER', invited_email: 'x@example.com', invited_role: 'founder' };
for (const callerIsOwner of [true, false]) {
  const out = redactInvite(inv, { callerIsOwner });
  assert.equal('token' in out, false, 'token must never leave');
  assert.equal(JSON.stringify(out).includes('JOIN-AS-FOUNDER'), false);
  assert.equal(out.invited_email, callerIsOwner ? 'x@example.com' : null);
  assert.equal(out.invited_role, 'founder');
}
pass('invite token is stripped for everyone; invited email only for the owner');

const paths = stripPathKeys([{ id: 'founders_now', quorum: 2, keyCount: 3, keys: ['tpubA', 'tpubB', 'tpubC'] }]);
assert.deepEqual(paths, [{ id: 'founders_now', quorum: 2, keyCount: 3 }]);
assert.deepEqual(stripPathKeys(null), []);
pass('anonymous invite lookup gets path shape without keys');

// tranches: only txids, only empty -> value for a non-owner, nothing else written
const T1 = 'a'.repeat(64), T2 = 'b'.repeat(64);
const prior = [{ index: 0, unlock_block: 900000, amount_sats: 5000, address: 'tb1qvault', descriptor: 'tr(...)', funded_txid: T1, claimed_txid: null, label: 'First' }];
const member = { callerIsOwner: false }, owner = { callerIsOwner: true };
let r = sanitizeTrancheUpdate(prior, [{ ...prior[0], claimed_txid: T2 }], member);
assert.equal(r.ok, true);
assert.equal(r.tranches[0].claimed_txid, T2);
r = sanitizeTrancheUpdate(prior, [{ ...prior[0], funded_txid: T2 }], member);
assert.equal(r.ok, false, 'member must not replace a recorded txid');
r = sanitizeTrancheUpdate(prior, [{ ...prior[0], funded_txid: null }], member);
assert.equal(r.ok, false, 'member must not clear a recorded txid');
r = sanitizeTrancheUpdate(prior, [{ ...prior[0], funded_txid: null }], owner);
assert.equal(r.ok, true, 'owner may correct a recorded txid');
r = sanitizeTrancheUpdate(prior, [{ ...prior[0], claimed_txid: 'not-a-txid' }], owner);
assert.equal(r.ok, false, 'malformed txid refused even for the owner');
r = sanitizeTrancheUpdate(prior, [{ ...prior[0], address: 'tb1qATTACKER', amount_sats: 1, evil: true, claimed_txid: T2 }], member);
assert.equal(r.ok, true);
assert.deepEqual(r.tranches[0], { ...prior[0], claimed_txid: T2 }, 'only the txid may differ from the stored row');
assert.equal(sanitizeTrancheUpdate(prior, [], member).ok, false);
assert.equal(sanitizeTrancheUpdate(prior, 'x', member).ok, false);
pass('tranche update: txids only, fill-in only for members, stored row otherwise untouched');

// heartbeat ordering
assert.equal(isNewerProof('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'), true);
assert.equal(isNewerProof('2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z'), false, 'stale proof must not replace a newer one');
assert.equal(isNewerProof('2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z'), false, 'replay of the same proof is not newer');
assert.equal(isNewerProof(undefined, '2026-11-02T00:00:00Z'), true);
assert.equal(isNewerProof('2026-11-02T00:00:00Z', 'garbage'), false);
pass('a proof-of-life only replaces an older one');

console.log(`authz tests passed (${n} cases)`);
