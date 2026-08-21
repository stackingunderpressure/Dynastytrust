/**
 * Signer weighting.
 *
 * Not every signer counts equally. A weight table maps a public key
 * to a weight; an attestation's weight is the sum over its VALID
 * signers. The computation is deliberately pure and recomputable --
 * given the same envelope and table, anyone derives the same number,
 * with no hidden server state. This is what `evaluateTier` consumes.
 *
 * v1 ships the recomputable sum. The richer engine -- recency decay,
 * corroboration graphs, per-kind weighting -- is a named v1.1 slot
 * (`WeightingPolicy` / `advancedWeighting` below).
 */

import { verifyEnvelope } from './sign.js';
import type { AttestationEnvelope } from './envelope.js';

/** Public key -> weight. Keys absent from the table default to 1. */
export type WeightTable = ReadonlyMap<string, number>;

export interface WeightResult {
  readonly totalWeight: number;
  /** Valid signer -> weight applied. */
  readonly perSigner: ReadonlyMap<string, number>;
  /** Signers whose signature did not verify -- contribute nothing. */
  readonly ignoredSigners: readonly string[];
}

/**
 * Compute an attestation's weight from a weight table. Only signers
 * whose signature verifies contribute. Unknown signers default to a
 * weight of 1 so an attestation is never silently worth zero.
 */
export function computeWeight(
  env: AttestationEnvelope,
  table: WeightTable = new Map(),
): WeightResult {
  const verification = verifyEnvelope(env);
  const perSigner = new Map<string, number>();
  let totalWeight = 0;
  for (const signer of verification.validSigners) {
    const raw = table.get(signer) ?? 1;
    // Defensive floor regardless of where the table came from: a
    // negative or non-finite entry must never subtract from or blow up
    // the sum. See sign.ts's sanitizeWeight for the same clamp applied
    // to the per-signature declared weight.
    const w = Number.isFinite(raw) && raw > 0 ? raw : 1;
    perSigner.set(signer, w);
    totalWeight += w;
  }
  return {
    totalWeight,
    perSigner,
    ignoredSigners: verification.invalidSigners,
  };
}

/**
 * v1.1+ SLOT -- the full weighting engine.
 *
 * Will fold in recency decay, corroboration-graph centrality, and
 * per-kind weighting. v1 callers should use `computeWeight`.
 */
export interface WeightingPolicy {
  weightFor(signer: string, env: AttestationEnvelope): number;
}

export function advancedWeighting(_policy: WeightingPolicy): never {
  throw new Error('advancedWeighting: v1.1 slot, not implemented in v1');
}
