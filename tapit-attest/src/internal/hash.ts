/**
 * Hashing + domain separation.
 *
 * `taggedHash` follows the BIP340 construction:
 *   SHA256( SHA256(tag) || SHA256(tag) || data )
 *
 * Every distinct use inside tapit-attest gets its own tag. This is
 * the same discipline DynastyTrust applied so an attestation
 * signature can never be replayed as a Bitcoin sighash -- here it
 * also keeps field-tree leaves, branches, envelope digests and
 * succession links from ever colliding with one another.
 */

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, utf8 } from './hex.js';

const tagCache = new Map<string, Uint8Array>();

function tagPrefix(tag: string): Uint8Array {
  const cached = tagCache.get(tag);
  if (cached) return cached;
  const h = sha256(utf8(tag));
  const prefix = concatBytes(h, h);
  tagCache.set(tag, prefix);
  return prefix;
}

export function taggedHash(tag: string, ...data: Uint8Array[]): Uint8Array {
  return sha256(concatBytes(tagPrefix(tag), ...data));
}

export function plainHash(...data: Uint8Array[]): Uint8Array {
  return sha256(concatBytes(...data));
}

/** Domain tags. Bump the version suffix only on a breaking change. */
export const TAGS = {
  leaf: 'tapit-attest/v1/field-leaf',
  branch: 'tapit-attest/v1/field-branch',
  meta: 'tapit-attest/v1/envelope-meta',
  root: 'tapit-attest/v1/envelope-root',
  envelopeId: 'tapit-attest/v1/envelope-id',
  succession: 'tapit-attest/v1/succession-link',
  anchor: 'tapit-attest/v1/anchor-digest',
  recovery: 'tapit-attest/v1/recovery-message',
} as const;
