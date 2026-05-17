/**
 * The three trust tiers -- expressed purely as configuration.
 *
 * routine / notable / high-stakes are NOT three code paths. They are
 * one struct of dials. `evaluateTier` runs the same logic for every
 * tier; only the numbers differ. If a tier ever needs its own branch,
 * that is a bug -- add a dial instead.
 *
 * The dials:
 *   requiredSigners    minimum distinct valid signatures
 *   minSignerWeight    minimum summed signer weight (see weighting.ts)
 *   finalityWindowMs   how long an attestation stays `pending` before
 *                      it becomes `final` (see revocation.ts)
 *   requireCoSign      true => a single signer is never enough
 */

export type TierName = 'routine' | 'notable' | 'high_stakes';

export interface TierConfig {
  readonly name: TierName;
  readonly requiredSigners: number;
  readonly minSignerWeight: number;
  readonly finalityWindowMs: number;
  readonly requireCoSign: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Default dial settings. Callers may override per-attestation. */
export const DEFAULT_TIERS: Record<TierName, TierConfig> = {
  routine: {
    name: 'routine',
    requiredSigners: 1,
    minSignerWeight: 1,
    finalityWindowMs: HOUR,
    requireCoSign: false,
  },
  notable: {
    name: 'notable',
    requiredSigners: 2,
    minSignerWeight: 3,
    finalityWindowMs: DAY,
    requireCoSign: true,
  },
  high_stakes: {
    name: 'high_stakes',
    requiredSigners: 3,
    minSignerWeight: 6,
    finalityWindowMs: 7 * DAY,
    requireCoSign: true,
  },
};

export function isTierName(v: unknown): v is TierName {
  return v === 'routine' || v === 'notable' || v === 'high_stakes';
}

export function tierConfig(tier: TierName, overrides?: Partial<TierConfig>): TierConfig {
  return { ...DEFAULT_TIERS[tier], ...overrides, name: tier };
}

export interface TierEvaluation {
  readonly ok: boolean;
  readonly signerCount: number;
  readonly totalWeight: number;
  readonly reasons: readonly string[];
}

/**
 * Check a set of valid signers against a tier's dials.
 *
 * `signerWeights` is the already-verified set of signers mapped to
 * their weight. Signature verification happens upstream; this is
 * pure arithmetic over the dials so it is trivially recomputable.
 */
export function evaluateTier(
  config: TierConfig,
  signerWeights: ReadonlyMap<string, number>,
): TierEvaluation {
  const signerCount = signerWeights.size;
  let totalWeight = 0;
  for (const w of signerWeights.values()) totalWeight += w;

  const reasons: string[] = [];
  if (signerCount < config.requiredSigners) {
    reasons.push(
      `needs ${config.requiredSigners} signers, has ${signerCount}`,
    );
  }
  if (totalWeight < config.minSignerWeight) {
    reasons.push(
      `needs weight ${config.minSignerWeight}, has ${totalWeight}`,
    );
  }
  if (config.requireCoSign && signerCount < 2) {
    reasons.push('tier requires a co-signer');
  }

  return { ok: reasons.length === 0, signerCount, totalWeight, reasons };
}
