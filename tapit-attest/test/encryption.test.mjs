/** Client-side wallet encryption round-trips. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { encrypt, decrypt, decryptToString } from '../dist/index.js';

test('string encrypt/decrypt round-trips', () => {
  const blob = encrypt('a private mnemonic', 'correct horse battery staple');
  assert.equal(decryptToString(blob, 'correct horse battery staple'), 'a private mnemonic');
});

test('bytes encrypt/decrypt round-trips', () => {
  const data = new Uint8Array([1, 2, 3, 250, 255, 0]);
  const blob = encrypt(data, 'pw');
  assert.deepEqual(decrypt(blob, 'pw'), data);
});

test('a wrong password fails authentication', () => {
  const blob = encrypt('secret', 'right');
  assert.throws(() => decrypt(blob, 'wrong'));
});

test('ciphertext and salt differ across encryptions of the same input', () => {
  const a = encrypt('same', 'pw');
  const b = encrypt('same', 'pw');
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.salt, b.salt);
});

test('blob metadata advertises the algorithm', () => {
  const blob = encrypt('x', 'pw');
  assert.equal(blob.alg, 'aes-256-gcm');
  assert.equal(blob.kdf, 'pbkdf2-sha256');
  assert.ok(blob.rounds >= 210_000);
});
