/**
 * Canonical JSON serialization.
 *
 * Deterministic, whitespace-free, keys sorted. Two structurally
 * equal values always serialize to the same string, which is what
 * makes hashing and signing reproducible across machines.
 *
 * Lifted from DynastyTrust's `attest.ts` `canonicalJson` and kept
 * byte-compatible on purpose.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new Error('cannot canonicalize undefined');
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error('cannot canonicalize non-finite number');
      }
      // Every numeric field this library actually carries (weight,
      // block heights, timestamps-as-numbers, counts) is conceptually
      // an integer. Beyond 2^53, JSON.stringify emits the nearest
      // double's decimal form rather than the mathematical integer the
      // producer intended -- two producers computing the "same" large
      // integer differently (or one rounding first, one not) derive
      // different canonical bytes for what should hash/verify
      // identically. Reject rather than silently accept a
      // non-reproducible digest.
      if (!Number.isSafeInteger(value)) {
        throw new Error('cannot canonicalize a number outside the safe integer range');
      }
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}
