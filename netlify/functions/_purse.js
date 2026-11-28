/**
 * _purse.js -- the family purse's rules, pure (no database, no network),
 * so the function, the browser and a test all hold them to one bar.
 *
 * The purse pays small amounts over Lightning once enough of the family
 * has said yes; anything at or above the on-chain threshold goes through
 * the vault itself. These are the knobs. Every one is configurable
 * (operator, 2026-11-28: "With all inputs configurable").
 */

export const PURSE_DEFAULTS = Object.freeze({
  approvals_needed: 3,
  /** vault_members ids whose yes counts; empty = every active member. */
  voters: [],
  /** vault_members id of the person whose wallet pays; null = not chosen yet. */
  treasurer_member_id: null,
  per_payout_limit_sats: 100_000,
  monthly_cap_sats: 300_000,
  onchain_threshold_sats: 1_000_000,
  refill_sats: 500_000,
  request_expiry_days: 14,
});

const MAX_SATS = 100_000_000; // 1 BTC: a purse is small by design

function int(v) {
  return typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
}

/**
 * Check and normalise proposed settings against the vault's active
 * members. Returns { ok: true, settings } or { ok: false, error } with a
 * plain sentence a person can act on.
 */
export function validatePurseSettings(input, memberIds) {
  const s = { ...PURSE_DEFAULTS, ...(input && typeof input === "object" ? input : {}) };
  const members = new Set(memberIds ?? []);
  const out = {};

  const voters = Array.isArray(s.voters) ? [...new Set(s.voters.filter((v) => typeof v === "string"))] : null;
  if (!voters) return { ok: false, error: "Voters must be a list of family members." };
  const unknown = voters.find((v) => !members.has(v));
  if (unknown) return { ok: false, error: "A voter is not an active member of this vault." };
  out.voters = voters;
  const voterCount = voters.length || members.size;

  const needed = int(s.approvals_needed);
  if (!(needed >= 1)) return { ok: false, error: "Yeses needed must be at least 1." };
  if (needed > voterCount) return { ok: false, error: `Yeses needed (${needed}) is more than the ${voterCount} people who can vote.` };
  out.approvals_needed = needed;

  if (s.treasurer_member_id !== null && s.treasurer_member_id !== undefined && s.treasurer_member_id !== "") {
    if (!members.has(s.treasurer_member_id)) return { ok: false, error: "The treasurer must be an active member of this vault." };
    out.treasurer_member_id = s.treasurer_member_id;
  } else out.treasurer_member_id = null;

  for (const [k, label, min] of [
    ["per_payout_limit_sats", "The most one payout can be", 1],
    ["monthly_cap_sats", "The monthly cap", 1],
    ["onchain_threshold_sats", "The on-chain threshold", 1],
    ["refill_sats", "The refill size", 0],
  ]) {
    const v = int(s[k]);
    if (!(v >= min) || v > MAX_SATS) return { ok: false, error: `${label} must be between ${min.toLocaleString("en-US")} and ${MAX_SATS.toLocaleString("en-US")} sats.` };
    out[k] = v;
  }
  if (out.monthly_cap_sats < out.per_payout_limit_sats) return { ok: false, error: "The monthly cap cannot be smaller than one payout." };
  if (out.per_payout_limit_sats > out.onchain_threshold_sats) {
    return { ok: false, error: "One Lightning payout cannot be bigger than the on-chain threshold; above that, payouts go through the vault." };
  }

  const days = int(s.request_expiry_days);
  if (!(days >= 1 && days <= 90)) return { ok: false, error: "A request must last between 1 and 90 days." };
  out.request_expiry_days = days;

  return { ok: true, settings: out };
}

/** Which keys changed, for the ledger entry. */
export function changedKeys(before, after) {
  return Object.keys(after).filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after[k]));
}
