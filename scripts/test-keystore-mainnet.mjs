/**
 * test-keystore-mainnet.mjs -- proves that a plaintext (test-mode) seed can
 * never be created, downgraded to, or used for signing on mainnet
 * (apps/web/src/lib/keystore.ts), while the upgrade path to a
 * password-protected key stays open. Wired into `npm test`.
 *
 * keystore.ts is browser code; the only browser global it touches is
 * localStorage, shimmed here with an in-memory map. WebCrypto and
 * crypto.randomUUID are Node globals already.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-keystore-mainnet.mjs
 */

import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const ks = await import('../apps/web/src/lib/keystore.ts');

let n = 0;
const pass = (label) => { n++; console.log(`  [ok] ${label}`); };

// 1. A test-mode key cannot be generated for mainnet; signet is fine.
assert.throws(() => ks.generateTestKey({ label: 'm', network: 'mainnet', persona: 'm' }), /not allowed on mainnet/);
const { key: sig, mnemonic } = ks.generateTestKey({ label: 's', network: 'signet', persona: 's' });
assert.equal(typeof sig.testMnemonic, 'string');
assert.equal(ks.keySigningBlockedReason(sig), null);
assert.equal(await ks.revealMnemonic(sig.keyId), mnemonic);
pass('test-mode key refused on mainnet, allowed and usable on signet');

// 2. A plaintext mainnet key that already exists (created before this
//    rule, or imported from a keyring file) cannot reveal its seed to sign.
{
  const all = JSON.parse(store.values().next().value);
  all[0].network = 'mainnet';
  store.set([...store.keys()][0], JSON.stringify(all));
}
const legacy = ks.getKey(sig.keyId);
assert.equal(legacy.network, 'mainnet');
assert.match(ks.keySigningBlockedReason(legacy), /plain text and may not sign on mainnet/);
await assert.rejects(ks.revealMnemonic(sig.keyId), /may not sign on mainnet/);
pass('pre-existing plaintext mainnet key cannot sign');

// 3. The upgrade path stays open: add a password, then sign with it.
const secured = await ks.secureTestKey(sig.keyId, 'correct horse battery staple');
assert.equal(secured.testMnemonic, undefined);
assert.ok(secured.encryptedMnemonic);
assert.equal(ks.keySigningBlockedReason(secured), null);
assert.equal(await ks.revealMnemonic(sig.keyId, 'correct horse battery staple'), mnemonic);
await assert.rejects(ks.revealMnemonic(sig.keyId, 'wrong'), /Wrong password/);
pass('upgrading to a password-protected key restores signing on mainnet');

// 4. It cannot be downgraded back to plaintext on mainnet.
assert.throws(() => ks.removeKeyPassword(sig.keyId, mnemonic), /not allowed on mainnet/);
assert.ok(ks.getKey(sig.keyId).encryptedMnemonic, 'key must still be encrypted after the refused downgrade');
pass('removing the password is refused on mainnet');

// 5. Hardware and secure keys are never touched by the rule.
const secureMain = await ks.generateSoftwareKey({ label: 'h', network: 'mainnet', password: 'maple-ridge-lantern-42', persona: 'h' });
assert.equal(ks.keySigningBlockedReason(secureMain.key), null);
pass('password-protected mainnet key is allowed');

// 6. Deleting a protected key requires unlocking it; a wrong password deletes nothing.
await assert.rejects(ks.deleteKeyVerified(secureMain.key.keyId, { password: 'not-the-password' }), /Wrong password/);
await assert.rejects(ks.deleteKeyVerified(secureMain.key.keyId), /Password required/);
assert.ok(ks.getKey(secureMain.key.keyId), 'key must survive a failed delete');
await ks.deleteKeyVerified(secureMain.key.keyId, { password: 'maple-ridge-lantern-42' });
assert.equal(ks.getKey(secureMain.key.keyId), null);
const plain = ks.generateTestKey({ label: 'p', network: 'signet', persona: 'p' });
await ks.deleteKeyVerified(plain.key.keyId);
assert.equal(ks.getKey(plain.key.keyId), null, 'a key with nothing to unlock deletes directly');
await assert.rejects(ks.deleteKeyVerified('no-such-key'), /Key not found/);
pass('delete needs the right password for a protected key; wrong password deletes nothing');

console.log(`keystore-mainnet tests passed (${n} cases)`);
