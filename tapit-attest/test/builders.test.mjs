import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identityAttestation,
  relationshipAttestation,
  credentialAttestation,
  predictionAttestation,
  agreementAttestation,
  journalAttestation,
  metaAttestation,
} from '../dist/index.js';

test('each builder stamps its kind onto one shared envelope shape', () => {
  const cases = [
    [identityAttestation, 'identity'],
    [relationshipAttestation, 'relationship'],
    [credentialAttestation, 'credential'],
    [predictionAttestation, 'prediction'],
    [agreementAttestation, 'agreement'],
    [journalAttestation, 'journal'],
    [metaAttestation, 'meta'],
  ];
  for (const [build, kind] of cases) {
    const a = build({ subject: 'did:example:ada', tier: 'routine', fields: { x: 1 } });
    assert.equal(a.kind, kind);
    assert.equal(a.v, 1);
    assert.equal(a.claim.node, 'branch');
    assert.deepEqual(a.signatures, []);
  }
});
