/**
 * The attestation kind — what the claim is *about*. Seven roles, one
 * envelope shape. The kind is a label, never a code path.
 */
export type AttestationKind =
  | 'identity'
  | 'relationship'
  | 'credential'
  | 'prediction'
  | 'agreement'
  | 'journal'
  | 'meta';

/** Stakes tier. Configuration on the same primitive — never separate code. */
export type TierName = 'routine' | 'notable' | 'high_stakes';

/** A scalar a field leaf can carry. */
export type FieldValue = string | number | boolean;

export interface FieldLeaf {
  node: 'leaf';
  name: string;
  value: FieldValue;
}

export interface FieldBranch {
  node: 'branch';
  name: string;
  children: FieldNode[];
}

/** A node in the Merkle field tree that forms a claim. */
export type FieldNode = FieldLeaf | FieldBranch;

export interface Signature {
  /** x-only secp256k1 public key, hex (64 chars). */
  signer: string;
  /** BIP340 Schnorr signature over the attestation digest, hex (128 chars). */
  sig: string;
}

export type AnchorStatus = 'pending' | 'confirmed';

/** Proof that the attestation digest was timestamped (OpenTimestamps). */
export interface Anchor {
  /** Name of the OtsProvider that produced the proof. */
  provider: string;
  /** Hex of the attestation digest that was stamped. */
  digest: string;
  /** Opaque provider proof blob, hex. */
  proof: string;
  status: AnchorStatus;
  /** ISO 8601 — when the digest was submitted to the provider. */
  stampedAt: string;
  /** ISO 8601 — set once status becomes 'confirmed'. */
  confirmedAt?: string;
  /** Bitcoin block height of the confirming attestation, once confirmed. */
  btcHeight?: number;
}

/**
 * The one envelope. Every attestation — all six kinds, all three tiers —
 * is this exact shape. A draft is simply an Attestation with no
 * signatures yet.
 */
export interface Attestation {
  v: 1;
  kind: AttestationKind;
  tier: TierName;
  /** Who/what the claim is about. */
  subject: string;
  /** ISO 8601. */
  issuedAt: string;
  /** The claim, as the root of a Merkle field tree. */
  claim: FieldBranch;
  signatures: Signature[];
  anchor?: Anchor;
}
