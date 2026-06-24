import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeypair,
  signEnvelope,
  relationshipAttestation,
  computeWeight,
  advancedWeighting,
} from '../dist/index.js';

const subject = 'did:example:ada';
const voucher = (key, n) =>
  signEnvelope(
    relationshipAttestation({ subject, tier: 'routine', fields: { visit: n } }),
    key,
  );

test('computeWeight sums the weight of distinct verified signers', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  const attestations = [voucher(a.privateKey, 1), voucher(b.privateKey, 2)];
  const weight = computeWeight({
    subject,
    attestations,
    signerWeights: { [a.publicKey]: 5, [b.publicKey]: 3 },
  });
  assert.equal(weight, 8);
});

test('a signer is counted once no matter how many times they vouch', () => {
  const a = generateKeypair();
  const attestations = [voucher(a.privateKey, 1), voucher(a.privateKey, 2)];
  const weight = computeWeight({
    subject,
    attestations,
    signerWeights: { [a.publicKey]: 5 },
  });
  assert.equal(weight, 5);
});

test('attestations about a different subject are ignored', () => {
  const a = generateKeypair();
  const weight = computeWeight({
    subject: 'did:example:other',
    attestations: [voucher(a.privateKey, 1)],
    signerWeights: { [a.publicKey]: 5 },
  });
  assert.equal(weight, 0);
});

test('a tampered attestation contributes no weight by default', () => {
  const a = generateKeypair();
  const tampered = { ...voucher(a.privateKey, 1), subject };
  tampered.issuedAt = '1999-01-01T00:00:00.000Z';
  const weight = computeWeight({
    subject,
    attestations: [tampered],
    signerWeights: { [a.publicKey]: 5 },
  });
  assert.equal(weight, 0);
});

test('advancedWeighting is a v1.1 slot and throws', () => {
  assert.throws(() => advancedWeighting({}), /v1\.1 slot/);
});
