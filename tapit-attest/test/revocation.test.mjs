/** Revocation state machine: pending -> final, pending -> void. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateKeypair,
  identityAttestation,
  signEnvelope,
  envelopeId,
  createRevocation,
  revocationTarget,
  RevocationLedger,
} from '../dist/index.js';

function attestation(tier) {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject: 's', tier, fields: { k: 1 } });
  return signEnvelope(draft, kp.privateKey);
}

test('a fresh attestation is pending', () => {
  const env = attestation('routine');
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt);
  assert.equal(ledger.statusOf(id, new Date(env.issuedAt)), 'pending');
});

test('pending becomes final after the finality window', () => {
  const env = attestation('routine'); // routine window = 1 hour
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt);
  const later = new Date(Date.parse(env.issuedAt) + 2 * 3_600_000);
  assert.equal(ledger.statusOf(id, later), 'final');
});

test('a revocation within the window voids the attestation', () => {
  const env = attestation('high_stakes'); // long window
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt);

  const revoker = generateKeypair();
  const revocation = createRevocation({
    targetId: id,
    subject: env.subject,
    privateKey: revoker.privateKey,
    reason: 'key compromised',
  });
  assert.equal(revocationTarget(revocation), id);

  const now = new Date(Date.parse(env.issuedAt) + 1000);
  assert.equal(ledger.applyRevocation(revocation, now), 'void');
  assert.equal(ledger.statusOf(id, now), 'void');
});

test('a final attestation cannot be revoked', () => {
  const env = attestation('routine');
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt);

  const revoker = generateKeypair();
  const revocation = createRevocation({
    targetId: id,
    subject: env.subject,
    privateKey: revoker.privateKey,
  });
  const tooLate = new Date(Date.parse(env.issuedAt) + 10 * 3_600_000);
  assert.throws(() => ledger.applyRevocation(revocation, tooLate));
});

test('idsByStatus partitions the ledger', () => {
  const env = attestation('high_stakes');
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt);
  const now = new Date(Date.parse(env.issuedAt) + 1000);
  assert.deepEqual(ledger.idsByStatus('pending', now), [id]);
  assert.deepEqual(ledger.idsByStatus('void', now), []);
});
