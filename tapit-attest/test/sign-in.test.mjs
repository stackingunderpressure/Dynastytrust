import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeypair,
  buildSignInChallenge,
  answerSignInChallenge,
  verifySignIn,
} from '../dist/index.js';

const audience = 'tapit-wallet.app';

test('a fresh challenge carries a 32-byte nonce and a future expiry', () => {
  const challenge = buildSignInChallenge({ audience, ttlSeconds: 300 });
  assert.equal(challenge.v, 1);
  assert.equal(challenge.audience, audience);
  assert.match(challenge.nonce, /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(challenge.expiresAt) > Date.parse(challenge.issuedAt));
});

test('two challenges minted back to back have different nonces', () => {
  const a = buildSignInChallenge({ audience });
  const b = buildSignInChallenge({ audience });
  assert.notEqual(a.nonce, b.nonce);
});

test('a signed challenge verifies for the holder key', () => {
  const holder = generateKeypair();
  const challenge = buildSignInChallenge({ audience });
  const attestation = answerSignInChallenge({
    challenge,
    signerPrivateKey: holder.privateKey,
  });
  assert.equal(attestation.signer, holder.publicKey);
  const result = verifySignIn({ attestation, expectedChallenge: challenge });
  assert.equal(result.valid, true);
  assert.equal(result.signer, holder.publicKey);
  assert.deepEqual(result.errors, []);
});

test('an answer to a different challenge is rejected (echo check)', () => {
  const holder = generateKeypair();
  const issued = buildSignInChallenge({ audience });
  const other = buildSignInChallenge({ audience });
  // Holder signs `other`, but the verifier expects `issued`.
  const attestation = answerSignInChallenge({
    challenge: other,
    signerPrivateKey: holder.privateKey,
  });
  const result = verifySignIn({ attestation, expectedChallenge: issued });
  assert.equal(result.valid, false);
  assert.equal(result.signer, null);
  assert.ok(result.errors.some((e) => e.includes('echo')));
});

test('a tampered challenge field breaks the signature and the echo', () => {
  const holder = generateKeypair();
  const challenge = buildSignInChallenge({ audience });
  const attestation = answerSignInChallenge({
    challenge,
    signerPrivateKey: holder.privateKey,
  });
  // Flip the audience inside the signed attestation after the fact.
  attestation.challenge = { ...attestation.challenge, audience: 'evil.app' };
  const result = verifySignIn({ attestation, expectedChallenge: challenge });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('echo')));
  assert.ok(result.errors.some((e) => e.includes('signature')));
});

test('an expired challenge is rejected even with a valid signature', () => {
  const holder = generateKeypair();
  const issuedAt = new Date('2020-01-01T00:00:00.000Z').toISOString();
  const challenge = buildSignInChallenge({ audience, ttlSeconds: 60, issuedAt });
  const attestation = answerSignInChallenge({
    challenge,
    signerPrivateKey: holder.privateKey,
  });
  // `now` well past the 60s window.
  const result = verifySignIn({
    attestation,
    expectedChallenge: challenge,
    now: Date.parse('2020-01-01T01:00:00.000Z'),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('expired')));
});

test('a challenge still inside its window passes the freshness check', () => {
  const holder = generateKeypair();
  const issuedAt = new Date('2020-01-01T00:00:00.000Z').toISOString();
  const challenge = buildSignInChallenge({ audience, ttlSeconds: 300, issuedAt });
  const attestation = answerSignInChallenge({
    challenge,
    signerPrivateKey: holder.privateKey,
  });
  const result = verifySignIn({
    attestation,
    expectedChallenge: challenge,
    now: Date.parse('2020-01-01T00:02:00.000Z'),
  });
  assert.equal(result.valid, true);
});

test('a wrong-key signature does not verify', () => {
  const holder = generateKeypair();
  const challenge = buildSignInChallenge({ audience });
  const attestation = answerSignInChallenge({
    challenge,
    signerPrivateKey: holder.privateKey,
  });
  // Swap in an unrelated signer key; the signature no longer matches.
  const impostor = generateKeypair();
  attestation.signer = impostor.publicKey;
  const result = verifySignIn({ attestation, expectedChallenge: challenge });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('signature')));
});

test('builders reject malformed input', () => {
  assert.throws(() => buildSignInChallenge({ audience: '' }), /audience/);
  assert.throws(() => buildSignInChallenge({ audience, ttlSeconds: 0 }), /ttlSeconds/);
  assert.throws(() => buildSignInChallenge({ audience, nonce: 'xyz' }), /nonce/);
  const challenge = buildSignInChallenge({ audience });
  assert.throws(
    () => answerSignInChallenge({ challenge, signerPrivateKey: 'nothex' }),
    /signerPrivateKey/,
  );
});
