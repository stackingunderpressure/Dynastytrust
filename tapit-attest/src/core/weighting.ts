import type { Attestation, AttestationKind } from '../types.js';
import { verifyEnvelope } from './keys.js';

export interface WeightInput {
  /** The subject whose weight is being computed. */
  subject: string;
  /** Attestations to draw from; only those about `subject` are counted. */
  attestations: Attestation[];
  /** Per-signer weight lookup; missing signers contribute 0. */
  signerWeights: Record<string, number>;
  /** Count only signers whose signature actually verifies. Default true. */
  requireValidSignature?: boolean;
}

/**
 * v1 weighting — a recomputable sum. A subject's weight is the summed
 * weight of every DISTINCT signer who has vouched for that subject across
 * the given attestations. Recomputable: identical inputs always yield the
 * identical number, nothing cached or path-dependent. The richer engine
 * is the v1.1 slot below.
 */
export function computeWeight(input: WeightInput): number {
  const requireValid = input.requireValidSignature ?? true;
  const signers = new Set<string>();
  for (const attestation of input.attestations) {
    if (attestation.subject !== input.subject) continue;
    if (requireValid) {
      for (const result of verifyEnvelope(attestation).signers) {
        if (result.valid) signers.add(result.signer);
      }
    } else {
      for (const s of attestation.signatures) signers.add(s.signer);
    }
  }
  let total = 0;
  for (const signer of signers) total += input.signerWeights[signer] ?? 0;
  return total;
}

/**
 * v1.1 SLOT — the full weighting engine: recency decay,
 * corroboration-graph centrality, per-kind weighting. v1 ships
 * `computeWeight` (the recomputable sum) only.
 */
export interface WeightingPolicy {
  recencyHalfLifeMs?: number;
  perKindMultiplier?: Partial<Record<AttestationKind, number>>;
  corroborationBonus?: number;
}

export function advancedWeighting(_policy: WeightingPolicy): never {
  throw new Error('advancedWeighting is a v1.1 slot — not implemented in v1');
}
