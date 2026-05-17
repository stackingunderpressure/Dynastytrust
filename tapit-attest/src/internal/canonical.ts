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
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('cannot canonicalize non-finite number');
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
