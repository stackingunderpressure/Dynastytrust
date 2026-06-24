import test from 'node:test';
import assert from 'node:assert/strict';
import {
  leaf,
  branch,
  treeFromObject,
  fieldTreeRoot,
  findLeafValue,
  disclosureProof,
  verifyDisclosureProof,
  identityAttestation,
  signEnvelope,
  generateKeypair,
} from '../dist/index.js';

test('leaf and branch build the expected node shapes', () => {
  assert.deepEqual(leaf('label', 'Ada'), { node: 'leaf', name: 'label', value: 'Ada' });
  const b = branch('root', [leaf('a', 1)]);
  assert.equal(b.node, 'branch');
  assert.equal(b.children.length, 1);
});

test('treeFromObject is deterministic regardless of key insertion order', () => {
  const a = treeFromObject('claim', { name: 'Ada', role: 'pioneer' });
  const b = treeFromObject('claim', { role: 'pioneer', name: 'Ada' });
  assert.deepEqual(Buffer.from(fieldTreeRoot(a)), Buffer.from(fieldTreeRoot(b)));
});

test('changing any field changes the Merkle root', () => {
  const base = treeFromObject('claim', { name: 'Ada' });
  const edited = treeFromObject('claim', { name: 'Grace' });
  assert.notDeepEqual(Buffer.from(fieldTreeRoot(base)), Buffer.from(fieldTreeRoot(edited)));
});

test('nested objects become branches and resolve by path', () => {
  const tree = treeFromObject('claim', { fields: { label: 'Ada', tier: 3 } });
  assert.equal(findLeafValue(tree, 'fields/label'), 'Ada');
  assert.equal(findLeafValue(tree, ['fields', 'tier']), 3);
  assert.equal(findLeafValue(tree, 'fields/missing'), undefined);
  assert.equal(findLeafValue(tree, 'fields'), undefined);
});

test('disclosureProof + verifyDisclosureProof round-trip on a signed attestation', () => {
  const kp = generateKeypair();
  const signed = signEnvelope(
    identityAttestation({
      subject: 'did:example:ada',
      tier: 'routine',
      fields: { display_name: 'Ada', over_21: true, born_year: 1815 },
    }),
    kp.privateKey,
  );
  const proof = disclosureProof(signed, 'over_21');
  assert.equal(proof.leaf.name, 'over_21');
  assert.equal(proof.leaf.value, true);
  const result = verifyDisclosureProof(proof);
  assert.equal(result.valid, true);
  assert.equal(result.signers[0].signer, kp.publicKey);
  assert.equal(result.signers[0].valid, true);
});

test('disclosureProof reveals only the chosen leaf — others are hashes', () => {
  const kp = generateKeypair();
  const signed = signEnvelope(
    identityAttestation({
      subject: 'did:example:ada',
      tier: 'routine',
      fields: { display_name: 'Ada', over_21: true, born_year: 1815 },
    }),
    kp.privateKey,
  );
  const proof = disclosureProof(signed, 'over_21');
  const serialized = JSON.stringify(proof);
  assert.ok(!serialized.includes('Ada'), 'display_name leaked');
  assert.ok(!serialized.includes('1815'), 'born_year leaked');
});

test('a tampered disclosed leaf fails verification', () => {
  const kp = generateKeypair();
  const signed = signEnvelope(
    identityAttestation({
      subject: 'did:example:ada',
      tier: 'routine',
      fields: { over_21: true },
    }),
    kp.privateKey,
  );
  const proof = disclosureProof(signed, 'over_21');
  const tampered = { ...proof, leaf: { ...proof.leaf, value: false } };
  assert.equal(verifyDisclosureProof(tampered).valid, false);
});

test('a tampered meta-field fails verification', () => {
  const kp = generateKeypair();
  const signed = signEnvelope(
    identityAttestation({
      subject: 'did:example:ada',
      tier: 'routine',
      fields: { over_21: true },
    }),
    kp.privateKey,
  );
  const proof = disclosureProof(signed, 'over_21');
  const tampered = {
    ...proof,
    meta: { ...proof.meta, subject: 'did:example:impostor' },
  };
  assert.equal(verifyDisclosureProof(tampered).valid, false);
});

test('disclosureProof throws when path misses or lands on a branch', () => {
  const kp = generateKeypair();
  const signed = signEnvelope(
    identityAttestation({
      subject: 'did:example:ada',
      tier: 'routine',
      fields: { fields: { nested: 'x' } },
    }),
    kp.privateKey,
  );
  assert.throws(() => disclosureProof(signed, 'missing'), /not found/);
  assert.throws(() => disclosureProof(signed, 'fields'), /terminate at a leaf/);
});
