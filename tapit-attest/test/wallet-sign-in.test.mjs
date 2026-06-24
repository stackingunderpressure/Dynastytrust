import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, buildSignInChallenge, verifySignIn } from '../dist/index.js';

const audience = 'dynastytrust.family';

test('Wallet.signIn answers a challenge with the active key and verifies', () => {
  const w = Wallet.generate();
  const challenge = buildSignInChallenge({ audience, ttlSeconds: 300 });
  const attestation = w.signIn(challenge);

  assert.equal(attestation.signer, w.publicKey);
  const result = verifySignIn({ attestation, expectedChallenge: challenge });
  assert.equal(result.valid, true);
  assert.equal(result.signer, w.publicKey);
  assert.deepEqual(result.errors, []);
});

test('Wallet.signIn proof fails against a different challenge (anti-replay)', () => {
  const w = Wallet.generate();
  const issued = buildSignInChallenge({ audience, ttlSeconds: 300 });
  const attestation = w.signIn(issued);
  // A verifier checking against some OTHER challenge must reject the echo.
  const other = buildSignInChallenge({ audience, ttlSeconds: 300 });
  const result = verifySignIn({ attestation, expectedChallenge: other });
  assert.equal(result.valid, false);
  assert.equal(result.signer, null);
});

test('Wallet.signIn proof from one wallet does not verify as another key', () => {
  const a = Wallet.generate();
  const b = Wallet.generate();
  const challenge = buildSignInChallenge({ audience, ttlSeconds: 300 });
  const attestation = a.signIn(challenge);
  // The proven signer is wallet A's key, never B's.
  const result = verifySignIn({ attestation, expectedChallenge: challenge });
  assert.equal(result.valid, true);
  assert.notEqual(result.signer, b.publicKey);
  assert.equal(result.signer, a.publicKey);
});
