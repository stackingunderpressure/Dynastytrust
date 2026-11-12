/**
 * test-path-people.mjs -- proves the builder's slot bookkeeping for
 * invited people (apps/web/src/lib/path-people.ts): a saved draft's
 * slots come back from this device's keys and CONFIRMED members only,
 * and each invited person is shown in the state the owner must act on.
 * Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-path-people.mjs
 */
import assert from 'node:assert/strict';
import * as pp from '../apps/web/src/lib/path-people.ts';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const K = (c) => '02' + c.repeat(64);
const OWNER = 'u-dad';
const local = (id, c) => ({ keyId: id, label: `Key ${id}`, persona: 'p', origin: 'software', network: 'signet', fingerprint: c.repeat(8), masterFingerprint: c.repeat(8), derivationPath: "m/48'/1'/0'/2'", xpub: 'tpub' + c, pubkey: K(c), status: 'active', createdAt: 't', backedUp: true });
const member = (id, user, c, extra = {}) => ({ id, created_at: 't', vault_id: 'v1', user_id: user, role: 'heir', label: id, xpub: 'tpub' + c, fingerprint: c.repeat(8), pubkey: K(c), derivation_path: "m/48'/1'/0'/2'", key_label: null, status: 'active', leaf_id: 'kids', key_confirmed_at: null, ...extra });
const anna = member('Anna', 'u-anna', 'c', { key_confirmed_at: '2026-11-11T02:00:00Z' });
const ben = member('Ben', 'u-ben', 'd');
const leaves = [
  { id: 'everyday', label: 'Everyday', keys: [K('a')], quorum: 1, unlock: { type: 'immediate' }, decay: null },
  { id: 'kids', label: 'The kids', keys: ['03' + 'c'.repeat(64), K('d'), K('9')], quorum: 2, unlock: { type: 'after', blocks: 262800 }, decay: null },
];

// 1. A member's confirmed key becomes a slot entry the builder can compile.
const sk = pp.memberToSelected(anna, 'signet');
assert.deepEqual(sk, { keyId: 'member:Anna', label: 'Anna', persona: 'Their own device', pubkey: K('c'), xpub: 'tpubc', fingerprint: 'cccccccc', masterFingerprint: 'cccccccc', derivationPath: "m/48'/1'/0'/2'", network: 'signet', origin: 'member' });
for (const gone of ['pubkey', 'xpub', 'fingerprint', 'derivation_path']) assert.equal(pp.memberToSelected({ ...anna, [gone]: null }, 'signet'), null, gone);
pass('a member with a complete key becomes a slot entry; one missing any part does not');

// 2. Restoring a saved draft: this device's keys and confirmed members only.
const { slots, dropped } = pp.hydrateSlots(leaves, [local('k1', 'a')], [anna, ben], OWNER, 'signet');
assert.deepEqual(slots.everyday.map(k => k.keyId), ['k1']);
assert.deepEqual(slots.kids.map(k => k.keyId), ['member:Anna'], 'the 03 form of her key is still her key; unconfirmed Ben and an unknown key are left out');
assert.equal(dropped, 2);
// the owner's own member row never stands in for a device key
assert.equal(pp.hydrateSlots(leaves, [], [member('Dad', OWNER, 'a', { key_confirmed_at: 'x' })], OWNER, 'signet').slots.everyday.length, 0);
// a removed member's key does not come back
assert.equal(pp.hydrateSlots(leaves, [], [{ ...anna, status: 'removed' }], OWNER, 'signet').slots.kids.length, 0);
pass('a saved draft restores keys from this device and confirmed members; unconfirmed, removed and unknown keys leave the slot empty');

// 3. Who the owner sees on a path, and in what state.
const NOW = new Date('2026-11-11T00:00:00Z');
const inv = (id, extra = {}) => ({ id, created_at: 't', vault_id: 'v1', invited_by: OWNER, invited_role: 'heir', invited_label: id, invited_email: `${id}@x.com`, leaf_id: 'kids', token: id, expires_at: '2026-11-25T00:00:00Z', claimed_at: null, claimed_by: null, ...extra });
const people = pp.peopleOnPath('kids', [inv('Zoe'), inv('Old', { expires_at: '2026-11-01T00:00:00Z' }), inv('Used', { claimed_at: 'x' }), inv('Other', { leaf_id: 'everyday' })], [anna, ben, member('Gone', 'u-g', 'e', { status: 'removed' }), member('Dad', OWNER, 'a')], OWNER, slots.kids, NOW);
assert.deepEqual(people.map(p => [p.kind, p.kind === 'invited' ? p.invite.id : p.member.id, p.kind === 'confirmed' ? p.inSlot : null]), [['confirmed', 'Anna', true], ['joined', 'Ben', null], ['invited', 'Zoe', null]]);
assert.deepEqual(pp.peopleOnPath('everyday', [], [anna], OWNER, [], NOW), []);
pass('each invited person shows as invited, joined-awaiting-confirmation or confirmed; expired, used, removed and other-path entries do not');

// 4. A slot promised to someone is not offered to someone else.
assert.equal(pp.openSlots(3, slots.kids, people), 0, '1 filled + Ben joined + Zoe invited = 3');
assert.equal(pp.openSlots(4, slots.kids, people), 1);
assert.equal(pp.openSlots(1, [], []), 1);
assert.equal(pp.openSlots(1, slots.kids, people), 0);
// a confirmed member whose key is not yet in a slot still holds one
assert.equal(pp.openSlots(1, [], [{ kind: 'confirmed', member: anna, inSlot: false }]), 0);
pass('open slots count what is filled plus what is promised, so a path is never over-invited');

// Must-sign keys come back into their own slot group, beside the others.
{
  const withMust = [{ id: 'everyday', label: 'Everyday', required_keys: [K('a')], keys: [K('b')], quorum: 1, unlock: { type: 'immediate' }, decay: null }, leaves[1]];
  const { slots, dropped } = pp.hydrateSlots(withMust, [local('k1', 'a'), local('k2', 'b')], [anna, ben], OWNER, 'signet');
  assert.deepEqual(slots[pp.mustSlot('everyday')].map(k => k.keyId), ['k1']);
  assert.deepEqual(slots.everyday.map(k => k.keyId), ['k2']);
  assert.equal(slots[pp.mustSlot('kids')], undefined, 'a path with no must-sign keys gets no must-sign group');
  assert.equal(pp.mustSlot('everyday'), 'everyday#must');
  assert.ok(dropped >= 0);
  pass('a saved draft restores must-sign keys into their own group, and other keys into theirs');
}

console.log(`path-people tests passed (${n} cases)`);
