import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeypair,
  signEnvelope,
  identityAttestation,
  toRecord,
  MemoryStore,
  SyncEngine,
  loadVerified,
} from '../dist/index.js';

const signedFor = (subject) => {
  const kp = generateKeypair();
  const attestation = signEnvelope(
    identityAttestation({ subject, tier: 'routine', fields: { label: subject } }),
    kp.privateKey,
  );
  return { attestation, signer: kp.publicKey };
};

test('MemoryStore indexes records by subject and by signer', async () => {
  const store = new MemoryStore();
  const { attestation, signer } = signedFor('did:example:ada');
  const record = toRecord(attestation);
  await store.put(record);
  assert.equal((await store.get(record.id)).id, record.id);
  assert.equal((await store.bySubject('did:example:ada')).length, 1);
  assert.equal((await store.bySigner(signer)).length, 1);
  assert.equal((await store.bySigner('deadbeef')).length, 0);
});

test('SyncEngine reconciles both directions, last-write-wins', async () => {
  const local = new MemoryStore();
  const remote = new MemoryStore();
  const a = signedFor('did:example:ada').attestation;
  const b = signedFor('did:example:grace').attestation;
  await local.put(toRecord(a, '2026-05-18T00:00:00.000Z'));
  await remote.put(toRecord(b, '2026-05-18T00:00:00.000Z'));

  const result = await new SyncEngine(local, remote).sync();
  assert.equal(result.pushed, 1);
  assert.equal(result.pulled, 1);
  assert.equal((await local.list()).length, 2);
  assert.equal((await remote.list()).length, 2);
});

test('SyncEngine keeps the newer record when ids collide', async () => {
  const local = new MemoryStore();
  const remote = new MemoryStore();
  const { attestation } = signedFor('did:example:ada');
  const id = toRecord(attestation).id;
  await local.put(toRecord(attestation, '2026-05-18T10:00:00.000Z'));
  await remote.put(toRecord(attestation, '2026-05-18T08:00:00.000Z'));
  await new SyncEngine(local, remote).sync();
  assert.equal((await remote.get(id)).updatedAt, '2026-05-18T10:00:00.000Z');
});

test('loadVerified drops attestations whose signatures do not verify', async () => {
  const store = new MemoryStore();
  const { attestation } = signedFor('did:example:ada');
  await store.put(toRecord(attestation));
  const tampered = { ...attestation, subject: 'did:example:impostor' };
  await store.put(toRecord(tampered));
  const verified = await loadVerified(store);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].subject, 'did:example:ada');
});
