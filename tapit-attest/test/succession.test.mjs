/** Hash-linked key-succession chain: build, verify, tamper detection. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateKeypair,
  createSuccessionLink,
  verifySuccessionChain,
  envelopeId,
} from '../dist/index.js';

function buildChain(identity, keys) {
  const links = [];
  let prev = null;
  for (let i = 0; i < keys.length - 1; i++) {
    const link = createSuccessionLink({
      identity,
      index: i,
      prevLink: prev,
      fromKey: keys[i].publicKey,
      toKey: keys[i + 1].publicKey,
      fromPrivateKey: keys[i].privateKey,
    });
    links.push(link);
    prev = envelopeId(link);
  }
  return links;
}

test('a valid chain verifies and yields the current key', () => {
  const id = 'did:example:dynasty';
  const keys = [generateKeypair(), generateKeypair(), generateKeypair()];
  const links = buildChain(id, keys);
  const result = verifySuccessionChain(links);
  assert.equal(result.valid, true);
  assert.equal(result.genesisKey, keys[0].publicKey);
  assert.equal(result.currentKey, keys[2].publicKey);
});

test('a single-link chain verifies', () => {
  const keys = [generateKeypair(), generateKeypair()];
  const links = buildChain('id', keys);
  assert.equal(verifySuccessionChain(links).valid, true);
});

test('an empty chain is rejected', () => {
  assert.equal(verifySuccessionChain([]).valid, false);
});

test('a reordered chain breaks the hash link', () => {
  const keys = [generateKeypair(), generateKeypair(), generateKeypair()];
  const links = buildChain('id', keys);
  const swapped = [links[1], links[0]];
  assert.equal(verifySuccessionChain(swapped).valid, false);
});

test('a link signed by the wrong key is rejected', () => {
  const id = 'id';
  const a = generateKeypair();
  const b = generateKeypair();
  const impostor = generateKeypair();
  // Genesis link claims fromKey = a but is signed by an impostor.
  const bad = createSuccessionLink({
    identity: id,
    index: 0,
    prevLink: null,
    fromKey: a.publicKey,
    toKey: b.publicKey,
    fromPrivateKey: impostor.privateKey,
  });
  assert.equal(verifySuccessionChain([bad]).valid, false);
});

test('genesis link must not reference a prevLink', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  assert.throws(() =>
    createSuccessionLink({
      identity: 'id',
      index: 0,
      prevLink: 'deadbeef',
      fromKey: a.publicKey,
      toKey: b.publicKey,
      fromPrivateKey: a.privateKey,
    }),
  );
});

test('a chain with a discontinuous key handoff is rejected', () => {
  const id = 'id';
  const k0 = generateKeypair();
  const k1 = generateKeypair();
  const k2 = generateKeypair();
  const stranger = generateKeypair();
  const link0 = createSuccessionLink({
    identity: id,
    index: 0,
    prevLink: null,
    fromKey: k0.publicKey,
    toKey: k1.publicKey,
    fromPrivateKey: k0.privateKey,
  });
  // link1 should hand off FROM k1, but instead starts from a stranger.
  const link1 = createSuccessionLink({
    identity: id,
    index: 1,
    prevLink: envelopeId(link0),
    fromKey: stranger.publicKey,
    toKey: k2.publicKey,
    fromPrivateKey: stranger.privateKey,
  });
  assert.equal(verifySuccessionChain([link0, link1]).valid, false);
});
