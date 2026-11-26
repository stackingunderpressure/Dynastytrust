import { type StipendInterval } from "../../lib/api";
import { colors } from "../../theme";
import { sha256 } from "@noble/hashes/sha256";

function toHexBytes(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Stable binding identity for a PSBT's hex, mirroring BlocBuilder.tsx's
// psbtBindingHash. Only meaningful compared against ANOTHER hash of the
// exact same pristine, pre-signature hex -- see signWithKey's comment on
// why it is only checked against the first signature in a session.
export function psbtBindingHash(psbtHex: string): string {
  return toHexBytes(sha256(new TextEncoder().encode(psbtHex)));
}


export function satsToBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0";
}

// Step a date forward by a stipend interval. Month/quarter/year
// arithmetic uses calendar-anchored addition so "monthly" stays on
// the same day-of-month, not 30d intervals that drift.
export function advanceDueDate(from: Date, interval: StipendInterval): Date {
  const d = new Date(from.getTime());
  if (interval === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (interval === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (interval === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (interval === "annually") d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

export function intervalLabel(k: StipendInterval): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

export function blocksToLabel(blocks: number): string {
  if (!blocks) return "--";
  const days = Math.round(blocks * 10 / 60 / 24);
  if (days < 30) return "~" + days + " days";
  if (days < 365) return "~" + Math.round(days / 30) + " months";
  return "~" + (days / 365).toFixed(1) + " years";
}

export function statusColor(s: string): string {
  if (s === "broadcast") return colors.green;
  if (s === "signed") return colors.gold;
  if (s === "cancelled") return colors.muted;
  return colors.blue;
}

// Map schema role to trust-deed wording shown across the UI.
// owner, founder -> trustee; heir -> successor trustee; viewer ->
// observer. Keeping the schema names stable keeps DB queries and
// RLS policies unchanged.
export function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "Primary trustee";
    case "founder":
      return "Trustee";
    case "heir":
      return "Successor trustee";
    case "protector":
      return "Protector";
    case "viewer":
      return "Observer";
    case "beneficiary":
      return "Beneficiary";
    default:
      return role;
  }
}

export function isTrusteeRole(role: string): boolean {
  return role === "owner" || role === "founder";
}
