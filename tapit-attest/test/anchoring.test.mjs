import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MockOtsProvider,
  anchorAttestation,
  refreshAnchor,
  verifyAnchor,
  generateKeypair,
  signEnvelope,
  predictionAttestation,
} from '../dist/index.js';

const signed = () =>
  signEnvelope(
    predictionAttestation({
      subject: 'did:example:ada',
      tier: 'routine',
      fields: { outcome: 'eclipse-2027' },
    }),
    generateKeypair().privateKey,
  );

test('anchoring attaches a pending anchor that verifies', async () => {
  const provider = new MockOtsProvider();
  const anchored = await anchorAttestation(signed(), provider);
  assert.equal(anchored.anchor.provider, 'mock');
  assert.equal(anchored.anchor.status, 'pending');
  const result = await verifyAnchor(anchored, provider);
  assert.equal(result.valid, true);
});

test('refreshAnchor upgrades a pending anchor to confirmed', async () => {
  const provider = new MockOtsProvider();
  const anchored = await anchorAttestation(signed(), provider);
  const refreshed = await refreshAnchor(anchored, provider);
  assert.equal(refreshed.anchor.status, 'confirmed');
  assert.equal(typeof refreshed.anchor.btcHeight, 'number');
});

test('confirmImmediately yields a confirmed anchor on the first stamp', async () => {
  const provider = new MockOtsProvider({ confirmImmediately: true });
  const anchored = await anchorAttestation(signed(), provider);
  assert.equal(anchored.anchor.status, 'confirmed');
});

test('tampering after anchoring is caught by verifyAnchor', async () => {
  const provider = new MockOtsProvider();
  const anchored = await anchorAttestation(signed(), provider);
  const tampered = { ...anchored, subject: 'did:example:impostor' };
  const result = await verifyAnchor(tampered, provider);
  assert.equal(result.valid, false);
});

test('verifyAnchor reports when an attestation has no anchor', async () => {
  const result = await verifyAnchor(signed(), new MockOtsProvider());
  assert.equal(result.valid, false);
  assert.match(result.reason, /no anchor/);
});
