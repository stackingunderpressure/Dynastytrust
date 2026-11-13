/**
 * Sign-in by attestation -- cross-repo parity gate.
 *
 * The fixture below was generated from the Tapit wallet's REAL tapit-attest
 * source (tapit-wallet/tapit-attest/dist) with a fixed test key, nonce, and
 * timestamps. Its `signature` is a genuine Schnorr signature Tapit produced
 * over the sign-in digest. DynastyTrust's verifySignIn validating that
 * signature is the parity proof: a Schnorr signature only verifies when both
 * sides compute the byte-identical digest, so this passing means Dynasty's
 * canonicalJson + taggedHash agree with Tapit's to the byte. If this test ever
 * fails after a helper change, the two repos' digest computations have
 * diverged and the sign-in bridge is unsafe -- do not ship around it.
 *
 * Test key only. Never a real key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { verifySignIn, buildSignInChallenge, answerSignInChallenge } from '../dist/index.js';

// Golden fixture from Tapit's real source.
const GOLDEN = {
  challenge: {
    v: 1,
    nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    audience: 'dynastytrust.family',
    issuedAt: '2026-06-22T00:00:00.000Z',
    expiresAt: '2026-06-22T00:05:00.000Z',
  },
  attestation: {
    v: 1,
    challenge: {
      v: 1,
      nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      audience: 'dynastytrust.family',
      issuedAt: '2026-06-22T00:00:00.000Z',
      expiresAt: '2026-06-22T00:05:00.000Z',
    },
    signer: '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa',
    issuedAt: '2026-06-22T00:00:30.000Z',
    signature:
      'fdd264c03f68369caa116a200576d6df4ab35dfcb5a56025e04c13c928a5d26678d20a17ba5a6ad64089bff718121d8259a02faf5a6e62c4d93523a7275dcb69',
  },
  // A moment inside the challenge window.
  nowInsideWindowMs: Date.parse('2026-06-22T00:01:00.000Z'),
};

test('PARITY: Dynasty verifies a real Tapit-produced sign-in attestation', () => {
  const res = verifySignIn({
    attestation: GOLDEN.attestation,
    expectedChallenge: GOLDEN.challenge,
    now: GOLDEN.nowInsideWindowMs,
  });
  assert.equal(res.valid, true, res.errors.join('; '));
  assert.equal(res.signer, GOLDEN.attestation.signer);
});

test('rejects an expired challenge (freshness)', () => {
  const res = verifySignIn({
    attestation: GOLDEN.attestation,
    expectedChallenge: GOLDEN.challenge,
    now: Date.parse('2026-06-22T01:00:00.000Z'), // past expiresAt
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('expired')));
});

test('rejects a tampered signature (control)', () => {
  const bad = {
    ...GOLDEN.attestation,
    signature: GOLDEN.attestation.signature.replace(/^fd/, 'fe'),
  };
  const res = verifySignIn({
    attestation: bad,
    expectedChallenge: GOLDEN.challenge,
    now: GOLDEN.nowInsideWindowMs,
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('signature')));
});

test('rejects when the answered challenge does not echo the issued one', () => {
  const otherChallenge = { ...GOLDEN.challenge, nonce: 'b'.repeat(64) };
  const res = verifySignIn({
    attestation: GOLDEN.attestation,
    expectedChallenge: otherChallenge,
    now: GOLDEN.nowInsideWindowMs,
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('echo')));
});

test('round-trips: build a challenge, answer it, verify it', () => {
  const challenge = buildSignInChallenge({
    audience: 'dynastytrust.family',
    nonce: 'c'.repeat(64),
    issuedAt: '2026-06-22T00:00:00.000Z',
  });
  const att = answerSignInChallenge({
    challenge,
    signerPrivateKey: '2'.repeat(64),
    issuedAt: '2026-06-22T00:00:10.000Z',
  });
  const res = verifySignIn({
    attestation: att,
    expectedChallenge: challenge,
    now: Date.parse('2026-06-22T00:01:00.000Z'),
  });
  assert.equal(res.valid, true, res.errors.join('; '));
});

// -- Sign-in number (2026-11-13, threat model item G) --------------------
// Golden fixture generated from the Tapit wallet's REAL source
// (tapit-wallet 2d021b2, tapit-attest/dist) with the same test key, nonce
// and timestamps as GOLDEN above, plus the sign-in number inside the
// signature. Dynasty verifying it is the parity proof for the new field.
import { signInScreenCode } from '../dist/index.js';

const GOLDEN_NUMBERED = {
  code: '27',
  attestation: {
    ...GOLDEN.attestation,
    screenCode: '27',
    signature:
      '9fce060cb496987c3c9eb27ac5e50b02f57b4c3cc52f93c0a8fed29c2215897bfc46bf82c0c50cea22775980a9b849223ab3ea0237e93b9df777679bb9cf6cc1',
  },
};

test('PARITY: the sign-in number is the same number Tapit computes', () => {
  assert.equal(signInScreenCode(GOLDEN.challenge), GOLDEN_NUMBERED.code);
  assert.equal(signInScreenCode({ nonce: '00'.repeat(32) }), '36'); // Tapit's own known answer
});

test('PARITY: Dynasty verifies a real Tapit-made numbered proof, also when the number is required', () => {
  const res = verifySignIn({ attestation: GOLDEN_NUMBERED.attestation, expectedChallenge: GOLDEN.challenge, now: GOLDEN.nowInsideWindowMs, requireScreenCode: true });
  assert.equal(res.valid, true, res.errors.join('; '));
});

test('a proof without the number is refused when the number is required', () => {
  const res = verifySignIn({ attestation: GOLDEN.attestation, expectedChallenge: GOLDEN.challenge, now: GOLDEN.nowInsideWindowMs, requireScreenCode: true });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('number missing')));
});

test('the number cannot be added or changed after signing', () => {
  for (const screenCode of ['27', '28']) {
    const res = verifySignIn({ attestation: { ...GOLDEN.attestation, screenCode }, expectedChallenge: GOLDEN.challenge, now: GOLDEN.nowInsideWindowMs, requireScreenCode: true });
    assert.equal(res.valid, false, `accepted an added number ${screenCode}`);
  }
  const changed = { ...GOLDEN_NUMBERED.attestation, screenCode: '28' };
  assert.equal(verifySignIn({ attestation: changed, expectedChallenge: GOLDEN.challenge, now: GOLDEN.nowInsideWindowMs }).valid, false);
});
