/**
 * _purse.js -- the family purse's rules, pure (no database, no network),
 * so the function, the browser and a test all hold them to one bar.
 *
 * The purse pays small amounts over Lightning once enough of the family
 * has said yes; anything at or above the on-chain threshold goes through
 * the vault itself. These are the knobs. Every one is configurable
 * (operator, 2026-11-28: "With all inputs configurable").
 */

import { createHash } from "node:crypto";
import { verifyAttestationSignature } from "./_attest.js";

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

/** The attestation type a family yes is signed under (DT-ATT-v1). */
export const YES_TYPE = "purse_payout_yes";

/**
 * What a yes commits to: this vault, this request, this amount, this road,
 * this exact invoice (by fingerprint). Any of them changing makes every
 * earlier yes stop counting. Byte-for-byte the same as
 * apps/web/src/lib/purse.ts payoutTargetHash (test-vault-purse checks).
 */
export function payoutTargetText({ vault_id, request_id, amount_sats, road, invoice_sha256 }) {
  return ["DT-PURSE-v1", vault_id, request_id, String(amount_sats), road, invoice_sha256 ?? ""].join("|");
}

/** Who may say yes: the chosen voters (or every active member), never the person being paid. */
export function canVote(settings, member, request) {
  if (!member || member.status !== "active") return false;
  if (member.user_id === request.requested_by) return false;
  const voters = Array.isArray(settings?.voters) ? settings.voters : [];
  return voters.length === 0 || voters.includes(member.id);
}

// ---- Slice 3: paying --------------------------------------------------

/** sha256 hex of the exact text every yes signs, from a stored request row. */
export function payoutTargetHash(row) {
  return createHash("sha256")
    .update(payoutTargetText({ vault_id: row.vault_id, request_id: row.id, amount_sats: row.amount_sats, road: row.road, invoice_sha256: row.invoice_sha256 }), "utf8")
    .digest("hex");
}

const xOnlyKey = (k) => {
  const s = String(k ?? "").toLowerCase();
  return /^0[23][0-9a-f]{64}$/.test(s) ? s.slice(2) : s;
};

/**
 * The yeses that still count NOW: re-checked from scratch against today's
 * members and rules, so a yes from someone since removed, or no longer a
 * voter, or a signature that does not verify, is not counted. One per
 * member. Used before anything is paid, never trusting the stored status.
 */
export function goodYeses({ yeses, members, settings, request }) {
  const target = payoutTargetHash(request);
  const seen = new Set();
  return (yeses ?? []).filter((y) => {
    if (y.request_id !== request.id || y.target_hash !== target || seen.has(y.member_id)) return false;
    const m = (members ?? []).find((x) => x.id === y.member_id);
    if (!m || !canVote(settings, m, request) || xOnlyKey(m.pubkey) !== y.pubkey) return false;
    if (!verifyAttestationSignature({ attestationType: YES_TYPE, targetHash: target, signature: y.sig, pubkey: y.pubkey })) return false;
    seen.add(y.member_id);
    return true;
  });
}

/** The first instant of the calendar month (UTC) that `now` is in. */
export function monthStartIso(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Sats already spoken for this month: paid, or started and not yet ended. */
export function spentThisMonth(payments, now = new Date()) {
  const from = monthStartIso(now);
  return (payments ?? [])
    .filter((p) => (p.status === "paid" || p.status === "started") && p.started_at >= from)
    .reduce((sum, p) => sum + Number(p.amount_sats), 0);
}
