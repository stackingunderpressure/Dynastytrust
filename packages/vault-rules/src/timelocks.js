// Timelock rules, moved verbatim from netlify/functions/_chain.js, which
// re-exports them so every server function keeps its import (download
// slice, docs/download-and-run-build-note.md). Pure: no network.
//
// Floor and ceiling on a raw RELATIVE block offset, checked BEFORE it is
// turned into an absolute CLTV height: once absolute (tip + offset), Rust's
// own `< MIN_RECOVERY_BLOCKS` checks are structurally a no-op (Kimi K3 scan
// Family D).
export const MIN_RECOVERY_BLOCKS = 26_000;

// Ceiling on a relative offset (~100 years of blocks). Bitcoin reads an
// nLockTime of 500,000,000 or more as a calendar DATE, not a height --
// tip + a huge offset would cross that line and compile a lock that is
// already open (a date in 1985) while the record says "locked for
// thousands of years". The Rust compiler refuses such a height too
// (LOCKTIME_THRESHOLD); this stops it before it gets there.
export const MAX_TIMELOCK_OFFSET_BLOCKS = 5_256_000;

/**
 * Floor-check a raw relative block offset before conversion. 0/null/
 * undefined means "no leaf at this path" and is always allowed. Any
 * other value must be a safe positive integer >= MIN_RECOVERY_BLOCKS.
 * Returns null when valid, or a human-readable error string.
 */
export function checkTimelockFloor(value, fieldName) {
  if (!value) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return `${fieldName} must be a whole number of blocks.`;
  }
  if (value < MIN_RECOVERY_BLOCKS) {
    return `${fieldName} must be >= ${MIN_RECOVERY_BLOCKS} blocks (or 0 for no leaf).`;
  }
  if (value > MAX_TIMELOCK_OFFSET_BLOCKS) {
    return `${fieldName} must be at most ${MAX_TIMELOCK_OFFSET_BLOCKS} blocks (about 100 years).`;
  }
  return null;
}

// A tip below this is implausible for the real chain. Raise occasionally;
// never lower.
export const TIP_FLOOR = { bitcoin: 900_000, testnet: 5_000_000, signet: 300_000 };

// Honest sources differ by a block or two while a new block propagates.
// Mirrors TIP_SOURCE_MAX_DIFF in apps/web/src/lib/timelock-check.ts.
export const TIP_SOURCE_MAX_DIFF = 6;

/**
 * Reconcile two independently fetched tips. Throws when they disagree by
 * more than TIP_SOURCE_MAX_DIFF; otherwise returns the HIGHER one -- a
 * tip that is too low compiles a timelock that opens early, so when in
 * doubt the later height is the safe one.
 */
export function reconcileTips(a, b, maxDiff = TIP_SOURCE_MAX_DIFF) {
  if (Math.abs(a - b) > maxDiff) {
    throw new Error(`chain tip sources disagree: ${a} vs ${b} (more than ${maxDiff} blocks apart)`);
  }
  return Math.max(a, b);
}

/**
 * Given a relative offset in blocks and the chain tip, return the
 * absolute CLTV height. Pass through zero / null so "no timelock"
 * stays "no timelock".
 */
export function relativeToAbsolute(offsetBlocks, tipHeight) {
  if (!offsetBlocks || offsetBlocks <= 0) return 0;
  return tipHeight + offsetBlocks;
}
