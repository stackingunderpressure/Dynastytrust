// Bitcoin block-count <-> human-duration helpers, shared by anything that
// lets a user pick a timelock (recovery/inheritance durations, Bloc's
// decay-rung intervals). Relocated out of PolicyBuilder.tsx --
// unchanged logic, no longer duplicated in BlocBuilder.tsx under a
// different local name (TIMELOCK_PRESETS).

export function blocksToHuman(b: number): string {
  const days = Math.round((b * 10) / 60 / 24);
  if (days < 30) return `~${days} days`;
  if (days < 365) return `~${Math.round(days / 30)} months`;
  return `~${(days / 365).toFixed(1)} years`;
}

// Mirrors protocol::MIN_RECOVERY_BLOCKS (Rust) and netlify/functions/
// _chain.js's MIN_RECOVERY_BLOCKS -- the real minimum for ANY "after a
// fixed date" (absolute CLTV) path: recovery, inheritance, second
// inheritance, a leaf-list leaf's After unlock, and Bloc's
// parent_solo_after/kids_decay_start_after. A relative "if left
// untouched" (older()/CSV) path has NO such floor -- see
// MAX_RELATIVE_BLOCKS below and CLAUDE.md's absolute-vs-relative
// timelock rule for why the two are treated so differently. Exists here
// so the builder can warn BEFORE compile instead of only failing at the
// server with a bare "must be >= 26000 blocks" -- the server-side check
// (compile.js/compile-leaves.js/compile-bloc.js's checkTimelockFloor)
// is the one that actually enforces this; this is purely a friendlier
// client-side heads-up so a short value or an unlucky calendar-date
// pick doesn't fail silently-feeling at the very last step.
export const MIN_RECOVERY_BLOCKS = 26_000;

export const TIMELOCK_PRESETS = [
  { label: '6 months', blocks: 26_280 },
  { label: '1 year', blocks: 52_560 },
  { label: '2 years', blocks: 105_120 },
  { label: '3 years', blocks: 157_680 },
  { label: '5 years', blocks: 262_800 },
];

// ~4,380 blocks per month at 10-minute blocks (26,280 blocks = 6 months).
// Used to translate a months-based proposal (e.g. from Sage/ChatWizard)
// into the builder's block-offset inputs.
export const BLOCKS_PER_MONTH = 4_380;

// A single rung on a Dynasty Bloc vault's kids-alone decay ladder: at
// `absAfter` (an ABSOLUTE CLTV height, matching how BlocPolicy stores its
// timelocks post-compile), `q` of the kids can spend together. Same rung
// math as BlocBuilder.tsx's local `ladder` useMemo, generalized to take
// the persisted (already-absolute) policy shape instead of the builder's
// relative planning config, so VaultDetail can compute the same ladder
// for a saved vault without re-deriving the formula.
export function blocDecayLadder(bp: {
  kids_decay_start_quorum: number;
  kids_decay_floor_quorum: number;
  kids_decay_start_after: number;
  kids_decay_step_blocks: number;
}): { q: number; absAfter: number }[] {
  const out: { q: number; absAfter: number }[] = [];
  if (bp.kids_decay_floor_quorum > bp.kids_decay_start_quorum) return out;
  let q = bp.kids_decay_start_quorum;
  let rung = 0;
  while (true) {
    out.push({ q, absAfter: bp.kids_decay_start_after + rung * bp.kids_decay_step_blocks });
    if (q === bp.kids_decay_floor_quorum) break;
    q -= 1;
    rung += 1;
  }
  return out;
}
