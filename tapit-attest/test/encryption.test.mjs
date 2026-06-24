import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, decryptToString } from '../dist/index.js';

test('a string round-trips through encrypt and decryptToString', () => {
  const blob = encrypt('the sovereign wallet', 'correct horse battery staple');
  assert.equal(blob.kdf, 'pbkdf2-sha256');
  assert.equal(decryptToString(blob, 'correct horse battery staple'), 'the sovereign wallet');
});

test('raw bytes round-trip through encrypt and decrypt', () => {
  const data = new Uint8Array([1, 2, 3, 250, 251, 252]);
  const blob = encrypt(data, 'pw');
  assert.deepEqual(decrypt(blob, 'pw'), data);
});

test('the wrong password fails to decrypt', () => {
  const blob = encrypt('secret', 'right');
  assert.throws(() => decrypt(blob, 'wrong'), /decryption failed/);
});

test('a tampered ciphertext fails the GCM auth check', () => {
  const blob = encrypt('secret', 'pw');
  const corrupt = { ...blob, ciphertext: blob.ciphertext.replace(/^../, '00') };
  assert.throws(() => decrypt(corrupt, 'pw'));
});

test('each encryption uses a fresh salt and iv', () => {
  const a = encrypt('secret', 'pw');
  const b = encrypt('secret', 'pw');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
});

test('an empty password is rejected', () => {
  assert.throws(() => encrypt('secret', ''), /password/);
});
