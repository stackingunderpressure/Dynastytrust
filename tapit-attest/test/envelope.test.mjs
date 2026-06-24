import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDraft,
  attestationDigest,
  envelopeId,
  canonicalEnvelope,
  assertWellFormed,
  generateKeypair,
  signEnvelope,
} from '../dist/index.js';

const draft = () =>
  createDraft({
    kind: 'identity',
    tier: 'routine',
    subject: 'did:example:ada',
    fields: { label: 'Ada Lovelace' },
    issuedAt: '2026-05-18T00:00:00.000Z',
  });

test('createDraft produces a v1 envelope with no signatures', () => {
  const d = draft();
  assert.equal(d.v, 1);
  assert.equal(d.kind, 'identity');
  assert.equal(d.claim.node, 'branch');
  assert.deepEqual(d.signatures, []);
});

test('createDraft rejects an unknown kind, tier, or empty subject', () => {
  assert.throws(() => createDraft({ kind: 'bogus', tier: 'routine', subject: 's', fields: {} }));
  assert.throws(() => createDraft({ kind: 'identity', tier: 'bogus', subject: 's', fields: {} }));
  assert.throws(() => createDraft({ kind: 'identity', tier: 'routine', subject: '', fields: {} }));
});

test('the digest is stable and changes when the envelope is edited', () => {
  const a = attestationDigest(draft());
  const b = attestationDigest(draft());
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  const edited = attestationDigest({ ...draft(), subject: 'did:example:grace' });
  assert.notDeepEqual(Buffer.from(a), Buffer.from(edited));
});

test('envelopeId is stable as the envelope gains a signature', () => {
  const d = draft();
  const before = envelopeId(d);
  const after = envelopeId(signEnvelope(d, generateKeypair().privateKey));
  assert.equal(before, after);
});

test('canonicalEnvelope serializes deterministically', () => {
  assert.equal(canonicalEnvelope(draft()), canonicalEnvelope(draft()));
});

test('assertWellFormed accepts a real envelope and rejects malformed input', () => {
  assert.doesNotThrow(() => assertWellFormed(draft()));
  assert.throws(() => assertWellFormed(null));
  assert.throws(() => assertWellFormed({ ...draft(), kind: 'bogus' }));
  assert.throws(() => assertWellFormed({ ...draft(), signatures: 'nope' }));
});
