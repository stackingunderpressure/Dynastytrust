/**
 * Liveness (green / no-report / red) -- cross-repo parity gate.
 *
 * The fixtures below were generated from the Tapit wallet's REAL tapit-attest
 * source (tapit-wallet/tapit-attest/dist) with fixed test keys (alice
 * priv = 11..1, bob priv = 22..2) and fixed timestamps. Their `signature`
 * fields are genuine Schnorr signatures Tapit produced over the proof-of-life
 * and duress-flag digests. DynastyTrust's verifyProofOfLife / verifyDuressFlag
 * validating those signatures is the parity proof: a Schnorr signature only
 * verifies when both sides compute the byte-identical digest, so this passing
 * means Dynasty's canonicalJson + taggedHash agree with Tapit's to the byte.
 * If these PARITY tests ever fail after a helper change, the two repos' digest
 * computations have diverged and the liveness bridge is unsafe -- do not ship
 * around it.
 *
 * Test keys only. Never a real key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyProofOfLife,
  verifyDuressFlag,
  livenessStateFor,
  meetsGreenQuorum,
  buildProofOfLife,
  buildDuressFlag,
} from '../dist/index.js';

const ALICE = '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
const BOB = '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27';

// Golden green heartbeat from Tapit's real source (subject = alice).
const GOLDEN_POL = {
  v: 1,
  kind: 'proof-of-life',
  subject: ALICE,
  issuedAt: '2026-06-22T00:00:00.000Z',
  signature:
    'ce08182c1eb950c6294c059092f9613834ed61d74168ca8667a31c9de4ad9b50af340f64fb7d074dd022cf1bd957df920e233e09b36955dbfbf72ac4560c03b5',
};

// Golden red flag from Tapit's real source (subject = alice, raisedBy = bob).
const GOLDEN_RED = {
  v: 1,
  kind: 'duress-flag',
  subject: ALICE,
  raisedBy: BOB,
  issuedAt: '2026-06-22T00:00:30.000Z',
  signature:
    'f5accb0c8d521c7031d09cc867d920b7b0cc15b5023734dc658d280c1a15a4d9dde35e2170be36ed6f1c96594ccf1233fea0741b71a7c2edce2b1de62295199a',
};

// A moment one minute after both fixtures were issued.
const NOW = Date.parse('2026-06-22T00:01:00.000Z');
const ONE_YEAR = 31536000;

test('PARITY: Dynasty verifies a real Tapit-produced proof-of-life', () => {
  assert.equal(verifyProofOfLife(GOLDEN_POL), true);
});

test('PARITY: Dynasty verifies a real Tapit-produced duress flag', () => {
  assert.equal(verifyDuressFlag(GOLDEN_RED), true);
});

test('PARITY tally: fresh PoL, no flags -> green', () => {
  const state = livenessStateFor({
    subject: ALICE,
    group: [BOB],
    proofOfLife: GOLDEN_POL,
    redFlags: [],
    ttlSeconds: ONE_YEAR,
    now: NOW,
  });
  assert.equal(state, 'green');
});

test('PARITY tally: red flag from an in-group peer dominates -> red', () => {
  const state = livenessStateFor({
    subject: ALICE,
    group: [BOB],
    proofOfLife: GOLDEN_POL,
    redFlags: [GOLDEN_RED],
    ttlSeconds: ONE_YEAR,
    now: NOW,
  });
  assert.equal(state, 'red');
});

test('PARITY tally: no-rogue -- red from a peer not in the group is ignored -> green', () => {
  const state = livenessStateFor({
    subject: ALICE,
    group: [], // Bob is not in the chosen group
    proofOfLife: GOLDEN_POL,
    redFlags: [GOLDEN_RED],
    ttlSeconds: ONE_YEAR,
    now: NOW,
  });
  assert.equal(state, 'green');
});

test('rejects a tampered proof-of-life signature', () => {
  const tampered = {
    ...GOLDEN_POL,
    // flip the first byte: ce -> cf
    signature: 'cf' + GOLDEN_POL.signature.slice(2),
  };
  assert.equal(verifyProofOfLife(tampered), false);
});

test('meetsGreenQuorum: three green, m=3 -> true', () => {
  assert.equal(meetsGreenQuorum(['green', 'green', 'green'], 3), true);
});

test('meetsGreenQuorum: a single red blocks the quorum -> false', () => {
  assert.equal(meetsGreenQuorum(['green', 'green', 'red'], 2), false);
});

test('meetsGreenQuorum: two green, m=3 -> false', () => {
  assert.equal(meetsGreenQuorum(['green', 'green', 'no-report'], 3), false);
});

test('build + verify round-trip with a local test key (own minting works)', () => {
  const priv = '3'.repeat(64);
  const pol = buildProofOfLife({
    signerPrivateKey: priv,
    issuedAt: '2026-06-22T00:00:00.000Z',
  });
  assert.equal(verifyProofOfLife(pol), true);

  const red = buildDuressFlag({
    subject: pol.subject,
    signerPrivateKey: priv,
    issuedAt: '2026-06-22T00:00:30.000Z',
  });
  assert.equal(verifyDuressFlag(red), true);

  // The self-signed heartbeat tallies green; the self-duress flag flips red.
  assert.equal(
    livenessStateFor({
      subject: pol.subject,
      group: [],
      proofOfLife: pol,
      redFlags: [],
      ttlSeconds: ONE_YEAR,
      now: Date.parse('2026-06-22T00:01:00.000Z'),
    }),
    'green',
  );
  assert.equal(
    livenessStateFor({
      subject: pol.subject,
      group: [],
      proofOfLife: pol,
      redFlags: [red],
      ttlSeconds: ONE_YEAR,
      now: Date.parse('2026-06-22T00:01:00.000Z'),
    }),
    'red',
  );
});
