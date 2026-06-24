import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  Wallet,
  verifySignature,
} from '../dist/index.js';

// Wallet's peer-encryption + low-level signing seams. These are the
// methods the tapit-wallet's peer-transport layer calls so the
// Wallet's private key never crosses the Wallet boundary — D-03.

test('signDigest produces a signature that verifies under the active key', () => {
  const wallet = Wallet.generate();
  const digest = createHash('sha256').update('hello digest').digest();
  const sig = wallet.signDigest(new Uint8Array(digest));
  assert.equal(typeof sig, 'string');
  assert.equal(sig.length, 128); // 64 bytes hex
  assert.ok(verifySignature(new Uint8Array(digest), sig, wallet.publicKey));
});

test('signDigest rejects a digest that is not 32 bytes', () => {
  const wallet = Wallet.generate();
  assert.throws(() => wallet.signDigest(new Uint8Array(16)), /32 bytes/);
});

test('nip44 round-trips a plaintext between two wallets', () => {
  const alice = Wallet.generate();
  const bob = Wallet.generate();
  const payload = alice.nip44EncryptTo('hello bob', bob.publicKey);
  const out = bob.nip44DecryptFrom(payload, alice.publicKey);
  assert.equal(out, 'hello bob');
});

test('nip44 decryption fails when a third party tries to read', () => {
  const alice = Wallet.generate();
  const bob = Wallet.generate();
  const eve = Wallet.generate();
  const payload = alice.nip44EncryptTo('only for bob', bob.publicKey);
  assert.throws(() => eve.nip44DecryptFrom(payload, alice.publicKey), /MAC/);
});

test('nip44 decryption fails when the wrong sender pubkey is named', () => {
  const alice = Wallet.generate();
  const bob = Wallet.generate();
  const mallory = Wallet.generate();
  const payload = alice.nip44EncryptTo('from alice', bob.publicKey);
  assert.throws(() => bob.nip44DecryptFrom(payload, mallory.publicKey), /MAC/);
});

test('Wallet has no public privateKey or keypair getter', () => {
  const wallet = Wallet.generate();
  assert.equal(wallet.privateKey, undefined);
  assert.equal(wallet.keypair, undefined);
});
