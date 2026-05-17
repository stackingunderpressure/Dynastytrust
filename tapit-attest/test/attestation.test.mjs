/**
 * Envelope, field tree, sign/verify, builders, tiers, weighting.
 * Runs against the built library in ../dist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  treeFromObject,
  fieldTreeRoot,
  leaf,
  branch,
  findLeafValue,
  identityAttestation,
  agreementAttestation,
  predictionAttestation,
  createDraft,
  attestationDigest,
  envelopeId,
  assertWellFormed,
  generateKeypair,
  signEnvelope,
  verifyEnvelope,
  verifySignature,
  tierConfig,
  evaluateTier,
  computeWeight,
} from '../dist/index.js';

test('field tree root is deterministic and order-independent', () => {
  const a = treeFromObject('claim', { name: 'Ada', born: 1815 });
  const b = treeFromObject('claim', { born: 1815, name: 'Ada' });
  assert.equal(fieldTreeRoot(a), fieldTreeRoot(b));
});

test('field tree root changes when a value changes', () => {
  const a = treeFromObject('claim', { name: 'Ada' });
  const b = treeFromObject('claim', { name: 'Bob' });
  assert.notEqual(fieldTreeRoot(a), fieldTreeRoot(b));
});

test('findLeafValue walks branch names', () => {
  const tree = branch('claim', [branch('payload', [leaf('op', 'x')])]);
  assert.equal(findLeafValue(tree, ['claim', 'payload', 'op']), 'x');
  assert.equal(findLeafValue(tree, ['claim', 'missing']), undefined);
});

test('treeFromObject rejects arrays', () => {
  assert.throws(() => treeFromObject('claim', { xs: [1, 2] }));
});

test('sign then verify round-trips for all signers', () => {
  const kp = generateKeypair();
  const draft = identityAttestation({
    subject: 'did:example:ada',
    tier: 'routine',
    fields: { key: kp.publicKey, label: 'Ada' },
  });
  const signed = signEnvelope(draft, kp.privateKey);
  const result = verifyEnvelope(signed);
  assert.equal(result.valid, true);
  assert.deepEqual(result.validSigners, [kp.publicKey]);
});

test('co-signing: two signers over one digest', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  const draft = agreementAttestation({
    subject: 'trust-doc-1',
    tier: 'notable',
    fields: { terms: 'hash:abc' },
  });
  const signed = signEnvelope(signEnvelope(draft, a.privateKey), b.privateKey);
  assert.equal(signed.signatures.length, 2);
  assert.equal(verifyEnvelope(signed).valid, true);
});

test('the same key cannot sign twice', () => {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject: 's', tier: 'routine', fields: { k: 1 } });
  const once = signEnvelope(draft, kp.privateKey);
  assert.throws(() => signEnvelope(once, kp.privateKey));
});

test('tampering with subject invalidates every signature', () => {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject: 'real', tier: 'routine', fields: { k: 1 } });
  const signed = signEnvelope(draft, kp.privateKey);
  const tampered = { ...signed, subject: 'forged' };
  assert.equal(verifySignature(tampered, tampered.signatures[0]), false);
});

test('tampering with the claim tree invalidates signatures', () => {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject: 's', tier: 'routine', fields: { k: 1 } });
  const signed = signEnvelope(draft, kp.privateKey);
  const tampered = { ...signed, claim: treeFromObject('claim', { k: 999 }) };
  assert.equal(verifyEnvelope(tampered).valid, false);
});

test('assertWellFormed catches a forged claimRoot', () => {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject: 's', tier: 'routine', fields: { k: 1 } });
  const signed = signEnvelope(draft, kp.privateKey);
  assertWellFormed(signed);
  const forged = { ...signed, claimRoot: 'f'.repeat(64) };
  assert.throws(() => assertWellFormed(forged));
});

test('envelopeId is stable and content-bound', () => {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject: 's', tier: 'routine', fields: { k: 1 } });
  const signed = signEnvelope(draft, kp.privateKey);
  assert.equal(envelopeId(signed), envelopeId(signed));
  assert.notEqual(envelopeId(signed), envelopeId(draft));
});

test('attestationDigest is 32 bytes', () => {
  const draft = createDraft({
    kind: 'credential',
    tier: 'routine',
    subject: 's',
    claim: treeFromObject('claim', { degree: 'PhD' }),
  });
  assert.equal(attestationDigest(draft).length, 32);
});

test('prediction attestation records resolvesAt', () => {
  const draft = predictionAttestation({
    subject: 'btc-100k',
    tier: 'high_stakes',
    resolvesAt: '2030-01-01T00:00:00.000Z',
    fields: { outcome: 'BTC above 100k' },
  });
  assert.equal(findLeafValue(draft.claim, ['claim', 'resolvesAt']), '2030-01-01T00:00:00.000Z');
});

test('tier evaluation is pure arithmetic over the dials', () => {
  const cfg = tierConfig('notable');
  const tooFew = evaluateTier(cfg, new Map([['k1', 5]]));
  assert.equal(tooFew.ok, false);
  const enough = evaluateTier(cfg, new Map([['k1', 2], ['k2', 2]]));
  assert.equal(enough.ok, true);
  assert.equal(enough.totalWeight, 4);
});

test('tier override changes only the dials', () => {
  const cfg = tierConfig('routine', { requiredSigners: 3 });
  assert.equal(cfg.name, 'routine');
  assert.equal(cfg.requiredSigners, 3);
});

test('weighting sums valid signers from the table', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  const draft = agreementAttestation({ subject: 's', tier: 'notable', fields: { x: 1 } });
  const signed = signEnvelope(signEnvelope(draft, a.privateKey), b.privateKey);
  const table = new Map([[a.publicKey, 4], [b.publicKey, 3]]);
  const w = computeWeight(signed, table);
  assert.equal(w.totalWeight, 7);
  assert.equal(w.ignoredSigners.length, 0);
});

test('unknown signers default to weight 1', () => {
  const kp = generateKeypair();
  const draft = identityAttestation({ subject: 's', tier: 'routine', fields: { k: 1 } });
  const signed = signEnvelope(draft, kp.privateKey);
  assert.equal(computeWeight(signed).totalWeight, 1);
});
