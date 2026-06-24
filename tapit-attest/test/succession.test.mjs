import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeypair,
  createSuccessionLink,
  verifySuccessionChain,
} from '../dist/index.js';

test('a single genesis link verifies and reports the current key', () => {
  const k1 = generateKeypair();
  const k2 = generateKeypair();
  const link = createSuccessionLink({ fromPrivateKey: k1.privateKey, toKey: k2.publicKey });
  assert.equal(link.prevHash, '');
  const result = verifySuccessionChain([link]);
  assert.equal(result.valid, true);
  assert.equal(result.currentKey, k2.publicKey);
});

test('a three-key hash-linked chain verifies end to end', () => {
  const k1 = generateKeypair();
  const k2 = generateKeypair();
  const k3 = generateKeypair();
  const link1 = createSuccessionLink({ fromPrivateKey: k1.privateKey, toKey: k2.publicKey });
  const link2 = createSuccessionLink({
    fromPrivateKey: k2.privateKey,
    toKey: k3.publicKey,
    previous: link1,
  });
  const result = verifySuccessionChain([link1, link2]);
  assert.equal(result.valid, true);
  assert.equal(result.currentKey, k3.publicKey);
});

test('createSuccessionLink rejects a wrong-key continuation', () => {
  const k1 = generateKeypair();
  const k2 = generateKeypair();
  const stranger = generateKeypair();
  const link1 = createSuccessionLink({ fromPrivateKey: k1.privateKey, toKey: k2.publicKey });
  assert.throws(() =>
    createSuccessionLink({
      fromPrivateKey: stranger.privateKey,
      toKey: generateKeypair().publicKey,
      previous: link1,
    }),
  );
});

test('tampering with an earlier link breaks the chain hash', () => {
  const k1 = generateKeypair();
  const k2 = generateKeypair();
  const k3 = generateKeypair();
  const link1 = createSuccessionLink({ fromPrivateKey: k1.privateKey, toKey: k2.publicKey });
  const link2 = createSuccessionLink({
    fromPrivateKey: k2.privateKey,
    toKey: k3.publicKey,
    previous: link1,
  });
  const tampered = { ...link1, issuedAt: '1999-01-01T00:00:00.000Z' };
  const result = verifySuccessionChain([tampered, link2]);
  assert.equal(result.valid, false);
});

test('an empty chain is invalid', () => {
  assert.equal(verifySuccessionChain([]).valid, false);
});
