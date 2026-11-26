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
 * `members`: x-only keys allowed to clear (circleKeys: the vault's own
 * wellness checkers). A hold is open
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

/**
 * The circle: the checkers of the vault's wellness path(s), as x-only keys,
 * each one present in the vault's compiled descriptor.
 *
 * Blind review 2026-11-25, finding 2 (docs/audits/2026-11-25-blind-review-
 * new-code.md): this used to be "accepted membership grants". Those rows
 * are created, and marked accepted, by the OWNER -- the one person who may
 * be under duress -- so an owner could add grants for keys of their own,
 * sign the clears, and lift a hold the circle raised; or decline a real
 * checker's grant so that checker's raise was refused. The circle now comes
 * from the vault itself: `leaves` can't change after compile (vaults.js),
 * and each key must also appear in the descriptor the notice signs over.
 * The wellness path's must-sign keys (the owner's) are never checkers.
 */
export function circleKeys(vault) {
  const desc = String(vault?.descriptor ?? "").toLowerCase();
  const xonly = (k) => String(k ?? "").toLowerCase().slice(-64);
  const out = new Set();
  for (const leaf of Array.isArray(vault?.leaves) ? vault.leaves : []) {
    if (!leaf?.wellness) continue;
    const owners = new Set((leaf.required_keys ?? []).map(xonly));
    for (const k of leaf.keys ?? []) {
      const x = xonly(k);
      if (/^[0-9a-f]{64}$/.test(x) && !owners.has(x) && desc.includes(x)) out.add(x);
    }
  }
  return [...out];
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
  return holdState(await noticesOf(supabase, vault.id), circleKeys(vault), clearQuorum(vault)).open;
}
