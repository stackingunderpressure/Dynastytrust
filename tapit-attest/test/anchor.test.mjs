/** Anchor / verifyAnchor round-trips with the deterministic mock provider. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  identityAttestation,
  signEnvelope,
  generateKeypair,
  anchorAttestation,
  refreshAnchor,
  verifyAnchor,
  MockOtsProvider,
} from '../dist/index.js';

function fixture() {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject: 's', tier: 'routine', fields: { k: 1 } });
  return signEnvelope(draft, kp.privateKey);
}

test('anchorAttestation attaches a pending anchor', async () => {
  const provider = new MockOtsProvider();
  const anchored = await anchorAttestation(fixture(), provider);
  assert.equal(anchored.anchor.type, 'opentimestamps');
  assert.equal(anchored.anchor.status, 'pending');
  assert.notEqual(anchored.anchor.proof, null);
});

test('verifyAnchor confirms a genuine anchor', async () => {
  const provider = new MockOtsProvider();
  const anchored = await anchorAttestation(fixture(), provider);
  const result = await verifyAnchor(anchored, provider);
  assert.equal(result.present, true);
  assert.equal(result.valid, true);
});

test('refreshAnchor completes the anchor with a block height', async () => {
  const provider = new MockOtsProvider(900_000);
  const anchored = await anchorAttestation(fixture(), provider);
  const refreshed = await refreshAnchor(anchored, provider);
  assert.equal(refreshed.anchor.status, 'complete');
  assert.equal(refreshed.anchor.bitcoinHeight, 900_000);
});

test('verifyAnchor rejects an anchor whose digest was swapped', async () => {
  const provider = new MockOtsProvider();
  const anchored = await anchorAttestation(fixture(), provider);
  const tampered = {
    ...anchored,
    anchor: { ...anchored.anchor, digest: '0'.repeat(64) },
  };
  const result = await verifyAnchor(tampered, provider);
  assert.equal(result.valid, false);
});

test('verifyAnchor reports absence cleanly', async () => {
  const result = await verifyAnchor(fixture(), new MockOtsProvider());
  assert.equal(result.present, false);
  assert.equal(result.valid, false);
});
