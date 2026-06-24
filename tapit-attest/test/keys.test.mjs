import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeypair,
  publicKeyFromPrivate,
  signEnvelope,
  verifyEnvelope,
  identityAttestation,
} from '../dist/index.js';

const draft = () =>
  identityAttestation({
    subject: 'did:example:ada',
    tier: 'routine',
    fields: { label: 'Ada' },
  });

test('generateKeypair yields 32-byte hex keys that derive consistently', () => {
  const kp = generateKeypair();
  assert.match(kp.privateKey, /^[0-9a-f]{64}$/);
  assert.match(kp.publicKey, /^[0-9a-f]{64}$/);
  assert.equal(publicKeyFromPrivate(kp.privateKey), kp.publicKey);
});

test('a signed envelope verifies', () => {
  const kp = generateKeypair();
  const signed = signEnvelope(draft(), kp.privateKey);
  const result = verifyEnvelope(signed);
  assert.equal(result.valid, true);
  assert.equal(result.signers[0].signer, kp.publicKey);
  assert.equal(result.signers[0].valid, true);
});

test('tampering with the subject invalidates the signature', () => {
  const signed = signEnvelope(draft(), generateKeypair().privateKey);
  const tampered = { ...signed, subject: 'did:example:impostor' };
  assert.equal(verifyEnvelope(tampered).valid, false);
});

test('re-signing replaces a signer rather than duplicating it', () => {
  const kp = generateKeypair();
  const once = signEnvelope(draft(), kp.privateKey);
  const twice = signEnvelope(once, kp.privateKey);
  assert.equal(twice.signatures.length, 1);
  assert.equal(verifyEnvelope(twice).valid, true);
});

test('a draft with no signatures does not verify', () => {
  const result = verifyEnvelope(draft());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('no signatures')));
});

test('two distinct signers both verify', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  const signed = signEnvelope(signEnvelope(draft(), a.privateKey), b.privateKey);
  assert.equal(signed.signatures.length, 2);
  assert.equal(verifyEnvelope(signed).valid, true);
});

test('a relayer-appended junk signature cannot poison a genuine envelope', () => {
  const kp = generateKeypair();
  const relayer = generateKeypair();
  const signed = signEnvelope(draft(), kp.privateKey);
  const poisoned = {
    ...signed,
    signatures: [
      ...signed.signatures,
      { signer: relayer.publicKey, sig: 'aa'.repeat(64) },
    ],
  };
  const result = verifyEnvelope(poisoned);
  assert.equal(result.valid, true);
  assert.ok(result.signers.some((s) => s.signer === kp.publicKey && s.valid));
  assert.ok(result.signers.some((s) => s.signer === relayer.publicKey && !s.valid));
  assert.ok(result.errors.some((e) => e.includes(relayer.publicKey)));
});

test('a duplicate row for a valid signer is not counted as an error', () => {
  const kp = generateKeypair();
  const signed = signEnvelope(draft(), kp.privateKey);
  const doubled = {
    ...signed,
    signatures: [
      ...signed.signatures,
      { signer: kp.publicKey, sig: 'aa'.repeat(64) },
    ],
  };
  const result = verifyEnvelope(doubled);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});
