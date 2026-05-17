/**
 * The hash-linked key-succession chain.
 *
 * Keys rotate -- a signer loses a device, upgrades hardware, or
 * pre-emptively hands control to a successor. A succession chain is
 * an ordered list of `meta` attestations, each one signed by the
 * RETIRING key, declaring "key A is succeeded by key B". Each link
 * commits to the id of the previous link, so the chain is
 * tamper-evident: rewrite any link and every later `prevLink`
 * breaks.
 *
 * This lets a verifier start from a long-known genesis key and walk
 * forward to the current key without trusting any server.
 */

import {
  attestationDigest,
  envelopeId,
  type AttestationEnvelope,
} from './envelope.js';
import { findLeafValue } from './field-tree.js';
import { metaAttestation } from './builders.js';
import { signEnvelope, verifySignature } from './sign.js';
import { isPublicKey } from './keys.js';
import { toHex } from '../internal/hex.js';
import type { TierName } from './tiers.js';

/** A succession link is just a `meta` / key_succession attestation. */
export type SuccessionLink = AttestationEnvelope;

export interface BuildLinkOptions {
  /** Stable identity id the chain belongs to (the same across links). */
  readonly identity: string;
  /** 0-based position in the chain. */
  readonly index: number;
  /** envelopeId of the previous link, or null for the genesis link. */
  readonly prevLink: string | null;
  /** x-only public key being retired (must match the signing key). */
  readonly fromKey: string;
  /** x-only public key taking over. */
  readonly toKey: string;
  /** Private key for `fromKey` -- proves the retiring key authorized it. */
  readonly fromPrivateKey: string | Uint8Array;
  readonly tier?: TierName;
  readonly issuedAt?: string;
}

/** Build and sign one succession link. */
export function createSuccessionLink(opts: BuildLinkOptions): SuccessionLink {
  if (!isPublicKey(opts.fromKey) || !isPublicKey(opts.toKey)) {
    throw new Error('fromKey and toKey must be x-only public keys');
  }
  if (opts.index < 0 || !Number.isInteger(opts.index)) {
    throw new Error('index must be a non-negative integer');
  }
  if (opts.index === 0 && opts.prevLink !== null) {
    throw new Error('genesis link must have prevLink = null');
  }
  if (opts.index > 0 && !opts.prevLink) {
    throw new Error('non-genesis link must reference a prevLink');
  }
  const draft = metaAttestation({
    op: 'key_succession',
    subject: opts.identity,
    tier: opts.tier ?? 'high_stakes',
    issuedAt: opts.issuedAt,
    fields: {
      index: opts.index,
      prevLink: opts.prevLink ?? '',
      fromKey: opts.fromKey,
      toKey: opts.toKey,
    },
  });
  return signEnvelope(draft, opts.fromPrivateKey, { role: 'retiring_key' });
}

export interface ChainVerification {
  readonly valid: boolean;
  /** The current active key once the chain is walked, if valid. */
  readonly currentKey: string | null;
  /** The genesis (oldest) key, if valid. */
  readonly genesisKey: string | null;
  readonly reason?: string;
}

function readLink(link: SuccessionLink): {
  index: number;
  prevLink: string;
  fromKey: string;
  toKey: string;
} | null {
  const op = findLeafValue(link.claim, ['claim', 'op']);
  if (op !== 'key_succession') return null;
  const index = findLeafValue(link.claim, ['claim', 'payload', 'index']);
  const prevLink = findLeafValue(link.claim, ['claim', 'payload', 'prevLink']);
  const fromKey = findLeafValue(link.claim, ['claim', 'payload', 'fromKey']);
  const toKey = findLeafValue(link.claim, ['claim', 'payload', 'toKey']);
  if (
    typeof index !== 'number' ||
    typeof prevLink !== 'string' ||
    typeof fromKey !== 'string' ||
    typeof toKey !== 'string'
  ) {
    return null;
  }
  return { index, prevLink, fromKey, toKey };
}

/**
 * Verify a full succession chain in order. Checks, for every link:
 *  - it is a meta / key_succession attestation
 *  - its index equals its position
 *  - its prevLink equals the previous link's envelopeId
 *  - it is signed by the key it declares as `fromKey`
 *  - its `fromKey` equals the previous link's `toKey`
 *  - the claimRoot still matches the signed digest
 */
export function verifySuccessionChain(links: readonly SuccessionLink[]): ChainVerification {
  if (links.length === 0) {
    return { valid: false, currentKey: null, genesisKey: null, reason: 'empty chain' };
  }

  let prevId: string | null = null;
  let prevToKey: string | null = null;
  let genesisKey: string | null = null;

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const parsed = readLink(link);
    if (!parsed) {
      return { valid: false, currentKey: null, genesisKey, reason: `link ${i}: not a key_succession attestation` };
    }
    if (parsed.index !== i) {
      return { valid: false, currentKey: null, genesisKey, reason: `link ${i}: index mismatch` };
    }
    const expectedPrev = prevId ?? '';
    if (parsed.prevLink !== expectedPrev) {
      return { valid: false, currentKey: null, genesisKey, reason: `link ${i}: broken prevLink` };
    }
    const signedByFromKey = link.signatures.find((s) => s.signer === parsed.fromKey);
    if (!signedByFromKey || !verifySignature(link, signedByFromKey)) {
      return { valid: false, currentKey: null, genesisKey, reason: `link ${i}: not signed by retiring key` };
    }
    // Guard against a tampered claim tree -- the digest must still bind.
    if (link.anchor && link.anchor.digest !== toHex(attestationDigest(link))) {
      return { valid: false, currentKey: null, genesisKey, reason: `link ${i}: anchor digest mismatch` };
    }
    if (i > 0 && parsed.fromKey !== prevToKey) {
      return { valid: false, currentKey: null, genesisKey, reason: `link ${i}: fromKey does not match previous toKey` };
    }
    if (i === 0) genesisKey = parsed.fromKey;
    prevId = envelopeId(link);
    prevToKey = parsed.toKey;
  }

  return { valid: true, currentKey: prevToKey, genesisKey };
}
