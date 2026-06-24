// Plain GF(256) Shamir Secret Sharing for Phase 5e cascade recovery.
//
// The wallet uses this to split the encryption key of the cloud-
// mirrored backup blob into N shares such that any M can
// reconstruct it but M-1 cannot. The split is over the symmetric
// encryption key — NEVER over the signing keypair (D-03 stays
// non-negotiable). A colluding M-of-N can at worst decrypt ONE
// backup snapshot; they cannot become the operator, because
// signing authority transfers only through a peer-witnessed
// succession event the recovered wallet itself produces.
//
// SLIP-0039's human-readable share encoding is deferred to a
// follow-on cut. This module ships the raw split / combine math
// as (index, bytes) share pairs; higher layers can wrap shares in
// any envelope they like (NIP-44 ciphertext to the cohort peer,
// for example).
//
// Construction is standard textbook Shamir:
//
//   - Field: GF(256), Rijndael polynomial 0x11b. Addition is XOR;
//     multiplication via log/antilog tables built once at module
//     load.
//   - Polynomial: for each byte of the secret, a random polynomial
//     of degree M-1 with the secret byte as constant term. Random
//     coefficients are bytes 1..M-1.
//   - Share i: evaluate every polynomial at x = i. Index 0 IS the
//     secret, so share indices are 1..N (we reject index 0 as a
//     share input on combine).
//   - Combine: Lagrange interpolation at x = 0 over any M shares.
//
// The math is byte-parallel — each byte of the secret is its own
// independent polynomial. No cross-byte coupling; secret length
// is preserved.

import { randomBytes } from '../internal.js';

const FIELD_SIZE = 256;

// Build log / antilog tables for the AES Rijndael field. Generator
// 0x03; the multiplicative group has 255 elements. log[0] is
// undefined and never read; we set it to 0 for typedness.
const LOG = new Uint8Array(FIELD_SIZE);
const ANTILOG = new Uint8Array(FIELD_SIZE);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    ANTILOG[i] = x;
    LOG[x] = i;
    // Multiply by the generator 0x03 in the Rijndael field.
    let next = (x << 1) ^ x; // x * 0x03 = (x << 1) + x in GF(2)
    if (next >= FIELD_SIZE) next ^= 0x11b;
    x = next & 0xff;
  }
  // Convenience: ANTILOG wraps around at 255.
  ANTILOG[255] = ANTILOG[0];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return ANTILOG[(LOG[a]! + LOG[b]!) % 255]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('shamir: division by zero in GF(256)');
  if (a === 0) return 0;
  return ANTILOG[(LOG[a]! - LOG[b]! + 255) % 255]!;
}

/** A single Shamir share — (index, share-bytes). Index is 1..255. */
export interface Share {
  /** Share index, 1..255. The secret lives at notional index 0. */
  index: number;
  /** Same length as the original secret. */
  bytes: Uint8Array;
}

/**
 * Split a secret into N shares with threshold M. Throws on
 * out-of-range parameters or an empty secret. Uses the platform
 * CSPRNG via `randomBytes` for the polynomial coefficients —
 * the security of the scheme rests on that randomness.
 */
export function splitSecret(
  secret: Uint8Array,
  threshold: number,
  totalShares: number,
): Share[] {
  const M = threshold;
  const N = totalShares;
  if (!Number.isInteger(M) || !Number.isInteger(N)) {
    throw new Error('shamir: threshold and totalShares must be integers');
  }
  if (M < 2) throw new Error('shamir: threshold must be at least 2');
  if (N < M) {
    throw new Error('shamir: totalShares must be >= threshold');
  }
  if (N > 255) {
    throw new Error('shamir: totalShares must be <= 255 (GF(256) limit)');
  }
  if (secret.length === 0) {
    throw new Error('shamir: secret must not be empty');
  }

  // For each byte of the secret, build a polynomial of degree M-1.
  // Constant term is the secret byte; coefficients 1..M-1 are
  // freshly random per call. coeffs[b][k] is the coefficient of
  // x^k for byte b — k=0 is the secret byte.
  const coeffs: Uint8Array[] = new Array(secret.length);
  for (let b = 0; b < secret.length; b++) {
    const row = new Uint8Array(M);
    row[0] = secret[b]!;
    if (M > 1) {
      const rand = randomBytes(M - 1);
      for (let k = 1; k < M; k++) row[k] = rand[k - 1]!;
    }
    coeffs[b] = row;
  }

  const shares: Share[] = [];
  for (let i = 1; i <= N; i++) {
    const shareBytes = new Uint8Array(secret.length);
    for (let b = 0; b < secret.length; b++) {
      // Horner evaluation of the byte's polynomial at x = i.
      let value = coeffs[b]![M - 1]!;
      for (let k = M - 2; k >= 0; k--) {
        value = gfMul(value, i) ^ coeffs[b]![k]!;
      }
      shareBytes[b] = value;
    }
    shares.push({ index: i, bytes: shareBytes });
  }
  return shares;
}

/**
 * Combine M-or-more shares into the original secret via Lagrange
 * interpolation at x = 0. Throws if shares disagree on length or
 * any index is out of range / duplicate. Extra shares beyond the
 * threshold the splitter used are tolerated — the interpolation
 * still lands on the secret because all shares come from the same
 * polynomial; the math is over-determined but consistent.
 */
export function combineShares(shares: readonly Share[]): Uint8Array {
  if (shares.length < 2) {
    throw new Error('shamir: at least 2 shares required to combine');
  }
  const len = shares[0]!.bytes.length;
  if (len === 0) {
    throw new Error('shamir: shares must be non-empty');
  }
  const seen = new Set<number>();
  for (const s of shares) {
    if (!Number.isInteger(s.index) || s.index < 1 || s.index > 255) {
      throw new Error(`shamir: share index out of range: ${s.index}`);
    }
    if (seen.has(s.index)) {
      throw new Error(`shamir: duplicate share index: ${s.index}`);
    }
    seen.add(s.index);
    if (s.bytes.length !== len) {
      throw new Error('shamir: share lengths disagree');
    }
  }

  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    // Lagrange interpolation at x = 0:
    //   secret_b = sum over i of (share_i[b] * prod over j != i of (-x_j / (x_i - x_j)))
    // In GF(2^8) negation is identity, so -x_j = x_j and (x_i - x_j) = (x_i XOR x_j).
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      const xi = shares[i]!.index;
      const yi = shares[i]!.bytes[b]!;
      let basis = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        const xj = shares[j]!.index;
        // numerator x_j (= -x_j in GF(2)), denominator x_i XOR x_j.
        basis = gfMul(basis, gfDiv(xj, xi ^ xj));
      }
      acc ^= gfMul(yi, basis);
    }
    out[b] = acc;
  }
  return out;
}
