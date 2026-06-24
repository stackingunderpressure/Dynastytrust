import type { Attestation, AttestationKind, FieldBranch, TierName } from '../types.js';
import { createDraft } from './envelope.js';

export interface BuilderInput {
  subject: string;
  tier: TierName;
  /** A plain object (converted to a field tree) or a prebuilt FieldBranch. */
  fields: Record<string, unknown> | FieldBranch;
  /** ISO 8601; defaults to now. */
  issuedAt?: string;
}

function builder(kind: AttestationKind) {
  return (input: BuilderInput): Attestation => createDraft({ kind, ...input });
}

/** Who a public key belongs to. (DynastyTrust origin: `descriptor`.) */
export const identityAttestation = builder('identity');

/** A recurring, corroborated relationship / continuity. (`proof_of_life`.) */
export const relationshipAttestation = builder('relationship');

/** Something the subject did or earned. */
export const credentialAttestation = builder('credential');

/** A future outcome, anchored before the event — reality verifies it. */
export const predictionAttestation = builder('prediction');

/** A multi-party mutual commitment. (`trust_doc`.) */
export const agreementAttestation = builder('agreement');

/**
 * A daily content entry — diary, photo, document, location note. The
 * content kind, distinct from the control-plane `meta` kind. Produced
 * often, never mutates the chain's metadata. Use this for personal
 * receipts, witnessed events, and any "this happened" record.
 */
export const journalAttestation = builder('journal');

/** Repudiation / revocation / key-succession. (`death_declaration`.) */
export const metaAttestation = builder('meta');
