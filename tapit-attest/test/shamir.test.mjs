import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSecret, combineShares } from '../dist/index.js';

// GF(256) Shamir secret sharing — the cryptographic floor for
// Phase 5e cascade recovery. The wallet uses splitSecret over the
// encryption key of the cloud-mirrored backup blob (D-03 still
// applies — never split the signing keypair). These tests
// exercise the math directly: round-trip with various (M, N),
// extra-share tolerance, every threshold combination of a real
// split, and the rejection paths that keep callers honest.

function randomSecret(len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function pickShares(shares, k) {
  const copy = [...shares];
  const out = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

test('a 32-byte secret round-trips through 3-of-5 Shamir', () => {
  const secret = randomSecret(32);
  const shares = splitSecret(secret, 3, 5);
  assert.equal(shares.length, 5);
  const recovered = combineShares(shares.slice(0, 3));
  assert.deepEqual(recovered, secret);
});

test('every 3-share subset of a 3-of-5 split recovers the same secret', () => {
  const secret = randomSecret(16);
  const shares = splitSecret(secret, 3, 5);
  // There are C(5,3) = 10 subsets; check each.
  for (let a = 0; a < 5; a++) {
    for (let b = a + 1; b < 5; b++) {
      for (let c = b + 1; c < 5; c++) {
        const subset = [shares[a], shares[b], shares[c]];
        const recovered = combineShares(subset);
        assert.deepEqual(recovered, secret);
      }
    }
  }
});

test('extra shares beyond the threshold are tolerated', () => {
  const secret = randomSecret(64);
  const shares = splitSecret(secret, 3, 7);
  // Combine all 7 shares — the polynomial is over-determined but
  // consistent, so Lagrange at x=0 still lands on the secret.
  const recovered = combineShares(shares);
  assert.deepEqual(recovered, secret);
});

test('M-1 shares do NOT recover the secret', () => {
  const secret = randomSecret(32);
  const shares = splitSecret(secret, 3, 5);
  const recovered = combineShares(shares.slice(0, 2));
  // With M-1 shares the interpolation lands on a wrong value with
  // overwhelming probability; an exact match would only happen on
  // a 1-in-2^256 chance. Equality means a real bug.
  assert.notDeepEqual(recovered, secret);
});

test('a single secret survives multiple independent splits', () => {
  const secret = randomSecret(48);
  const a = splitSecret(secret, 2, 3);
  const b = splitSecret(secret, 2, 3);
  // Different randomness each call → different share bytes.
  assert.notDeepEqual(a[0].bytes, b[0].bytes);
  // Both splits still recover the same secret.
  assert.deepEqual(combineShares(a.slice(0, 2)), secret);
  assert.deepEqual(combineShares(b.slice(0, 2)), secret);
});

test('splitSecret rejects M < 2', () => {
  assert.throws(() => splitSecret(new Uint8Array(8), 1, 3), /at least 2/);
});

test('splitSecret rejects N < M', () => {
  assert.throws(() => splitSecret(new Uint8Array(8), 5, 3), />= threshold/);
});

test('splitSecret rejects N > 255', () => {
  assert.throws(() => splitSecret(new Uint8Array(8), 3, 256), /255/);
});

test('splitSecret rejects an empty secret', () => {
  assert.throws(() => splitSecret(new Uint8Array(0), 2, 3), /empty/);
});

test('combineShares rejects fewer than 2 shares', () => {
  const shares = splitSecret(randomSecret(8), 2, 3);
  assert.throws(() => combineShares([shares[0]]), /at least 2/);
});

test('combineShares rejects duplicate indices', () => {
  const shares = splitSecret(randomSecret(8), 2, 3);
  assert.throws(
    () => combineShares([shares[0], shares[0]]),
    /duplicate share index/,
  );
});

test('combineShares rejects mismatched share lengths', () => {
  const shares = splitSecret(randomSecret(8), 2, 3);
  const tampered = { index: shares[1].index, bytes: shares[1].bytes.slice(0, 4) };
  assert.throws(() => combineShares([shares[0], tampered]), /lengths disagree/);
});

test('combineShares rejects index 0 (the secret is at notional x=0)', () => {
  const shares = splitSecret(randomSecret(8), 2, 3);
  const tampered = { index: 0, bytes: shares[0].bytes };
  assert.throws(() => combineShares([tampered, shares[1]]), /out of range/);
});

test('a 5-of-9 split with a 128-byte secret round-trips clean', () => {
  const secret = randomSecret(128);
  const shares = splitSecret(secret, 5, 9);
  for (let trial = 0; trial < 8; trial++) {
    const subset = pickShares(shares, 5);
    assert.deepEqual(combineShares(subset), secret);
  }
});
