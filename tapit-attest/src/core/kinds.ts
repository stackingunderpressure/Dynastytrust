/**
 * The six attestation kinds.
 *
 * One envelope shape carries all of them -- the kind is a label, not
 * a code path. DynastyTrust proved four governance flows; tapit-attest
 * generalizes them:
 *
 *   DynastyTrust type   -> tapit-attest kind
 *   -----------------      -------------------
 *   trust_doc           -> agreement     (multi-party commitment to terms)
 *   proof_of_life       -> relationship  (recurring corroborated continuity)
 *   death_declaration   -> meta          (lifecycle / succession signal)
 *   descriptor          -> identity      (binds key material to a subject)
 *
 * The two kinds with no DynastyTrust precedent -- `credential` and
 * `prediction` -- are first-class here because the wider network
 * tapit-attest feeds depends on them.
 */

export type AttestationKind =
  /** Who a public key belongs to. */
  | 'identity'
  /** A recurring, corroborated relationship or continuity signal. */
  | 'relationship'
  /** Something done or earned -- an achievement or credential. */
  | 'credential'
  /** A future outcome, anchored before the event so it cannot be backdated. */
  | 'prediction'
  /** A multi-party mutual commitment. */
  | 'agreement'
  /** Repudiation, revocation, or key-succession -- claims about claims. */
  | 'meta';

export const ATTESTATION_KINDS: readonly AttestationKind[] = [
  'identity',
  'relationship',
  'credential',
  'prediction',
  'agreement',
  'meta',
];

export function isAttestationKind(v: unknown): v is AttestationKind {
  return typeof v === 'string' && (ATTESTATION_KINDS as readonly string[]).includes(v);
}
