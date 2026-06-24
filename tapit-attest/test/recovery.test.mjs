import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeypair,
  signEnvelope,
  relationshipAttestation,
  toRecord,
  MemoryStore,
  buildRecoveryRequest,
  verifyRecoveryRequest,
  buildRecoveryResponse,
  verifyRecoveryResponse,
  rebuildFromResponses,
} from '../dist/index.js';

const subject = 'did:example:ada';

// A peer holds an attestation that vouches for `subject`.
const peerStore = async () => {
  const store = new MemoryStore();
  const peer = generateKeypair();
  const attestation = signEnvelope(
    relationshipAttestation({ subject, tier: 'routine', fields: { visits: 12 } }),
    peer.privateKey,
  );
  await store.put(toRecord(attestation));
  return { store, peer };
};

test('a recovery request is signed and verifies', () => {
  const requester = generateKeypair();
  const request = buildRecoveryRequest({ subject, requesterPrivateKey: requester.privateKey });
  assert.equal(request.requester, requester.publicKey);
  assert.equal(verifyRecoveryRequest(request), true);
  assert.equal(verifyRecoveryRequest({ ...request, subject: 'did:example:impostor' }), false);
});

test('a peer responds with the attestations it holds for the subject', async () => {
  const { store, peer } = await peerStore();
  const requester = generateKeypair();
  const request = buildRecoveryRequest({ subject, requesterPrivateKey: requester.privateKey });
  const response = await buildRecoveryResponse({
    request,
    store,
    responderPrivateKey: peer.privateKey,
  });
  const result = verifyRecoveryResponse(response);
  assert.equal(result.valid, true);
  assert.equal(result.attestations.length, 1);
  assert.equal(result.attestations[0].subject, subject);
});

test('rebuildFromResponses reassembles a trustless wallet from peers', async () => {
  const { store, peer } = await peerStore();
  const requester = generateKeypair();
  const request = buildRecoveryRequest({ subject, requesterPrivateKey: requester.privateKey });
  const response = await buildRecoveryResponse({
    request,
    store,
    responderPrivateKey: peer.privateKey,
  });
  const rebuilt = await rebuildFromResponses([response]);
  assert.equal(rebuilt.attestations.length, 1);
  assert.equal((await rebuilt.store.bySubject(subject)).length, 1);
  assert.deepEqual(rebuilt.errors, []);
});

test('a tampered attestation in a response is dropped, not trusted', async () => {
  const { store, peer } = await peerStore();
  const requester = generateKeypair();
  const request = buildRecoveryRequest({ subject, requesterPrivateKey: requester.privateKey });
  const response = await buildRecoveryResponse({
    request,
    store,
    responderPrivateKey: peer.privateKey,
  });
  response.attestations[0] = { ...response.attestations[0], subject: 'did:example:impostor' };
  const result = verifyRecoveryResponse(response);
  assert.equal(result.attestations.length, 0);
  assert.ok(result.errors.some((e) => e.includes('tampered')));
});
