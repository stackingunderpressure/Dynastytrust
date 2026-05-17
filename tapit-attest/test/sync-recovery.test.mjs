/** Storage-agnostic sync + peer-rebuild recovery foundations. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateKeypair,
  identityAttestation,
  signEnvelope,
  treeFromObject,
  toRecord,
  loadVerified,
  MemoryStore,
  SyncEngine,
  buildRecoveryRequest,
  verifyRecoveryRequest,
  buildRecoveryResponse,
  verifyRecoveryResponse,
  rebuildFromResponses,
} from '../dist/index.js';

function signedFor(subject) {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject, tier: 'routine', fields: { k: 1 } });
  return signEnvelope(draft, kp.privateKey);
}

test('loadVerified returns a genuine record', async () => {
  const store = new MemoryStore();
  const record = toRecord(signedFor('s'));
  await store.put(record);
  const loaded = await loadVerified(store, record.id);
  assert.ok(loaded);
  assert.equal(loaded.id, record.id);
});

test('loadVerified rejects a record with a tampered claim', async () => {
  const store = new MemoryStore();
  const record = toRecord(signedFor('s'));
  const forged = {
    ...record,
    envelope: { ...record.envelope, claim: treeFromObject('claim', { k: 999 }) },
  };
  await store.put(forged);
  assert.equal(await loadVerified(store, record.id), null);
});

test('SyncEngine copies records both directions', async () => {
  const local = new MemoryStore();
  const remote = new MemoryStore();
  await local.put(toRecord(signedFor('local-1')));
  await remote.put(toRecord(signedFor('remote-1')));

  const report = await new SyncEngine(local, remote).sync();
  assert.equal(report.pushed, 1);
  assert.equal(report.pulled, 1);
  assert.equal((await local.list()).length, 2);
  assert.equal((await remote.list()).length, 2);
});

test('recovery request signs and verifies', () => {
  const kp = generateKeypair();
  const req = buildRecoveryRequest({ subject: 'did:example:me', privateKey: kp.privateKey });
  assert.equal(req.requester, kp.publicKey);
  assert.equal(verifyRecoveryRequest(req), true);
});

test('a tampered recovery request fails verification', () => {
  const kp = generateKeypair();
  const req = buildRecoveryRequest({ subject: 'real', privateKey: kp.privateKey });
  assert.equal(verifyRecoveryRequest({ ...req, subject: 'forged' }), false);
});

test('recovery response is bound to its request by nonce', async () => {
  const me = generateKeypair();
  const peer = generateKeypair();
  const subject = 'did:example:me';
  const req = buildRecoveryRequest({ subject, privateKey: me.privateKey });

  const records = [toRecord(signedFor(subject)), toRecord(signedFor(subject))];
  const res = buildRecoveryResponse({ request: req, records, privateKey: peer.privateKey });

  const result = await verifyRecoveryResponse(req, res);
  assert.equal(result.valid, true);
  assert.equal(result.verifiedRecords.length, 2);
  assert.equal(result.rejected.length, 0);
});

test('a response with a mismatched nonce is rejected', async () => {
  const me = generateKeypair();
  const peer = generateKeypair();
  const req = buildRecoveryRequest({ subject: 's', privateKey: me.privateKey });
  const res = buildRecoveryResponse({ request: req, records: [], privateKey: peer.privateKey });
  const forged = { ...res, nonce: 'ff'.repeat(16) };
  const result = await verifyRecoveryResponse(req, forged);
  assert.equal(result.valid, false);
});

test('peer rebuild de-duplicates verified records', async () => {
  const me = generateKeypair();
  const peerA = generateKeypair();
  const peerB = generateKeypair();
  const subject = 'did:example:me';
  const req = buildRecoveryRequest({ subject, privateKey: me.privateKey });

  const shared = toRecord(signedFor(subject));
  const uniqueA = toRecord(signedFor(subject));
  const uniqueB = toRecord(signedFor(subject));

  const resA = buildRecoveryResponse({ request: req, records: [shared, uniqueA], privateKey: peerA.privateKey });
  const resB = buildRecoveryResponse({ request: req, records: [shared, uniqueB], privateKey: peerB.privateKey });

  const { recovered, store } = await rebuildFromResponses(req, [resA, resB]);
  assert.equal(recovered, 3);
  assert.equal((await store.list()).length, 3);
});

test('peer rebuild drops records for the wrong subject', async () => {
  const me = generateKeypair();
  const peer = generateKeypair();
  const req = buildRecoveryRequest({ subject: 'mine', privateKey: me.privateKey });
  const wrong = toRecord(signedFor('someone-else'));
  const res = buildRecoveryResponse({ request: req, records: [wrong], privateKey: peer.privateKey });
  const result = await verifyRecoveryResponse(req, res);
  assert.equal(result.verifiedRecords.length, 0);
  assert.equal(result.rejected.length, 1);
});
