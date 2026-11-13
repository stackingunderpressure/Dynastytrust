/**
 * test-invite-rules.mjs -- proves the rules for a person joining a
 * path-builder vault with their own key (netlify/functions/
 * _invite-rules.js): the invite is for one email, the submitted key
 * must really be the key its xpub yields, a real-bitcoin vault needs a
 * two-step session, and an unconfirmed member key can never be
 * compiled into a vault. Wired into `npm test`.
 *
 * Run:  node scripts/test-invite-rules.mjs
 */
import assert from 'node:assert/strict';
import { HDKey } from '@scure/bip32';
import * as r from '../netlify/functions/_invite-rules.js';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const hex = (b) => Buffer.from(b).toString('hex');
const MAIN = { private: 0x0488ade4, public: 0x0488b21e }, TEST = { private: 0x04358394, public: 0x043587cf };
const mk = (seedByte, versions, path) => {
  const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte), versions);
  const acct = root.derive(path);
  return { xpub: acct.publicExtendedKey, xprv: acct.privateExtendedKey, pubkey: hex(acct.deriveChild(0).deriveChild(0).publicKey), fingerprint: hex(root.identifier.slice(0, 4)), derivation_path: path };
};
const anna = mk(1, MAIN, "m/48'/0'/0'/2'"), ben = mk(2, MAIN, "m/48'/0'/0'/2'"), annaTest = mk(1, TEST, "m/48'/1'/0'/2'");

// 1. Creating a path invite.
const draft = { status: 'draft', leaves: [
  { id: 'everyday', label: 'Everyday signers', keys: [], quorum: 2, unlock: { type: 'immediate' } },
  { id: 'kids', label: 'The kids', keys: [], quorum: 2, unlock: { type: 'after', blocks: 262800 } },
  { id: 'stale', label: 'If untouched', keys: [], quorum: 1, unlock: { type: 'older', blocks: 30000 } } ] };
