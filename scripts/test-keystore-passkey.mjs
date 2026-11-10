/**
 * test-keystore-passkey.mjs -- proves passkey-protected keys
 * (apps/web/src/lib/keystore.ts) with a SIMULATED passkey: everything
 * except the device prompt itself. The real WebAuthn PRF call
 * (lib/passkey.ts) cannot run outside a browser with an authenticator
 * and is NOT exercised here. Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-keystore-passkey.mjs
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const ks = await import('../apps/web/src/lib/keystore.ts');

let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// A well-behaved passkey: one device secret per credential, PRF = HMAC(secret, salt).
function fakePasskey({ deterministic = true } = {}) {
  const creds = new Map();
  const calls = { create: 0, evaluate: 0 };
  return {
    calls,
    async create() { calls.create++; const id = randomBytes(16).toString('base64'); creds.set(id, randomBytes(32)); return { credentialIdB64: id }; },
    async evaluate(id, saltB64) {
      calls.evaluate++;
      if (!creds.has(id)) throw new Error('unknown credential');
      if (!deterministic) return new Uint8Array(randomBytes(32));
      return new Uint8Array(createHmac('sha256', creds.get(id)).update(Buffer.from(saltB64, 'base64')).digest());
    },
  };
}
const raw = (keyId) => JSON.parse([...store.values()][0]).find(k => k.keyId === keyId);

// 1. Refused until the written backup is verified; key untouched.
const PW = 'correct horse battery staple';
const { key, mnemonic } = await ks.generateSoftwareKey({ label: 'k', network: 'mainnet', password: PW, persona: 'k' });
const good = fakePasskey();
await assert.rejects(ks.protectKeyWithPasskey(key.keyId, { password: PW, prf: good }), /Back up and verify/);
assert.equal(good.calls.create, 0, 'no passkey may be created before the backup check');
assert.ok(raw(key.keyId).encryptedMnemonic && !raw(key.keyId).passkeyMnemonic);
pass('refused without a verified written backup; nothing changed');

// 2. A wrong current password changes nothing.
ks.markBackedUp(key.keyId);
await assert.rejects(ks.protectKeyWithPasskey(key.keyId, { password: 'wrong', prf: good }), /Wrong password/);
assert.ok(raw(key.keyId).encryptedMnemonic && !raw(key.keyId).passkeyMnemonic);
pass('wrong current password: nothing changed');

// 3. A passkey that answers differently each time is refused; key untouched.
const flaky = fakePasskey({ deterministic: false });
await assert.rejects(ks.protectKeyWithPasskey(key.keyId, { password: PW, prf: flaky }), /same answer twice/);
assert.ok(raw(key.keyId).encryptedMnemonic && !raw(key.keyId).passkeyMnemonic);
assert.equal(await ks.revealMnemonic(key.keyId, PW), mnemonic, 'password must still work after the refused attempt');
pass('non-deterministic passkey refused; password still works');

// 4. Success: password blob gone, no plaintext anywhere, passkey unlocks.
const after = await ks.protectKeyWithPasskey(key.keyId, { password: PW, prf: good });
assert.ok(after.passkeyMnemonic);
assert.equal(after.encryptedMnemonic, undefined);
assert.equal(after.testMnemonic, undefined);
const stored = JSON.stringify(raw(key.keyId));
for (const w of mnemonic.split(' ').filter(w => w.length > 4)) assert.equal(stored.includes(w), false, 'mnemonic word found in storage');
assert.equal(ks.keyNeedsPassword(ks.getKey(key.keyId)), false);
assert.equal(ks.keySigningBlockedReason(ks.getKey(key.keyId)), null, 'a passkey key may sign on mainnet');
assert.equal(await ks.revealMnemonic(key.keyId, undefined, good), mnemonic);
pass('passkey replaces the password: no password blob, no plaintext, passkey reveals the seed');

// 5. A different passkey (or the right one after tampering) cannot unlock.
await assert.rejects(ks.revealMnemonic(key.keyId, undefined, fakePasskey()), /unknown credential/);
const impostor = { async evaluate() { return new Uint8Array(randomBytes(32)); } };
await assert.rejects(ks.revealMnemonic(key.keyId, undefined, impostor), /could not unlock/);
await assert.rejects(ks.protectKeyWithPasskey(key.keyId, { prf: good }), /already protected/);
pass('a wrong passkey secret cannot unlock; double-protect refused');

// 6. Back to a password; passkey blob gone; old password does not work, new one does.
const back = await ks.passkeyToPassword(key.keyId, 'new-password-123', good);
assert.equal(back.passkeyMnemonic, undefined);
assert.equal(await ks.revealMnemonic(key.keyId, 'new-password-123'), mnemonic);
await assert.rejects(ks.revealMnemonic(key.keyId, PW), /Wrong password/);
pass('passkey -> password restores a password-protected key');

// 7. A plaintext signet test key can go straight to a passkey.
const t = ks.generateTestKey({ label: 't', network: 'signet', persona: 't' });
ks.markBackedUp(t.key.keyId);
const tp = await ks.protectKeyWithPasskey(t.key.keyId, { prf: good });
assert.equal(tp.testMnemonic, undefined);
assert.equal(await ks.revealMnemonic(t.key.keyId, undefined, good), t.mnemonic);
pass('test key upgrades directly to a passkey; plaintext removed');

console.log(`keystore-passkey tests passed (${n} cases)`);
