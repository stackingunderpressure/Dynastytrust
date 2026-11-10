/**
 * _authz.js -- the authorization rules every Netlify function shares.
 *
 * All of these functions use the Supabase service-role key, which
 * bypasses row-level security, so each handler is its own gatekeeper.
 * A 2026-11-10 audit of all 40 found the same two mistakes repeated:
 * "is an active member" was treated as "may change this", and exports
 * returned whole rows where the regular endpoints redact. The rules now
 * live here once, pure and tested (scripts/test-authz.mjs), instead of
 * being re-derived (and sometimes forgotten) per endpoint.
 */

/** Roles that may look but never change anything. `viewer` is the only
 *  one: founders/heirs sign, beneficiaries consent-sign and claim
 *  tranches, the owner administers. */
const READ_ONLY_ROLES = new Set(["viewer"]);

/** May this member role create or change vault records at all? */
export function canMutate(role) {
  return typeof role === "string" && role.length > 0 && !READ_ONLY_ROLES.has(role);
}

/** Proposal states that are the permanent record of what happened. */
export const TERMINAL_PROPOSAL_STATUSES = ["broadcast", "cancelled", "fulfilled"];
export function isTerminalProposalStatus(status) {
  return TERMINAL_PROPOSAL_STATUSES.includes(status);
}

/**
 * A member row as another member may see it. Full xpubs go only to the
 * vault owner and to the member themselves (the same rule members.js
 * applies on its list endpoint) -- labels and fingerprints stay so
 * people can coordinate.
 */
export function redactMember(member, { callerIsOwner, callerUserId }) {
  if (callerIsOwner || member.user_id === callerUserId) return member;
  return { ...member, xpub: null };
}

/**
 * An invite row as it may leave the server. The `token` IS the
 * credential to join the vault in the invited role, so it never leaves
 * in an export, for anyone. The invited email is the owner's business.
 */
export function redactInvite(invite, { callerIsOwner }) {
  // eslint-disable-next-line no-unused-vars
  const { token, ...rest } = invite;
  return callerIsOwner ? rest : { ...rest, invited_email: null };
}

/** Spending paths for an unauthenticated viewer: shape without keys. */
export function stripPathKeys(paths) {
  // eslint-disable-next-line no-unused-vars
  return (paths ?? []).map(({ keys, ...rest }) => rest);
}

/**
 * The only thing a PATCH may change on a distribution wallet's tranches
 * is funded_txid / claimed_txid. Each result row is the STORED row with
 * just those two fields taken from the request -- so nothing else the
 * client sends (changed or extra keys) is ever written. A non-owner may
 * only fill in a txid that is currently empty; clearing or replacing a
 * recorded one is the owner's call. Returns { ok, error?, tranches? }.
 */
const TXID_RE = /^[0-9a-f]{64}$/i;
export function sanitizeTrancheUpdate(prior, next, { callerIsOwner }) {
  if (!Array.isArray(prior) || !Array.isArray(next) || next.length !== prior.length) {
    return { ok: false, error: "tranches must be the same length as the existing array" };
  }
  const out = [];
  for (let i = 0; i < prior.length; i++) {
    const row = { ...prior[i] };
    for (const f of ["funded_txid", "claimed_txid"]) {
      const before = prior[i]?.[f] ?? null;
      const after = next[i]?.[f] ?? null;
      if (after !== null && (typeof after !== "string" || !TXID_RE.test(after))) {
        return { ok: false, error: `tranches[${i}].${f} must be a 64-char hex transaction id` };
      }
      if (!callerIsOwner && before !== null && after !== before) {
        return { ok: false, error: `tranches[${i}].${f} is already recorded; only the vault owner can change it` };
      }
      row[f] = after;
    }
    out.push(row);
  }
  return { ok: true, tranches: out };
}

/** A heartbeat may only replace an OLDER one for the same subject. */
export function isNewerProof(existingIssuedAt, incomingIssuedAt) {
  const a = Date.parse(existingIssuedAt);
  const b = Date.parse(incomingIssuedAt);
  if (!Number.isFinite(b)) return false;
  if (!Number.isFinite(a)) return true;
  return b > a;
}

/** The caller's active membership row ({ id, role }) or null. */
export async function activeMembership(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vault_members")
    .select("id, role")
    .eq("vault_id", vaultId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return data ?? null;
}

/** Is the caller the vault's owner (vaults.user_id)? */
export async function isVaultOwner(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vaults")
    .select("id")
    .eq("id", vaultId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}
