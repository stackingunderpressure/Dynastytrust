import { sha256 } from '@noble/hashes/sha256';
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils';

export { sha256, bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes };

const tagCache = new Map<string, Uint8Array>();

/**
 * BIP340-style tagged hash: SHA256(SHA256(tag) || SHA256(tag) || msg...).
 * Domain separation — a digest for one purpose can never collide with a
 * digest for another, even over identical bytes.
 */
export function taggedHash(tag: string, ...messages: Uint8Array[]): Uint8Array {
  let prefix = tagCache.get(tag);
  if (!prefix) {
    const h = sha256(utf8ToBytes(tag));
    prefix = concatBytes(h, h);
    tagCache.set(tag, prefix);
  }
  return sha256(concatBytes(prefix, ...messages));
}

/**
 * Deterministic JSON: object keys sorted lexicographically at every depth,
 * no insignificant whitespace. Two structurally-equal values always
 * serialize to the identical string — every digest in the library relies
 * on that.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
  return sorted;
}

/** True when `value` is lowercase/uppercase hex, optionally of an exact byte length. */
export function isHex(value: unknown, byteLength?: number): value is string {
  if (typeof value !== 'string' || value.length % 2 !== 0) return false;
  if (!/^[0-9a-fA-F]*$/.test(value)) return false;
  return byteLength === undefined || value.length === byteLength * 2;
}
