/**
 * test-messaging-faceid.mjs -- proves the messaging key's Face ID lock
 * (apps/web/src/lib/messaging.ts) with a SIMULATED passkey. The real
 * WebAuthn PRF prompt (lib/passkey.ts) cannot run outside a browser and
 * is NOT exercised here. Wired into `npm test`.
 *
 * The rule that matters most: a locked key must never be mistaken for a
 * missing one and regenerated -- that would silently lose every message.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-messaging-faceid.mjs
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const URL_ = new URL('../apps/web/src/lib/messaging.ts', import.meta.url).href;
let visit = 0;
const freshVisit = () => import(`${URL_}?visit=${++visit}`); // a page reload: new module memory, same storage
const msg = await freshVisit();

let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
function fakePasskey({ deterministic = true } = {}) {
  const creds = new Map();
  return {
    async create() { const id = randomBytes(16).toString('base64'); creds.set(id, randomBytes(32)); return { credentialIdB64: id }; },
    async evaluate(id, saltB64) {
      if (!creds.has(id)) throw new Error('unknown credential');
      if (!deterministic) return new Uint8Array(randomBytes(32));
      return new Uint8Array(createHmac('sha256', creds.get(id)).update(Buffer.from(saltB64, 'base64')).digest());
    },
  };
}
const KEY = 'dynastytrust:messaging:v1';
const stored = () => JSON.parse(store.get(KEY));

// Two members: "me" (this browser) and "friend" (a key made elsewhere).
const myPub = msg.getMessagingPubkey();
const friendPriv = randomBytes(32).toString('hex');
const { x25519 } = await import('@noble/curves/ed25519');
const friendPub = Buffer.from(x25519.getPublicKey(Buffer.from(friendPriv, 'hex'))).toString('hex');
const toMe = msg.encryptMessage('meet at the bank at noon', [{ user_id: 'me', pubkey: myPub }, { user_id: 'friend', pubkey: friendPub }]);
assert.equal(msg.decryptMessage(toMe, 'me'), 'meet at the bank at noon');
const plainPriv = stored().priv;

// 1. A passkey that answers differently each time is refused; key untouched.
await assert.rejects(msg.lockMessagingKey(fakePasskey({ deterministic: false })), /same answer twice/);
assert.equal(stored().priv, plainPriv);
assert.equal(msg.messagingKeyUsesFaceId(), false);
pass('flaky passkey refused; key left exactly as it was');

// 2. Lock: no private key in storage, same public key, still open this visit.
const good = fakePasskey();
await msg.lockMessagingKey(good);
assert.equal(stored().priv, undefined);
assert.equal(stored().pub, myPub);
assert.equal(JSON.stringify(stored()).includes(plainPriv), false, 'private key found in storage');
assert.equal(msg.messagingKeyUsesFaceId(), true);
assert.equal(msg.messagingKeyLocked(), false, 'stays open for the rest of this visit');
assert.equal(msg.decryptMessage(toMe, 'me'), 'meet at the bank at noon');
pass('locked: private key gone from storage, public key unchanged, open this visit');

// 3. Next visit: locked. Nothing regenerates; reading returns null; sending refuses.
const v2 = await freshVisit();
assert.equal(v2.messagingKeyLocked(), true);
assert.equal(v2.hasLocalMessagingKey(), true, 'a locked key is not a missing key');
assert.equal(v2.getMessagingPubkey(), myPub, 'the public key needs no Face ID and must not change');
assert.equal(stored().priv, undefined, 'reading the public key must not regenerate a plain key');
assert.equal(v2.decryptMessage(toMe, 'me'), null);
assert.throws(() => v2.encryptMessage('hi', [{ user_id: 'friend', pubkey: friendPub }]), /locked with Face ID/);
assert.throws(() => v2.ensureMessagingKey(), /locked with Face ID/);
assert.equal(stored().pub, myPub);
pass('next visit: locked, nothing regenerated, read/send wait for Face ID');

// 4. A different passkey cannot open it; the right one can.
await assert.rejects(v2.unlockMessagingKey(fakePasskey()), /unknown credential/);
const impostor = { async evaluate() { return new Uint8Array(randomBytes(32)); } };
await assert.rejects(v2.unlockMessagingKey(impostor), /could not open/);
assert.equal(v2.messagingKeyLocked(), true);
await v2.unlockMessagingKey(good);
assert.equal(v2.messagingKeyLocked(), false);
assert.equal(v2.decryptMessage(toMe, 'me'), 'meet at the bank at noon');
const reply = v2.encryptMessage('see you there', [{ user_id: 'friend', pubkey: friendPub }]);
assert.equal(reply.sender_pubkey, myPub);
pass('wrong passkey refused; right passkey opens, reads and sends');

// 5. The passphrase backup still works from a locked key (opens it first).
const v3 = await freshVisit();
const { pubkey, blob } = await v3.wrapMessagingKeyForBackup('long backup passphrase 42', good);
assert.equal(pubkey, myPub);
const restored = await v3.unwrapMessagingKeyFromBackup(blob, 'long backup passphrase 42');
assert.equal(restored.priv, plainPriv);
pass('passphrase backup from a locked key carries the real key');

// 6. Switch back: plain again, the same key.
const v4 = await freshVisit();
await v4.unlockMessagingKeyForGood(good);
assert.equal(stored().priv, plainPriv);
assert.equal(v4.messagingKeyUsesFaceId(), false);
assert.equal(v4.decryptMessage(toMe, 'me'), 'meet at the bank at noon');
pass('stop using Face ID: the same key, plain again');

// 7. Unreadable junk is replaced as before; anything naming a lock is refused.
store.set(KEY, '{"garbage":true}');
const v5 = await freshVisit();
const newPub = v5.getMessagingPubkey();
assert.notEqual(newPub, myPub);
store.set(KEY, '{"pub":"nothex","locked":{}}');
const v6 = await freshVisit();
assert.throws(() => v6.getMessagingPubkey(), /could not be read/);
assert.equal(store.get(KEY), '{"pub":"nothex","locked":{}}', 'a damaged lock must not be overwritten');
pass('junk replaced as before; a damaged Face ID lock is never overwritten');

// 8. Regenerate clears both storage and this visit's open key.
store.delete(KEY);
const v7 = await freshVisit();
v7.getMessagingPubkey();
await v7.lockMessagingKey(good);
const fresh = v7.regenerateMessagingKey();
assert.equal(v7.messagingKeyUsesFaceId(), false);
assert.equal(stored().pub, fresh);
assert.ok(stored().priv);
pass('regenerate makes a new plain key and forgets the old one');

console.log(`messaging-faceid tests passed (${n} cases)`);
