import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIERS,
  tierConfig,
  evaluateTier,
  generateKeypair,
  signEnvelope,
  credentialAttestation,
} from '../dist/index.js';

const issuedAt = '2026-05-18T00:00:00.000Z';
const draft = (tier) =>
  credentialAttestation({ subject: 'did:example:ada', tier, fields: { award: 'gold' }, issuedAt });

test('DEFAULT_TIERS exposes all three tiers as configuration dials', () => {
  assert.ok(DEFAULT_TIERS.routine && DEFAULT_TIERS.notable && DEFAULT_TIERS.high_stakes);
  assert.equal(tierConfig('high_stakes').requiredSigners, 3);
  assert.equal(tierConfig('routine', { requiredSigners: 9 }).requiredSigners, 9);
});

test('a routine attestation is pending inside its window and final after it', () => {
  const signed = signEnvelope(draft('routine'), generateKeypair().privateKey);
  const within = evaluateTier(signed, { now: Date.parse(issuedAt) + 1000 });
  assert.equal(within.status, 'pending');
  const after = evaluateTier(signed, { now: Date.parse(issuedAt) + 2 * 86_400_000 });
  assert.equal(after.status, 'final');
});

test('a notable attestation is insufficient without a co-signer', () => {
  const signed = signEnvelope(draft('notable'), generateKeypair().privateKey);
  const result = evaluateTier(signed, { now: Date.parse(issuedAt) + 999 * 86_400_000 });
  assert.equal(result.status, 'insufficient');
  assert.equal(result.distinctSigners, 1);
});

test('a notable attestation needs summed signer weight to clear', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  const signed = signEnvelope(signEnvelope(draft('notable'), a.privateKey), b.privateKey);
  const now = Date.parse(issuedAt) + 999 * 86_400_000;
  const tooLight = evaluateTier(signed, { now, signerWeights: { [a.publicKey]: 1, [b.publicKey]: 1 } });
  assert.equal(tooLight.status, 'insufficient');
  const enough = evaluateTier(signed, { now, signerWeights: { [a.publicKey]: 6, [b.publicKey]: 6 } });
  assert.equal(enough.status, 'final');
});