assert.deepEqual(r.checkPathInvite(draft, { leaf_id: 'kids', invited_label: '  Anna ', invited_email: ' Anna@Example.com ' }), { role: 'heir', label: 'Anna', email: 'anna@example.com', mustSign: false });
assert.equal(r.checkPathInvite(draft, { leaf_id: 'everyday', invited_label: 'Mum', invited_email: 'mum@example.com' }).role, 'founder');
assert.equal(r.checkPathInvite(draft, { leaf_id: 'stale', invited_label: 'Mum', invited_email: 'mum@example.com' }).role, 'heir');
const inv = (o, v = draft) => () => r.checkPathInvite(v, { leaf_id: 'kids', invited_label: 'Anna', invited_email: 'anna@example.com', ...o });
assert.throws(inv({ leaf_id: 'nope' }), /not part of this vault/);
assert.throws(inv({ invited_label: '  ' }), /person's name/);
assert.throws(inv({ invited_label: 'x'.repeat(81) }), /person's name/);
for (const bad of ['anna', 'anna@', '@x.com', 'a b@x.com', 'anna@x']) assert.throws(inv({ invited_email: bad }), /email address/, String(bad));
// Since 2026-11-13: no email at all is a link-only invite (owner confirms the key).
for (const none of ['', '   ', undefined, null, 7]) assert.equal(inv({ invited_email: none })().email, null, String(none));
assert.throws(inv({}, { ...draft, status: 'compiled' }), /only be invited while the vault is still being set up/);
pass('a path invite needs a real path and a name on a vault still being set up; an email is optional but must be real if given; the role follows the path');

// 1b. An invite into a path's must-sign group.
{
  const withMust = { status: 'draft', leaves: [
    { id: 'everyday', label: 'Everyday signers', keys: [], quorum: 1, planned_required: 2, required_keys: [], unlock: { type: 'immediate' } },
    { id: 'kids', label: 'The kids', keys: [], quorum: 2, unlock: { type: 'after', blocks: 262800 } } ] };
  const must = (o = {}, taken = 0, v = withMust) => r.checkPathInvite(v, { leaf_id: 'everyday', invited_label: 'Gran', invited_email: 'gran@example.com', must_sign: true, ...o }, taken);
  assert.equal(must().mustSign, true);
  assert.equal(must({}, 1).mustSign, true, 'one of two must-sign slots promised: one left');
  assert.throws(() => must({}, 2), /Every must-sign slot on "Everyday signers" is already taken or promised/);
  assert.throws(() => must({ leaf_id: 'kids' }), /no keys that must always sign/);
  assert.equal(must({ must_sign: 'yes' }).mustSign, false, 'only a real true asks for a must-sign slot');
  // slots come from the plan, or from must-sign keys already placed if that is more
  assert.equal(r.mustSignSlots({ planned_required: 1, required_keys: ['a', 'b'] }), 2);
  assert.equal(r.mustSignSlots({ keys: ['a'] }), 0);
  assert.equal(r.mustSignSlots(undefined), 0);
}
pass('a must-sign invite needs a path that has must-sign slots, and never more invites than it has slots');

// 2. The link is for one address.
assert.equal(r.emailMatches('Anna@Example.com ', 'anna@example.com'), true);
for (const [a, b] of [['mallory@example.com', 'anna@example.com'], [undefined, 'anna@example.com'], ['anna@example.com', null], ['', ''], ['anna@example.com.evil.io', 'anna@example.com']]) assert.equal(r.emailMatches(a, b), false);
assert.equal(r.inviteEmailAllows('k-1@keys.dynastytrust.family', null), true, 'a link-only invite lets a key account in');
assert.equal(r.inviteEmailAllows(undefined, ''), true);
assert.equal(r.inviteEmailAllows('k-1@keys.dynastytrust.family', 'anna@example.com'), false, 'an email invite never lets a key account in');
assert.equal(r.inviteEmailAllows('Anna@example.com', 'anna@example.com'), true);
pass('only the invited email address matches; a missing or look-alike address does not; a link-only invite needs no email');

// 3. Real bitcoin needs the second step.
assert.equal(r.joinAllowedAtAal('bitcoin', 'aal2'), true);
assert.equal(r.joinAllowedAtAal('bitcoin', 'aal1'), false);
assert.equal(r.joinAllowedAtAal('bitcoin', undefined), false);
assert.equal(r.joinAllowedAtAal('signet', 'aal1'), true);
assert.equal(r.joinAllowedAtAal('testnet', undefined), true);
assert.equal(r.joinAllowedAtAal('bitcoin', 'aal1', true), true, 'a key-made session counts');
assert.equal(r.joinAllowedAtAal('bitcoin', 'aal1', 'yes'), false, 'only a real true counts');
pass('joining a real-bitcoin vault needs a two-step or key-made session; test networks do not');

// 4. The submitted key must be what it claims to be.
const key = ({ xprv: _x, ...k }) => k;
assert.deepEqual(r.checkClaimedKey(key(anna), 'bitcoin'), key(anna));
assert.deepEqual(r.checkClaimedKey({ ...key(annaTest), pubkey: annaTest.pubkey.toUpperCase(), fingerprint: annaTest.fingerprint.toUpperCase() }, 'signet'), key(annaTest));
const badKey = (o, net = 'bitcoin') => () => r.checkClaimedKey({ ...key(anna), ...o }, net);
assert.throws(badKey({ pubkey: ben.pubkey }), /does not belong to the xpub sent/);
assert.throws(badKey({ xpub: ben.xpub }), /does not belong to the xpub sent/);
assert.throws(badKey({ xpub: anna.xprv }), /private extended key/);
assert.throws(badKey({ xpub: 'xpub' + 'z'.repeat(107) }), /not a valid extended public key/);
assert.throws(badKey({ xpub: 'hello' }), /missing or not readable/);
assert.throws(badKey({ pubkey: anna.pubkey.slice(2) }), /missing or malformed/);
assert.throws(badKey({ pubkey: '04' + anna.pubkey.slice(2) }), /missing or malformed/);
assert.throws(badKey({ fingerprint: 'xyz' }), /fingerprint must be 8 characters/);
assert.throws(badKey({ fingerprint: undefined }), /fingerprint/);
for (const p of ['48/0', "m/48'/0'/0'/2'/", 'm', "m/48'/0'/0'/2'; drop table", 'm/' + '1/'.repeat(11) + '1']) assert.throws(badKey({ derivation_path: p }), /derivation path/, p);
assert.throws(() => r.checkClaimedKey(key(annaTest), 'bitcoin'), /test-coin key\. A real-bitcoin vault needs/);
assert.throws(() => r.checkClaimedKey(key(anna), 'signet'), /real-bitcoin key\. This vault holds test coins/);
pass('a key is accepted only when its signing key is the xpub\'s own first child, on the right kind of coin, with nothing private or malformed');

// 5. Only a confirmed member key may be compiled.
const OWNER = 'owner-1';
const members = [
  { user_id: OWNER, label: 'Dad', pubkey: ben.pubkey, status: 'active', key_confirmed_at: null },
  { user_id: 'u-anna', label: 'Anna', pubkey: anna.pubkey, status: 'active', key_confirmed_at: null },
];
const leaves = [{ id: 'everyday', label: 'Everyday signers', keys: [ben.pubkey] }, { id: 'kids', label: 'The kids', keys: [anna.pubkey, '02' + 'f'.repeat(64)] }];
assert.deepEqual(r.unconfirmedMemberKeys(leaves, members, OWNER), [{ member: 'Anna', path: 'The kids' }]);
// the 03 twin of the same key is the same signer and is caught too
const twin = (anna.pubkey.startsWith('02') ? '03' : '02') + anna.pubkey.slice(2);
assert.deepEqual(r.unconfirmedMemberKeys([{ id: 'kids', label: 'The kids', keys: [twin] }], members, OWNER), [{ member: 'Anna', path: 'The kids' }]);
members[1].key_confirmed_at = '2026-11-11T02:00:00Z';
assert.deepEqual(r.unconfirmedMemberKeys(leaves, members, OWNER), []);
// the owner's own keys, and keys that belong to no member, need no confirmation
assert.deepEqual(r.unconfirmedMemberKeys(leaves, [members[0]], OWNER), []);
// a removed member's key no longer blocks (it is not their slot any more)
assert.deepEqual(r.unconfirmedMemberKeys(leaves, [{ ...members[1], key_confirmed_at: null, status: 'removed' }], OWNER), []);
assert.deepEqual(r.unconfirmedMemberKeys([], [], OWNER), []);
pass('an invited person\'s key blocks finalizing until the owner confirms it; the owner\'s own and pasted keys do not');

// 6. Before the vault is finalized an invited person sees their own
//    path and the owner -- not the other paths, keys or people.
const draftVault = { id: 'v1', user_id: OWNER, status: 'draft', name: 'Family vault', consent_keys: [anna.pubkey], key_labels: [{ pubkey: ben.pubkey, label: 'Dad' }], key_origins: [{ pubkey: ben.pubkey }], trust_doc: { purpose: 'all of it' },
  leaves: [{ id: 'everyday', label: 'Everyday signers', keys: [ben.pubkey], quorum: 1 }, { id: 'kids', label: 'The kids', keys: [anna.pubkey], quorum: 2, planned_keys: 3 }] };
const seen = r.draftViewForMember(draftVault, { leaf_id: 'kids' }, 'u-anna');
assert.deepEqual(seen.leaves, [{ id: 'kids', label: 'The kids', keys: [], quorum: 2, planned_keys: 3 }]);
assert.deepEqual([seen.consent_keys, seen.key_labels, seen.key_origins, seen.trust_doc], [[], [], null, {}]);
assert.ok(!JSON.stringify(seen).includes(ben.pubkey) && !JSON.stringify(seen).includes('Everyday'));
assert.equal(seen.name, 'Family vault');
assert.deepEqual(r.draftViewForMember(draftVault, { leaf_id: null }, 'u-x').leaves, [], 'a member with no path sees no paths');
assert.equal(r.draftViewForMember(draftVault, { leaf_id: 'kids' }, OWNER), draftVault, 'the owner sees everything');
const compiled = { ...draftVault, status: 'compiled' };
assert.equal(r.draftViewForMember(compiled, { leaf_id: 'kids' }, 'u-anna'), compiled, 'a finalized vault is shown whole to its members');
const named = { id: 'v2', user_id: OWNER, status: 'draft', leaves: null, founder_keys: [] };
assert.equal(r.draftViewForMember(named, {}, 'u-anna'), named, 'older-shape drafts are untouched');
const roster = [
  { id: 'm1', vault_id: 'v1', user_id: OWNER, role: 'owner', label: 'Dad', status: 'active', created_at: 't', fingerprint: ben.fingerprint, pubkey: ben.pubkey },
  { id: 'm2', vault_id: 'v1', user_id: 'u-anna', role: 'heir', label: 'Anna', status: 'active', created_at: 't', fingerprint: anna.fingerprint, pubkey: anna.pubkey },
  { id: 'm3', vault_id: 'v1', user_id: 'u-ben', role: 'heir', label: 'Ben', status: 'active', created_at: 't', fingerprint: 'aaaaaaaa', pubkey: '02' + 'e'.repeat(64) },
];
const annaSees = r.draftRosterForMember(roster, draftVault, 'u-anna');
assert.deepEqual(annaSees.map(m => m.label), ['Dad', 'Anna']);
assert.equal(annaSees[0].pubkey, undefined); assert.equal(annaSees[0].fingerprint, undefined);
assert.equal(annaSees[1].pubkey, anna.pubkey);
assert.equal(r.draftRosterForMember(roster, draftVault, OWNER), roster);
assert.equal(r.draftRosterForMember(roster, compiled, 'u-anna'), roster);
pass('before finalizing, an invited person sees only their own path without keys, and only themselves and the owner');

console.log(`invite-rules tests passed (${n} cases)`);
