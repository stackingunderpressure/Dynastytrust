/**
 * test-sent-secret-faceid.mjs -- proves a saved secret's password can be
 * locked under Face ID (apps/web/src/lib/face-gate.ts) with a SIMULATED
 * passkey; the real WebAuthn prompt is NOT exercised. The rule that
 * matters: an old plain copy of the password is deleted only once the
 * Face ID copy is proven, never before. Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-sent-secret-faceid.mjs
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const fg = await import('../apps/web/src/lib/face-gate.ts');
const ss = await import('../apps/web/src/lib/sent-secrets.ts');
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
const PW = 'circle phrase password 9';
const blob = await ss.wrapSentSecret({ normalPhrase: 'blue heron', duressPhrase: 'red fox' }, PW);
fg.setCachedSecretPassword('s1', PW); // an old plain copy, as before this change

// 1. A flaky passkey is refused and the plain copy is NOT deleted.
await assert.rejects(fg.saveFaceIdSecretPassword('s1', PW, fakePasskey({ deterministic: false })), /same answer twice/);
assert.equal(fg.getCachedSecretPassword('s1'), PW, 'the only copy of the password must survive a failed lock');
assert.equal(fg.hasFaceIdSecretPassword('s1'), false);
pass('failed lock keeps the old plain copy');

// 2. Lock: plain copy gone, nothing readable stored, Face ID opens it and the secret decrypts.
const good = fakePasskey();
await fg.saveFaceIdSecretPassword('s1', PW, good);
assert.equal(fg.getCachedSecretPassword('s1'), null);
assert.equal([...store.values()].some(v => v.includes(PW)), false, 'password readable in storage');
const pw = await fg.openFaceIdSecretPassword('s1', good);
assert.deepEqual(await ss.unwrapSentSecret(blob, pw), { normalPhrase: 'blue heron', duressPhrase: 'red fox' });
pass('locked: no readable password stored, Face ID opens the secret');

// 3. A different passkey cannot open it; delete clears it.
await assert.rejects(fg.openFaceIdSecretPassword('s1', fakePasskey()), /unknown credential/);
await assert.rejects(fg.openFaceIdSecretPassword('s1', { async evaluate() { return new Uint8Array(randomBytes(32)); } }));
fg.clearFaceIdSecretPassword('s1');
assert.equal(fg.hasFaceIdSecretPassword('s1'), false);
await assert.rejects(fg.openFaceIdSecretPassword('s1', good), /No Face ID copy/);
pass('wrong passkey refused; delete removes the Face ID copy');

// 4. What the server hands back has no round count. A save made since the
//    600,000-round change, and one made before at 210,000, must both open
//    with the right password and refuse a wrong one -- the bug found
//    2026-11-13: every save since 2026-11-10 failed as "wrong password".
const ks = await import('../apps/web/src/lib/keystore.ts');
const asServerReturns = (b) => ({ version: 1, saltB64: b.saltB64, nonceB64: b.nonceB64, ciphertextB64: b.ciphertextB64 });
assert.equal(blob.iterations, 600000);
assert.deepEqual(await ss.unwrapSentSecret(asServerReturns(blob), PW), { normalPhrase: 'blue heron', duressPhrase: 'red fox' });
await assert.rejects(ss.unwrapSentSecret(asServerReturns(blob), 'not it'));
// A 210,000-round save, made by hand the way encryptText did before.
const enc = new TextEncoder();
const salt = randomBytes(32), nonce = randomBytes(12);
const base = await crypto.subtle.importKey('raw', enc.encode(PW), 'PBKDF2', false, ['deriveKey']);
const k210 = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k210, enc.encode(JSON.stringify({ normalPhrase: 'old one' }))));
const old = { version: 1, saltB64: Buffer.from(salt).toString('base64'), nonceB64: Buffer.from(nonce).toString('base64'), ciphertextB64: Buffer.from(ct).toString('base64') };
assert.deepEqual(await ss.unwrapSentSecret(old, PW), { normalPhrase: 'old one' }, 'the 210,000-round derivation here must match keystore');
await assert.rejects(ss.unwrapSentSecret(old, 'not it'));
const msgLib = await import('../apps/web/src/lib/messaging.ts');
const { blob: mb, pubkey } = await msgLib.wrapMessagingKeyForBackup('backup pass 12345');
const back = await msgLib.unwrapMessagingKeyFromBackup(asServerReturns(mb), 'backup pass 12345');
assert.equal(back.pub, pubkey);
assert.equal(typeof ks.decryptBlobAnyRounds, 'function');
pass('server-returned blobs open at 600,000 or 210,000 rounds; wrong password refused');

console.log(`sent-secret-faceid tests passed (${n} cases)`);
