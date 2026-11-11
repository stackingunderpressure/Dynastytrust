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
assert.deepEqual(r.checkPathInvite(draft, { leaf_id: 'kids', invited_label: '  Anna ', invited_email: ' Anna@Example.com ' }), { role: 'heir', label: 'Anna', email: 'anna@example.com' });
assert.equal(r.checkPathInvite(draft, { leaf_id: 'everyday', invited_label: 'Mum', invited_email: 'mum@example.com' }).role, 'founder');
assert.equal(r.checkPathInvite(draft, { leaf_id: 'stale', invited_label: 'Mum', invited_email: 'mum@example.com' }).role, 'heir');
const inv = (o, v = draft) => () => r.checkPathInvite(v, { leaf_id: 'kids', invited_label: 'Anna', invited_email: 'anna@example.com', ...o });
assert.throws(inv({ leaf_id: 'nope' }), /not part of this vault/);
assert.throws(inv({ invited_label: '  ' }), /person's name/);
assert.throws(inv({ invited_label: 'x'.repeat(81) }), /person's name/);
for (const bad of ['', 'anna', 'anna@', '@x.com', 'a b@x.com', 'anna@x', undefined, 7]) assert.throws(inv({ invited_email: bad }), /email address/, String(bad));
assert.throws(inv({}, { ...draft, status: 'compiled' }), /only be invited while the vault is still being set up/);
pass('a path invite needs a real path, a name and an email, on a vault still being set up; the role follows the path');

// 2. The link is for one address.
assert.equal(r.emailMatches('Anna@Example.com ', 'anna@example.com'), true);
for (const [a, b] of [['mallory@example.com', 'anna@example.com'], [undefined, 'anna@example.com'], ['anna@example.com', null], ['', ''], ['anna@example.com.evil.io', 'anna@example.com']]) assert.equal(r.emailMatches(a, b), false);
pass('only the invited email address matches; a missing or look-alike address does not');

// 3. Real bitcoin needs the second step.
assert.equal(r.joinAllowedAtAal('bitcoin', 'aal2'), true);
assert.equal(r.joinAllowedAtAal('bitcoin', 'aal1'), false);
assert.equal(r.joinAllowedAtAal('bitcoin', undefined), false);
assert.equal(r.joinAllowedAtAal('signet', 'aal1'), true);
assert.equal(r.joinAllowedAtAal('testnet', undefined), true);
pass('joining a real-bitcoin vault needs a two-step session; test networks do not');

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

console.log(`invite-rules tests passed (${n} cases)`);
