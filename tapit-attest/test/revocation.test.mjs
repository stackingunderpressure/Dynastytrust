import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeypair,
  signEnvelope,
  credentialAttestation,
  envelopeId,
  createRevocation,
  isRevocation,
  verifyEnvelope,
  RevocationLedger,
  repudiate,
} from '../dist/index.js';

const targetId = () => {
  const signed = signEnvelope(
    credentialAttestation({ subject: 'did:example:ada', tier: 'routine', fields: { x: 1 } }),
    generateKeypair().privateKey,
  );
  return envelopeId(signed);
};

test('a revocation is a signed meta attestation', () => {
  const revocation = createRevocation({
    targetId: targetId(),
    reason: 'issued in error',
    revokerPrivateKey: generateKeypair().privateKey,
  });
  assert.equal(revocation.kind, 'meta');
  assert.equal(isRevocation(revocation), true);
  assert.equal(verifyEnvelope(revocation).valid, true);
});

test('the ledger tracks pending → final and reports a target as revoked', () => {
  const id = targetId();
  const ledger = new RevocationLedger();
  const revocation = createRevocation({
    targetId: id,
    reason: 'superseded',
    revokerPrivateKey: generateKeypair().privateKey,
  });
  const revId = ledger.record(revocation);
  assert.equal(ledger.revocationState(revId), 'pending');
  assert.equal(ledger.isRevoked(id), true);
  ledger.finalize(revId);
  assert.equal(ledger.revocationState(revId), 'final');
  assert.equal(ledger.targetState(id), 'final');
});

test('voiding a revocation clears the target', () => {
  const id = targetId();
  const ledger = new RevocationLedger();
  const revId = ledger.record(
    createRevocation({
      targetId: id,
      reason: 'withdrawn',
      revokerPrivateKey: generateKeypair().privateKey,
    }),
  );
  ledger.void(revId);
  assert.equal(ledger.revocationState(revId), 'void');
  assert.equal(ledger.isRevoked(id), false);
  assert.throws(() => ledger.finalize(revId), /void/);
});

test('the ledger rejects a non-revocation attestation', () => {
  const ledger = new RevocationLedger();
  const notRevocation = signEnvelope(
    credentialAttestation({ subject: 'x', tier: 'routine', fields: {} }),
    generateKeypair().privateKey,
  );
  assert.throws(() => ledger.record(notRevocation), /not a revocation/);
});

test('repudiate is a v1.1 slot and throws', () => {
  assert.throws(() => repudiate(), /v1\.1 slot/);
});
