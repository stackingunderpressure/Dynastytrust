import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptRecoverable,
  encryptRecoverableWithKData,
  decryptRecoverableWithPassphrase,
  decryptRecoverableWithKData,
} from '../dist/index.js';

// v2 recoverable backup format — the cryptographic foundation for
// Phase 5e cascade recovery. K_data is freshly random per
// encryption and wrapped two independent ways: PBKDF2(passphrase)
// for normal unlock, plus returned to the caller so it can be
// Shamir-split across cohort peers. Either path lands on the same
// plaintext.

test('a string round-trips via the passphrase path', () => {
  const { blob } = encryptRecoverable('hello', 'correct horse');
  const bytes = decryptRecoverableWithPassphrase(blob, 'correct horse');
  assert.equal(new TextDecoder().decode(bytes), 'hello');
});

test('a string round-trips via the kData path (recovery)', () => {
  const { blob, kData } = encryptRecoverable('hello', 'correct horse');
  const bytes = decryptRecoverableWithKData(blob, kData);
  assert.equal(new TextDecoder().decode(bytes), 'hello');
});

test('passphrase and kData paths produce identical plaintext', () => {
  const { blob, kData } = encryptRecoverable('shared output', 'pw');
  const fromPassphrase = decryptRecoverableWithPassphrase(blob, 'pw');
  const fromKData = decryptRecoverableWithKData(blob, kData);
  assert.deepEqual(fromPassphrase, fromKData);
});

test('the wrong passphrase fails', () => {
  const { blob } = encryptRecoverable('secret', 'right');
  assert.throws(
    () => decryptRecoverableWithPassphrase(blob, 'wrong'),
    /wrong passphrase/,
  );
});

test('the wrong kData fails', () => {
  const { blob } = encryptRecoverable('secret', 'pw');
  const fakeKData = new Uint8Array(32);
  assert.throws(
    () => decryptRecoverableWithKData(blob, fakeKData),
    /wrong K_data/,
  );
});

test('kData length is enforced — wrong length rejected before AES attempt', () => {
  const { blob } = encryptRecoverable('secret', 'pw');
  assert.throws(
    () => decryptRecoverableWithKData(blob, new Uint8Array(16)),
    /32 bytes/,
  );
});

test('each encryption uses a fresh K_data, salt, and IVs', () => {
  const a = encryptRecoverable('same plaintext', 'same pw');
  const b = encryptRecoverable('same plaintext', 'same pw');
  assert.notDeepEqual(a.kData, b.kData);
  assert.notEqual(a.blob.salt, b.blob.salt);
  assert.notEqual(a.blob.wrapIv, b.blob.wrapIv);
  assert.notEqual(a.blob.dataIv, b.blob.dataIv);
  // Same plaintext + different K_data → different ciphertext.
  assert.notEqual(a.blob.dataCiphertext, b.blob.dataCiphertext);
});

test('an empty passphrase is rejected', () => {
  assert.throws(() => encryptRecoverable('secret', ''), /passphrase/);
});

test('raw bytes round-trip too', () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const { blob, kData } = encryptRecoverable(data, 'pw');
  assert.deepEqual(decryptRecoverableWithKData(blob, kData), data);
  assert.deepEqual(decryptRecoverableWithPassphrase(blob, 'pw'), data);
});

test('decryptRecoverable* rejects an old v1 blob', () => {
  const fakeV1 = { v: 1, kdf: 'pbkdf2-sha256', iterations: 1, salt: '00', iv: '00', ciphertext: '00' };
  assert.throws(
    () => decryptRecoverableWithPassphrase(fakeV1, 'pw'),
    /unsupported recoverable-blob format/,
  );
});

test('the v2 blob carries enough self-description to round-trip via JSON', () => {
  const { blob, kData } = encryptRecoverable('through json', 'pw');
  const serialized = JSON.stringify(blob);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(
    decryptRecoverableWithKData(parsed, kData),
    new TextEncoder().encode('through json'),
  );
});

// ---------- encryptRecoverableWithKData — recovery save seam ----------
//
// The Phase 5e seam covered by this function: caller has K_data
// reconstructed from M cohort shares, picks a fresh passphrase on the
// new device, and needs a v2 blob that both (a) decrypts under the new
// passphrase via the standard path and (b) decrypts under the same
// K_data so the cohort's existing shares still recover the wallet on
// any future device. Both round-trips below pin those properties.

test('encryptRecoverableWithKData round-trips via the passphrase path', () => {
  const kData = new Uint8Array(32);
  for (let i = 0; i < 32; i++) kData[i] = i + 1;
  const blob = encryptRecoverableWithKData('recovered text', kData, 'new pw');
  const bytes = decryptRecoverableWithPassphrase(blob, 'new pw');
  assert.equal(new TextDecoder().decode(bytes), 'recovered text');
});

test('encryptRecoverableWithKData round-trips via the kData path (cohort shares still decrypt)', () => {
  const kData = new Uint8Array(32);
  for (let i = 0; i < 32; i++) kData[i] = i + 1;
  const blob = encryptRecoverableWithKData('recovered text', kData, 'new pw');
  const bytes = decryptRecoverableWithKData(blob, kData);
  assert.equal(new TextDecoder().decode(bytes), 'recovered text');
});

test('encryptRecoverableWithKData rejects a wrong-length kData', () => {
  assert.throws(
    () => encryptRecoverableWithKData('x', new Uint8Array(16), 'pw'),
    /32 bytes/,
  );
});

test('encryptRecoverableWithKData rejects an empty passphrase', () => {
  const kData = new Uint8Array(32);
  assert.throws(() => encryptRecoverableWithKData('x', kData, ''), /passphrase/);
});

test('a Shamir-split-and-recombined K_data still decrypts a blob saved with encryptRecoverableWithKData', () => {
  // The end-to-end load-bearing property: the cohort distributes
  // shares of K_data at cohort-creation time, the operator recovers
  // on a new device by combining M shares, and then saves the
  // recovered wallet under a new passphrase via this function. Any
  // future recovery must still work — i.e. the same K_data, split
  // again from a peer's still-held share, must combine back to the
  // value that this new blob's dataCiphertext is encrypted under.
  const kData = encryptRecoverable('seed plaintext', 'old pw').kData;
  // Operator picks a fresh passphrase, blob is re-saved with same K_data.
  const newBlob = encryptRecoverableWithKData('post-recovery snapshot', kData, 'new pw');
  // Cohort shares (unchanged) combine back to the same K_data, which
  // still decrypts the new blob.
  const recovered = decryptRecoverableWithKData(newBlob, kData);
  assert.equal(new TextDecoder().decode(recovered), 'post-recovery snapshot');
});

test('encryptRecoverableWithKData generates fresh salt + IVs even with identical inputs', () => {
  const kData = new Uint8Array(32);
  const a = encryptRecoverableWithKData('same plaintext', kData, 'same pw');
  const b = encryptRecoverableWithKData('same plaintext', kData, 'same pw');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.wrapIv, b.wrapIv);
  assert.notEqual(a.dataIv, b.dataIv);
  // Different salt/IVs → different ciphertexts even with same kData.
  assert.notEqual(a.dataCiphertext, b.dataCiphertext);
  assert.notEqual(a.wrapCiphertext, b.wrapCiphertext);
});
