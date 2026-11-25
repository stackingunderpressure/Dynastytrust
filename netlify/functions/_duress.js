// A wellness checker's duress stops the whole circle
// (docs/wellness-group-build-note.md, slice 2). Pure rules shared by
// vault-duress.js (the notices) and vaults.js (the owner's own halt switch).
//
// A notice is signed by the checker's own Tapit key over
//   sha256("dynastytrust-vault-duress:v1\n<kind>\n<vault descriptor>\n<signed_at ISO>")
// -- the same bytes Tapit builds (src/features/duress/vaultDuress.ts).

import { sha256 } from "@noble/hashes/sha256";
import { schnorr } from "@noble/curves/secp256k1";

/** A notice older or newer than this is refused (no replaying old ones). */
export const NOTICE_WINDOW_MS = 10 * 60 * 1000;

export function noticeDigest(kind, descriptor, signedAt) {
  return sha256(new TextEncoder().encode(`dynastytrust-vault-duress:v1\n${kind}\n${descriptor}\n${signedAt}`));
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** Shape + signature + freshness of a notice; returns a reason or null. */
export function noticeProblem(n, now = Date.now()) {
  if (!n || typeof n !== "object") return "not readable";
  if (n.kind !== "raise" && n.kind !== "clear") return "kind must be raise or clear";
  if (typeof n.descriptor !== "string" || n.descriptor.length < 10 || n.descriptor.length > 20_000) return "descriptor not readable";
  if (typeof n.pubkey !== "string" || !HEX64.test(n.pubkey)) return "pubkey not readable";
  if (typeof n.sig !== "string" || !HEX128.test(n.sig)) return "signature not readable";
  const t = Date.parse(n.signed_at);
  if (typeof n.signed_at !== "string" || !Number.isFinite(t)) return "signed_at not readable";
  if (Math.abs(now - t) > NOTICE_WINDOW_MS) return "too old or from the future";
  try {
    if (!schnorr.verify(n.sig, noticeDigest(n.kind, n.descriptor, n.signed_at), n.pubkey)) return "signature does not verify";
  } catch {
    return "signature does not verify";
  }
  return null;
}

/** How many checkers must sign a clear: the vault's largest wellness-path
 *  quorum (the circle that guards it), at least 1. */
export function clearQuorum(vault) {
  const qs = (Array.isArray(vault?.leaves) ? vault.leaves : []).filter((l) => l?.wellness).map((l) => Number(l.quorum) || 0);
  return Math.max(1, ...qs);
}

/**
 * Where a vault's circle hold stands, from its notices (oldest first).
 * `members`: x-only keys allowed to clear (accepted grants). A hold is open
 * from the latest 'raise' until, after it, the owner has asked to clear AND
 * `quorum` distinct members have each signed a clear.
 */
export function holdState(notices, members, quorum) {
  const raises = notices.filter((n) => n.kind === "raise");
  if (!raises.length) return { open: false, clears: 0, needed: quorum, ownerCleared: false };
  const since = Math.max(...raises.map((n) => Date.parse(n.created_at)));
  const after = notices.filter((n) => Date.parse(n.created_at) >= since);
  const ok = new Set(members.map((m) => m.toLowerCase()));
  const clears = new Set(after.filter((n) => n.kind === "clear" && ok.has(String(n.signer_pubkey).toLowerCase())).map((n) => n.signer_pubkey.toLowerCase())).size;
  const ownerCleared = after.some((n) => n.kind === "owner_clear");
  return { open: !(ownerCleared && clears >= quorum), clears, needed: quorum, ownerCleared, raisedAt: new Date(since).toISOString() };
}

/** Accepted Tapit members of a vault (x-only, lower case). */
export async function acceptedMembers(supabase, vaultId) {
  const { data, error } = await supabase
    .from("vault_membership_grants").select("recipient_pubkey").eq("vault_id", vaultId).eq("status", "accepted");
  if (error) throw new Error(error.message);
  return [...new Set((data ?? []).map((g) => String(g.recipient_pubkey).toLowerCase()))];
}

/** A vault's notices, oldest first. */
export async function noticesOf(supabase, vaultId) {
  const { data, error } = await supabase
    .from("vault_duress_notices").select("kind, signer_pubkey, created_at").eq("vault_id", vaultId).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Is a circle hold open on this vault right now? */
export async function circleHoldOpen(supabase, vault) {
  const [notices, members] = await Promise.all([noticesOf(supabase, vault.id), acceptedMembers(supabase, vault.id)]);
  return holdState(notices, members, clearQuorum(vault)).open;
}
