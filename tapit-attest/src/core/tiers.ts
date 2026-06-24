import type { Attestation, TierName } from '../types.js';

export interface TierConfig {
  /** Minimum count of distinct signers. */
  requiredSigners: number;
  /** Minimum summed weight of the distinct signers. */
  minSignerWeight: number;
  /** How long an attestation stays `pending` before it can be `final`. */
  finalityWindowMs: number;
  /** Whether a lone signer is ever enough. */
  requireCoSign: boolean;
}

const DAY = 86_400_000;

/** The three tiers as configuration dials on one primitive. */
export const DEFAULT_TIERS: Record<TierName, TierConfig> = {
  routine: {
    requiredSigners: 1,
    minSignerWeight: 0,
    finalityWindowMs: DAY,
    requireCoSign: false,
  },
  notable: {
    requiredSigners: 2,
    minSignerWeight: 10,
    finalityWindowMs: 7 * DAY,
    requireCoSign: true,
  },
  high_stakes: {
    requiredSigners: 3,
    minSignerWeight: 100,
    finalityWindowMs: 30 * DAY,
    requireCoSign: true,
  },
};

/** Resolve a tier's config, with optional per-call overrides. */
export function tierConfig(tier: TierName, overrides: Partial<TierConfig> = {}): TierConfig {
  return { ...DEFAULT_TIERS[tier], ...overrides };
}

export type TierStatus = 'pending' | 'final' | 'insufficient';

export interface TierEvaluation {
  tier: TierName;
  status: TierStatus;
  distinctSigners: number;
  summedWeight: number;
  /** Human-readable reasons the attestation is not yet `final`. */
  reasons: string[];
}

export interface EvaluateOptions {
  /** Evaluation time, ms since epoch; defaults to now. */
  now?: number;
  /** Per-signer weight lookup; missing signers count as weight 0. */
  signerWeights?: Record<string, number>;
  /** Config overrides applied on top of the tier defaults. */
  config?: Partial<TierConfig>;
}

/**
 * Evaluate an attestation against its tier. The logic is identical for
 * all three tiers — the tier only selects which config dials apply. If
 * this function ever needs a per-tier branch, that is a bug
 * (ATTESTATION_PRIMITIVE_SPEC §3).
 */
export function evaluateTier(a: Attestation, options: EvaluateOptions = {}): TierEvaluation {
  const cfg = tierConfig(a.tier, options.config);
  const weights = options.signerWeights ?? {};
  const now = options.now ?? Date.now();
  const distinct = [...new Set(a.signatures.map((s) => s.signer))];
  const summedWeight = distinct.reduce((sum, signer) => sum + (weights[signer] ?? 0), 0);

  const reasons: string[] = [];
  if (distinct.length < cfg.requiredSigners) {
    reasons.push(`needs ${cfg.requiredSigners} signer(s), has ${distinct.length}`);
  }
  if (summedWeight < cfg.minSignerWeight) {
    reasons.push(`needs signer weight ${cfg.minSignerWeight}, has ${summedWeight}`);
  }
  if (cfg.requireCoSign && distinct.length < 2) {
    reasons.push('tier requires co-signing (2+ distinct signers)');
  }
  if (reasons.length > 0) {
    return {
      tier: a.tier,
      status: 'insufficient',
      distinctSigners: distinct.length,
      summedWeight,
      reasons,
    };
  }

  const remaining = cfg.finalityWindowMs - (now - Date.parse(a.issuedAt));
  if (remaining > 0) {
    return {
      tier: a.tier,
      status: 'pending',
      distinctSigners: distinct.length,
      summedWeight,
      reasons: [`within finality window (${remaining}ms remaining)`],
    };
  }
  return {
    tier: a.tier,
    status: 'final',
    distinctSigners: distinct.length,
    summedWeight,
    reasons: [],
  };
}
