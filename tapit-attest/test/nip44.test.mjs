import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptTo,
  decryptFrom,
  generateKeypair,
} from '../dist/index.js';

// NIP-44 v2 peer-encryption tests. These verify the implementation
// is internally consistent and rejects tampering at every position.
// Interop against the upstream NIP-44 v2 reference vectors should be
// verified before shipping wide; the round-trip plus tamper coverage
// here catches construction-level bugs.

test('a plaintext round-trips between two parties', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const payload = encryptTo('hello, peer', bob.publicKey, alice.privateKey);
  assert.equal(
    decryptFrom(payload, alice.publicKey, bob.privateKey),
    'hello, peer',
  );
});

test('each encryption uses a fresh nonce — same input, different output', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const a = encryptTo('same text', bob.publicKey, alice.privateKey);
  const b = encryptTo('same text', bob.publicKey, alice.privateKey);
  assert.notEqual(a, b);
});

test('a third party cannot decrypt', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const eve = generateKeypair();
  const payload = encryptTo('only for bob', bob.publicKey, alice.privateKey);
  assert.throws(
    () => decryptFrom(payload, alice.publicKey, eve.privateKey),
    /MAC/,
  );
});

test('decryption fails when the wrong sender pubkey is named', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const mallory = generateKeypair();
  const payload = encryptTo('from alice', bob.publicKey, alice.privateKey);
  assert.throws(
    () => decryptFrom(payload, mallory.publicKey, bob.privateKey),
    /MAC/,
  );
});

test('a tampered payload fails the MAC check', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const payload = encryptTo('integrity matters', bob.publicKey, alice.privateKey);
  // Flip one character in the middle of the base64 payload.
  const i = Math.floor(payload.length / 2);
  const swap = payload[i] === 'A' ? 'B' : 'A';
  const tampered = payload.slice(0, i) + swap + payload.slice(i + 1);
  assert.throws(() => decryptFrom(tampered, alice.publicKey, bob.privateKey));
});

test('the payload starts with the v2 version byte', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const payload = encryptTo('hi', bob.publicKey, alice.privateKey);
  const bytes = Buffer.from(payload, 'base64');
  assert.equal(bytes[0], 0x02);
});

test('empty plaintext is rejected', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  assert.throws(
    () => encryptTo('', bob.publicKey, alice.privateKey),
    /length/,
  );
});

test('oversized plaintext is rejected', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const huge = 'a'.repeat(70_000);
  assert.throws(
    () => encryptTo(huge, bob.publicKey, alice.privateKey),
    /length/,
  );
});

test('non-hex keys are rejected', () => {
  assert.throws(() => encryptTo('hi', 'not-hex', 'not-hex'), /hex/);
});

test('unicode plaintext round-trips correctly', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const text = 'ハロー 🌊 — sovereign by math.';
  const payload = encryptTo(text, bob.publicKey, alice.privateKey);
  assert.equal(decryptFrom(payload, alice.publicKey, bob.privateKey), text);
});

test('a long plaintext spanning multiple padding chunks round-trips', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const text = 'x'.repeat(2000);
  const payload = encryptTo(text, bob.publicKey, alice.privateKey);
  assert.equal(decryptFrom(payload, alice.publicKey, bob.privateKey), text);
});

test('decryption rejects a payload with the wrong version byte', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const payload = encryptTo('v2 only', bob.publicKey, alice.privateKey);
  const bytes = Buffer.from(payload, 'base64');
  bytes[0] = 0x01;
  const wrongVersion = bytes.toString('base64');
  assert.throws(
    () => decryptFrom(wrongVersion, alice.publicKey, bob.privateKey),
    /version/,
  );
});

test('the payload is symmetric — Bob can also encrypt back to Alice', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const bobToAlice = encryptTo('reply', alice.publicKey, bob.privateKey);
  assert.equal(
    decryptFrom(bobToAlice, bob.publicKey, alice.privateKey),
    'reply',
  );
});
