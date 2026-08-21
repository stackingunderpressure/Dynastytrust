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

function attestationWithKeypair(tier) {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject: 's', tier, fields: { k: 1 } });
  return { kp, env: signEnvelope(draft, kp.privateKey) };
}

test('a fresh attestation is pending', () => {
  const { kp, env } = attestationWithKeypair('routine');
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt, [kp.publicKey]);
  assert.equal(ledger.statusOf(id, new Date(env.issuedAt)), 'pending');
});

test('pending becomes final after the finality window', () => {
  const { kp, env } = attestationWithKeypair('routine'); // routine window = 1 hour
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt, [kp.publicKey]);
  const later = new Date(Date.parse(env.issuedAt) + 2 * 3_600_000);
  assert.equal(ledger.statusOf(id, later), 'final');
});

test('an authorized revoker (the attestation\'s own signer) can void it within the window', () => {
  const { kp, env } = attestationWithKeypair('high_stakes'); // long window
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt, [kp.publicKey]);

  const revocation = createRevocation({
    targetId: id,
    subject: env.subject,
    privateKey: kp.privateKey,
    reason: 'key compromised',
  });
  assert.equal(revocationTarget(revocation), id);

  const now = new Date(Date.parse(env.issuedAt) + 1000);
  assert.equal(ledger.applyRevocation(revocation, now), 'void');
  assert.equal(ledger.statusOf(id, now), 'void');
});

test('a revocation signed by a key with no standing is rejected, not voided', () => {
  const { kp, env } = attestationWithKeypair('high_stakes');
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt, [kp.publicKey]);

  const attacker = generateKeypair();
  const revocation = createRevocation({
    targetId: id,
    subject: env.subject,
    privateKey: attacker.privateKey,
    reason: 'forged revocation',
  });

  const now = new Date(Date.parse(env.issuedAt) + 1000);
  assert.throws(() => ledger.applyRevocation(revocation, now));
  assert.equal(ledger.statusOf(id, now), 'pending');
});

test('a final attestation cannot be revoked', () => {
  const { kp, env } = attestationWithKeypair('routine');
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt, [kp.publicKey]);

  const revocation = createRevocation({
    targetId: id,
    subject: env.subject,
    privateKey: kp.privateKey,
  });
  const tooLate = new Date(Date.parse(env.issuedAt) + 10 * 3_600_000);
  assert.throws(() => ledger.applyRevocation(revocation, tooLate));
});

test('registering with no authorized revokers is rejected', () => {
  const { env } = attestationWithKeypair('routine');
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  assert.throws(() => ledger.register(id, env.tier, env.issuedAt, []));
});

test('idsByStatus partitions the ledger', () => {
  const { kp, env } = attestationWithKeypair('high_stakes');
  const id = envelopeId(env);
  const ledger = new RevocationLedger();
  ledger.register(id, env.tier, env.issuedAt, [kp.publicKey]);
  const now = new Date(Date.parse(env.issuedAt) + 1000);
  assert.deepEqual(ledger.idsByStatus('pending', now), [id]);
  assert.deepEqual(ledger.idsByStatus('void', now), []);
});
