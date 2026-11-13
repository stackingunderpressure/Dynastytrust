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
// Two words side by side, not single words: the record's own field names
// ("label", "network", "version") are themselves recovery words, so a
// single-word check failed by chance whenever the random phrase drew one
// (seen 2026-11-11). A stored phrase would show its words in order.
const mw = mnemonic.split(' ');
for (let i = 0; i + 1 < mw.length; i++) assert.equal(stored.includes(`${mw[i]} ${mw[i + 1]}`), false, 'mnemonic words found in storage');
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
const back = await ks.passkeyToPassword(key.keyId, 'third-quartz-meadow-123', good);
assert.equal(back.passkeyMnemonic, undefined);
assert.equal(await ks.revealMnemonic(key.keyId, 'third-quartz-meadow-123'), mnemonic);
await assert.rejects(ks.revealMnemonic(key.keyId, PW), /Wrong password/);
pass('passkey -> password restores a password-protected key');

// 7. A plaintext signet test key can go straight to a passkey.
const t = ks.generateTestKey({ label: 't', network: 'signet', persona: 't' });
ks.markBackedUp(t.key.keyId);
const tp = await ks.protectKeyWithPasskey(t.key.keyId, { prf: good });
assert.equal(tp.testMnemonic, undefined);
assert.equal(await ks.revealMnemonic(t.key.keyId, undefined, good), t.mnemonic);
pass('test key upgrades directly to a passkey; plaintext removed');

// 8. One passkey per device: keys 4 and 7 share it; a third key reuses it too.
assert.equal(good.calls.create, 1, 'the device passkey is made once, not once per key');
assert.equal(raw(t.key.keyId).passkeyMnemonic.credentialIdB64, ks.devicePasskeyId());
const k3 = await ks.generateSoftwareKey({ label: 'k3', network: 'mainnet', password: PW, persona: 'k3' });
ks.markBackedUp(k3.key.keyId);
await ks.protectKeyWithPasskey(k3.key.keyId, { password: PW, prf: good });
assert.equal(good.calls.create, 1);
assert.notEqual(raw(k3.key.keyId).passkeyMnemonic.prfSaltB64, raw(t.key.keyId).passkeyMnemonic.prfSaltB64, 'each single lock gets its own salt');
pass('one passkey per device, each key under its own salt');

// 9. The backup screen may hand over the words it just showed -- only this key's own.
const k4 = await ks.generateSoftwareKey({ label: 'k4', network: 'mainnet', password: PW, persona: 'k4' });
ks.markBackedUp(k4.key.keyId);
await assert.rejects(ks.protectKeyWithPasskey(k4.key.keyId, { mnemonic: k3.mnemonic, prf: good }), /does not belong/);
assert.ok(raw(k4.key.keyId).encryptedMnemonic && !raw(k4.key.keyId).passkeyMnemonic);
await ks.protectKeyWithPasskey(k4.key.keyId, { mnemonic: k4.mnemonic, prf: good });
assert.equal(await ks.revealMnemonic(k4.key.keyId, undefined, good), k4.mnemonic);
pass('backup-screen words accepted only when they are this key\'s own');

// 10. Lock all: one password, two Face ID prompts, wrong-password / test /
//     not-backed-up keys left exactly as they were.
const a = await ks.generateSoftwareKey({ label: 'a', network: 'mainnet', password: PW, persona: 'a' });
const b = await ks.generateSoftwareKey({ label: 'b', network: 'mainnet', password: PW, persona: 'b' });
const other = await ks.generateSoftwareKey({ label: 'other', network: 'mainnet', password: 'a-different-pass-777', persona: 'o' });
const unbacked = await ks.generateSoftwareKey({ label: 'unbacked', network: 'mainnet', password: PW, persona: 'u' });
const test2 = ks.generateTestKey({ label: 'test2', network: 'signet', persona: 't2' });
for (const k of [a, b, other, test2]) ks.markBackedUp(k.key.keyId);
const plan = ks.passkeyLockPlan();
assert.deepEqual(plan.ready.map(k => k.label).sort(), ['a', 'b', 'k', 'other'], "key k went back to a password in case 6, so it is ready again");
assert.deepEqual(plan.notBackedUp.map(k => k.label), ['unbacked']);
const before = good.calls.evaluate;
const res = await ks.protectAllKeysWithPasskey(PW, good);
assert.equal(good.calls.evaluate - before, 2, 'two Face ID prompts for the whole batch');
assert.deepEqual(res.locked.map(k => k.label).sort(), ['a', 'b']);
assert.deepEqual(res.wrongPassword.map(k => k.label).sort(), ['k', 'other']);
assert.equal(await ks.revealMnemonic(a.key.keyId, undefined, good), a.mnemonic);
assert.equal(await ks.revealMnemonic(b.key.keyId, undefined, good), b.mnemonic);
assert.equal(await ks.revealMnemonic(other.key.keyId, 'a-different-pass-777'), other.mnemonic);
assert.ok(raw(unbacked.key.keyId).encryptedMnemonic && !raw(unbacked.key.keyId).passkeyMnemonic);
assert.equal(raw(test2.key.keyId).testMnemonic, test2.mnemonic, 'test keys are never touched by lock-all');
pass('lock all: one password, two prompts, the rest left as they were');

// 11. A device passkey made just now that fails is forgotten; an older one is kept.
store.delete('dt:devicePasskey:v1');
const c = await ks.generateSoftwareKey({ label: 'c', network: 'mainnet', password: PW, persona: 'c' });
ks.markBackedUp(c.key.keyId);
await assert.rejects(ks.protectKeyWithPasskey(c.key.keyId, { password: PW, prf: fakePasskey({ deterministic: false }) }), /same answer twice/);
assert.equal(ks.devicePasskeyId(), null, 'a failed new passkey must not be remembered');
const fresh = fakePasskey();
await ks.protectKeyWithPasskey(c.key.keyId, { password: PW, prf: fresh });
const kept = ks.devicePasskeyId();
const cancelled = { ...fresh, async evaluate() { throw new Error('cancelled'); } };
const d = await ks.generateSoftwareKey({ label: 'd', network: 'mainnet', password: PW, persona: 'd' });
ks.markBackedUp(d.key.keyId);
await assert.rejects(ks.protectKeyWithPasskey(d.key.keyId, { password: PW, prf: cancelled }), /cancelled/);
assert.equal(ks.devicePasskeyId(), kept, 'a cancelled prompt must not forget a passkey already in use');
pass('failed new passkey forgotten; cancelled prompt keeps the old one');

console.log(`keystore-passkey tests passed (${n} cases)`);
