// Bitcoin block-count <-> human-duration helpers, shared by anything that
// lets a user pick a timelock (recovery/inheritance/protector durations,
// Bloc's decay-rung intervals). Relocated out of PolicyBuilder.tsx --
// unchanged logic, no longer duplicated in BlocBuilder.tsx under a
// different local name (TIMELOCK_PRESETS).

export function blocksToHuman(b: number): string {
  const days = Math.round((b * 10) / 60 / 24);
  if (days < 30) return `~${days} days`;
  if (days < 365) return `~${Math.round(days / 30)} months`;
  return `~${(days / 365).toFixed(1)} years`;
}

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
