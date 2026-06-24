import test from 'node:test';
import assert from 'node:assert/strict';
import {
  multiDisclosureProof,
  verifyMultiDisclosureProof,
  disclosedLeavesOf,
  identityAttestation,
  signEnvelope,
  generateKeypair,
} from '../dist/index.js';

// Multi-leaf disclosure proofs — same security model as the single-leaf
// disclosureProof, just sharing the Merkle path across N leaves so the
// payload doesn't carry every sibling hash for every disclosure.

function signedIdentity() {
  const kp = generateKeypair();
  const att = signEnvelope(
    identityAttestation({
      subject: kp.publicKey,
      tier: 'notable',
      fields: {
        display_name: 'Alice',
        email: 'alice@example.com',
        city: 'Portland',
        born_year: '1990',
      },
    }),
    kp.privateKey,
  );
  return { att, kp };
}

test('a single-leaf multi-disclosure round-trips and verifies', () => {
  const { att } = signedIdentity();
  const bundle = multiDisclosureProof(att, ['display_name']);
  const result = verifyMultiDisclosureProof(bundle);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  const disclosed = disclosedLeavesOf(bundle);
  assert.equal(disclosed.length, 1);
  assert.equal(disclosed[0].path, 'display_name');
  assert.equal(disclosed[0].value, 'Alice');
});

test('multiple leaves from the same branch all verify in one bundle', () => {
  const { att } = signedIdentity();
  const bundle = multiDisclosureProof(att, [
    'display_name',
    'city',
  ]);
  const result = verifyMultiDisclosureProof(bundle);
  assert.equal(result.valid, true);
  const disclosed = disclosedLeavesOf(bundle);
  assert.deepEqual(
    disclosed.map((d) => d.path).sort(),
    ['city', 'display_name'],
  );
  assert.equal(
    disclosed.find((d) => d.path === 'city').value,
    'Portland',
  );
});

test('disclosing all four leaves of a branch still verifies and reveals all four', () => {
  const { att } = signedIdentity();
  const bundle = multiDisclosureProof(att, [
    'display_name',
    'email',
    'city',
    'born_year',
  ]);
  const result = verifyMultiDisclosureProof(bundle);
  assert.equal(result.valid, true);
  assert.equal(disclosedLeavesOf(bundle).length, 4);
});

test('duplicate paths in the input are coalesced — no double disclosure', () => {
  const { att } = signedIdentity();
  const bundle = multiDisclosureProof(att, [
    'display_name',
    'display_name',
  ]);
  assert.equal(bundle.paths.length, 1);
  assert.equal(disclosedLeavesOf(bundle).length, 1);
  assert.equal(verifyMultiDisclosureProof(bundle).valid, true);
});

test('an empty paths array is rejected', () => {
  const { att } = signedIdentity();
  assert.throws(() => multiDisclosureProof(att, []), /must not be empty/);
});

test('a path that misses is rejected', () => {
  const { att } = signedIdentity();
  assert.throws(
    () => multiDisclosureProof(att, ['fields/no_such_field']),
    /not found/,
  );
});

test('a path that lands on a branch is rejected', () => {
  const kp = generateKeypair();
  const nested = signEnvelope(
    identityAttestation({
      subject: kp.publicKey,
      tier: 'routine',
      fields: { profile: { nickname: 'A' } },
    }),
    kp.privateKey,
  );
  assert.throws(
    () => multiDisclosureProof(nested, ['profile']),
    /terminate at a leaf/,
  );
});

test('a tampered leaf value fails verification', () => {
  const { att } = signedIdentity();
  const bundle = multiDisclosureProof(att, [
    'display_name',
    'city',
  ]);
  // walk into the pruned root and flip display_name's value
  const name = bundle.root.children.find((c) => c.name === 'display_name');
  name.value = 'Bob';
  const result = verifyMultiDisclosureProof(bundle);
  assert.equal(result.valid, false);
});

test('a tampered sibling hash fails verification', () => {
  const { att } = signedIdentity();
  const bundle = multiDisclosureProof(att, ['display_name']);
  // The pruned root keeps display_name as a 'leaf' and replaces the
  // other three fields with 'hashed' siblings.
  const hashedSibling = bundle.root.children.find((c) => c.node === 'hashed');
  hashedSibling.hash = '00'.repeat(32);
  const result = verifyMultiDisclosureProof(bundle);
  assert.equal(result.valid, false);
});

test('signature tamper is caught with quorum-of-good (no good signature → invalid)', () => {
  const { att } = signedIdentity();
  const bundle = multiDisclosureProof(att, ['email']);
  bundle.signatures[0].sig = '0'.repeat(128);
  const result = verifyMultiDisclosureProof(bundle);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('invalid signature')));
});

test('disclosedLeavesOf is the authoritative read of what the bundle reveals', () => {
  const { att } = signedIdentity();
  const bundle = multiDisclosureProof(att, [
    'city',
    'born_year',
  ]);
  // Clear the informational paths field — disclosedLeavesOf should still
  // recover the disclosure set from the tree structure.
  bundle.paths = [];
  const disclosed = disclosedLeavesOf(bundle);
  assert.deepEqual(
    disclosed.map((d) => d.path).sort(),
    ['born_year', 'city'],
  );
});
