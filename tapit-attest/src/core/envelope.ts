/**
 * The attestation envelope -- the one shape everything uses.
 *
 * A signed structured claim carrying: the signer(s), the subject,
 * a claim payload built as a field tree, an issued-at timestamp, an
 * optional anchor, and one or more signatures over the digest that
 * commits to the field-tree ROOT plus the envelope metadata.
 *
 * Every attestation -- all six kinds, all three tiers -- is exactly
 * this struct. Nothing else.
 *
 * Digest construction (what each signature commits to):
 *   metaHash = taggedHash(meta,  canonicalJson{v,kind,tier,subject,issuedAt})
 *   digest   = taggedHash(root,  metaHash || claimRoot)
 *
 * `claimRoot` is the field tree's Merkle root. Folding the metadata
 * in via a second tagged hash means swapping the subject, tier or
 * timestamp invalidates every signature -- the same immutability
 * DynastyTrust relied on when a tampered descriptor dropped every
 * attestation count to zero.
 */

import { taggedHash, TAGS } from '../internal/hash.js';
import { canonicalJson } from '../internal/canonical.js';
import { fromHex, toHex, utf8 } from '../internal/hex.js';
import { fieldTreeRoot, type FieldNode } from './field-tree.js';
import { isAttestationKind, type AttestationKind } from './kinds.js';
import { isTierName, type TierName } from './tiers.js';

export const ENVELOPE_VERSION = 1 as const;

/**
 * An optional timestamp anchor. `proof` is an OpenTimestamps proof
 * (hex). When `status` is `pending` the proof exists but is not yet
 * confirmed into a Bitcoin block; `complete` carries a height.
 */
export interface Anchor {
  readonly type: 'opentimestamps';
  /** The 32-byte attestation digest the anchor stamps, as hex. */
  readonly digest: string;
  /** OpenTimestamps proof bytes, hex. Null while only requested. */
  readonly proof: string | null;
  readonly status: 'pending' | 'complete';
  /** Bitcoin block height once `complete`. */
  readonly bitcoinHeight?: number;
}

export interface AttestationSignature {
  /** x-only secp256k1 public key, 64 hex chars. */
  readonly signer: string;
  /** BIP340 Schnorr signature over the attestation digest, 128 hex chars. */
  readonly sig: string;
  readonly signedAt: string;
  /** Recomputable weight contribution -- see weighting.ts. */
  readonly weight: number;
  /** Optional named role of this signer (e.g. "issuer", "witness"). */
  readonly role?: string;
}

export interface AttestationEnvelope {
  readonly v: typeof ENVELOPE_VERSION;
  readonly kind: AttestationKind;
  readonly tier: TierName;
  readonly subject: string;
  readonly issuedAt: string;
  readonly claim: FieldNode;
  /** Merkle root of `claim`, hex. Always recomputable from `claim`. */
  readonly claimRoot: string;
  readonly anchor: Anchor | null;
  readonly signatures: readonly AttestationSignature[];
}

export interface DraftOptions {
  readonly kind: AttestationKind;
  readonly tier: TierName;
  readonly subject: string;
  readonly claim: FieldNode;
  /** ISO timestamp; defaults to now. */
  readonly issuedAt?: string;
}

/** Build an unsigned envelope. Sign it with `signEnvelope`. */
export function createDraft(opts: DraftOptions): AttestationEnvelope {
  const issuedAt = opts.issuedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(issuedAt))) {
    throw new Error('issuedAt is not a valid timestamp');
  }
  if (!opts.subject) throw new Error('subject is required');
  return {
    v: ENVELOPE_VERSION,
    kind: opts.kind,
    tier: opts.tier,
    subject: opts.subject,
    issuedAt,
    claim: opts.claim,
    claimRoot: fieldTreeRoot(opts.claim),
    anchor: null,
    signatures: [],
  };
}

function metaHash(env: AttestationEnvelope): Uint8Array {
  const meta = canonicalJson({
    v: env.v,
    kind: env.kind,
    tier: env.tier,
    subject: env.subject,
    issuedAt: env.issuedAt,
  });
  return taggedHash(TAGS.meta, utf8(meta));
}

/**
 * The 32-byte digest every signer signs and the anchor stamps.
 * Recomputes the claim root from `claim` so a forged `claimRoot`
 * field cannot change what was actually signed.
 */
export function attestationDigest(env: AttestationEnvelope): Uint8Array {
  const trueRoot = fieldTreeRoot(env.claim);
  return taggedHash(TAGS.root, metaHash(env), fromHex(trueRoot));
}

/** Deterministic full serialization, including signatures + anchor. */
export function canonicalEnvelope(env: AttestationEnvelope): string {
  return canonicalJson(env as unknown);
}

/**
 * Stable content id of a fully-formed envelope. Used as a storage
 * key, as the link target in the succession chain, and as the
 * revocation target id.
 */
export function envelopeId(env: AttestationEnvelope): string {
  return toHex(taggedHash(TAGS.envelopeId, utf8(canonicalEnvelope(env))));
}

/**
 * Structural checks. Does NOT verify signatures -- see verify.ts.
 * Throws on the first problem with a human-readable message.
 */
export function assertWellFormed(env: AttestationEnvelope): void {
  if (env.v !== ENVELOPE_VERSION) {
    throw new Error(`unsupported envelope version: ${String(env.v)}`);
  }
  if (!isAttestationKind(env.kind)) {
    throw new Error(`invalid kind: ${String(env.kind)}`);
  }
  if (!isTierName(env.tier)) {
    throw new Error(`invalid tier: ${String(env.tier)}`);
  }
  if (!env.subject) throw new Error('missing subject');
  if (Number.isNaN(Date.parse(env.issuedAt))) {
    throw new Error('invalid issuedAt');
  }
  const trueRoot = fieldTreeRoot(env.claim);
  if (trueRoot !== env.claimRoot) {
    throw new Error('claimRoot does not match claim tree');
  }
  if (env.anchor && env.anchor.digest !== toHex(attestationDigest(env))) {
    throw new Error('anchor digest does not match attestation digest');
  }
}
