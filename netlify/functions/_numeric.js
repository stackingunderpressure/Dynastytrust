/**
 * _numeric.js -- shared "is this actually a usable number" check for
 * request-body fields that feed fee/amount/quorum arithmetic.
 *
 * The bug pattern this closes: every existing range check in this
 * codebase was written as `x < MIN || x > MAX` (or just `!x`) without
 * first confirming `x` is a real, finite number. `NaN < MIN` and
 * `NaN > MAX` are both false, and `!NaN` is true just like `!0`, so a
 * non-numeric value (a string, an object, a literal NaN/Infinity, or a
 * string that JS coerces oddly) sails through untouched -- the bound
 * was never actually checked (Kimi K3 scan Family D).
 */

/** True only for a finite, non-NaN JS number. */
export function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// A caller-supplied fee_rate had no upper bound in any of the four
// endpoints that accept one -- a request (or a compromised coordinator
// forging one on a legitimate user's behalf) could set an absurd sat/vB
// rate and drain most of a spend into miner fees instead of the
// intended destination. 1000 sat/vB is far above any real-world fee
// market spike and still bounds the damage to a deliberately malicious
// request, not normal use. 1 sat/vB floor rejects a zero-or-negative
// rate outright. Was independently duplicated in psbt-binary.js,
// psbt-binary-bloc.js, and psbt-binary-tranche.js; centralized here so
// proposals.js (which stores fee_rate as plain metadata, no PSBT built
// from it) can apply the identical bound rather than accepting anything.
export const MIN_FEE_RATE_SAT_VB = 1;
export const MAX_FEE_RATE_SAT_VB = 1000;

/**
 * Validate a numeric field against explicit bounds, requiring it be a
 * real finite number first. Returns null when valid, or a
 * human-readable error string naming the field (suitable for a 400
 * response). `integer: true` additionally requires
 * Number.isSafeInteger -- sat amounts, block counts, quorum counts:
 * anything that must be a whole number, never a float.
 */
export function checkNumberBounds(value, { field, min = -Infinity, max = Infinity, integer = false }) {
  if (!isFiniteNumber(value)) {
    return `${field} must be a finite number.`;
  }
  if (integer && !Number.isSafeInteger(value)) {
    return `${field} must be a whole number.`;
  }
  if (value < min || value > max) {
    return `${field} must be between ${min} and ${max}.`;
  }
  return null;
}
