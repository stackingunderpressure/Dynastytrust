/**
 * _invite-rules.js -- the rules for a person joining a path-builder
 * vault with a key made on their own device. Pure; the handlers
 * (invites.js, invites-claim.js, members.js, compile-leaves.js) apply
 * them and scripts/test-invite-rules.mjs proves them.
 *
 * The threat this closes: an invite link is a bearer token, and until
 * 2026-11-11 whoever opened one first took the slot, with whatever key
 * details they typed stored unchecked. Three independent gates now:
 *   1. the link works only for the invited email address;
 *   2. the key they submit must be a real public key that matches its
 *      own extended key (nothing private, nothing malformed);
 *   3. the owner confirms that key's fingerprint with the person, and
 *      only a confirmed key can be compiled into a vault.
 * Operator's decisions (chips, 2026-11-11): email-bound; confirmation
 * ALWAYS, test coins included; two-step sign-in to join a real-bitcoin
 * vault; a password-protected phone key or a hardware wallet.
 */
import { assertNotPrivateExtendedKey, pubkeyFromXpub } from "./_xpub.js";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** A person on an everyday path acts like a trustee; on a path that
 *  opens later, like a successor. Reuses the roles the rest of the app
 *  already understands instead of inventing a third. */
export function roleForPath(leaf) {
  return leaf?.unlock?.type === "immediate" ? "founder" : "heir";
}

/** How many must-sign slots a draft path has: what the owner planned,
 *  or the must-sign keys already placed if that is more. */
export function mustSignSlots(leaf) {
  const planned = Number.isInteger(leaf?.planned_required) ? leaf.planned_required : 0;
  return Math.max(planned, (leaf?.required_keys ?? []).length);
}

/**
 * Validate a new path invite. Returns { role, label, email, mustSign }
 * or throws with a plain message. `vault` needs { status, leaves }.
 *
 * `must_sign` asks for the path's must-sign group (keys every spend on
 * it needs). `mustSignTaken` is how many of that path's must-sign slots
 * are already promised -- open must-sign invites plus members who joined
 * into one -- so a path is never offered to more people than it has
 * must-sign slots.
 */
export function checkPathInvite(vault, { leaf_id, invited_label, invited_email, must_sign }, mustSignTaken = 0) {
  if (vault?.status !== "draft") throw new Error("People can only be invited while the vault is still being set up.");
  const leaf = (vault.leaves ?? []).find((l) => l && l.id === leaf_id);
  if (!leaf) throw new Error("That path is not part of this vault.");
  const mustSign = must_sign === true;
  if (mustSign) {
    const slots = mustSignSlots(leaf);
    if (slots === 0) throw new Error("That path has no keys that must always sign. Add one to the path first.");
    if (mustSignTaken >= slots) {
      throw new Error(`Every must-sign slot on "${leaf.label || leaf.id}" is already taken or promised to someone.`);
    }
  }
  const label = typeof invited_label === "string" ? invited_label.trim() : "";
  if (!label || label.length > 80) throw new Error("Give the person's name (up to 80 characters).");
  const email = typeof invited_email === "string" ? invited_email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) throw new Error("Give the email address this person signs in with.");
  return { role: roleForPath(leaf), label, email, mustSign };
}

/** The signed-in account must BE the invited address. */
export function emailMatches(signedInEmail, invitedEmail) {
  if (typeof signedInEmail !== "string" || typeof invitedEmail !== "string") return false;
  return signedInEmail.trim().toLowerCase() === invitedEmail.trim().toLowerCase() && invitedEmail.trim() !== "";
}

/** Joining a real-bitcoin vault needs a session that has passed the
 *  second step, whether or not the account would otherwise be let in. */
export function joinAllowedAtAal(network, aal) {
  return network !== "bitcoin" || aal === "aal2";
}

/**
 * Validate the key a joining person submits. Returns the normalized
 * { pubkey, xpub, fingerprint, derivation_path } or throws.
 * The pubkey must be the first receive child of the xpub, which is the
 * key the vault's script will actually name -- so a pasted pubkey that
 * the person's own wallet cannot sign for is refused here, not
 * discovered at spend time.
 */
export function checkClaimedKey({ pubkey, xpub, fingerprint, derivation_path }, network) {
  if (typeof xpub !== "string" || xpub.length < 100 || xpub.length > 120) throw new Error("Your key's public part (xpub) is missing or not readable.");
  assertNotPrivateExtendedKey(xpub);
  const isTestKey = /^[tuv]pub/.test(xpub);
  if ((network === "bitcoin") === isTestKey) {
    throw new Error(network === "bitcoin" ? "This is a test-coin key. A real-bitcoin vault needs a real-bitcoin key." : "This is a real-bitcoin key. This vault holds test coins and needs a test-coin key.");
  }
  let derived;
  try { derived = pubkeyFromXpub(xpub); }
  catch { throw new Error("Your key's public part (xpub) is not a valid extended public key."); }
  if (typeof pubkey !== "string" || !/^0[23][0-9a-f]{64}$/i.test(pubkey)) throw new Error("Your key's signing public key is missing or malformed.");
  if (pubkey.toLowerCase() !== derived.toLowerCase()) throw new Error("The signing key sent does not belong to the xpub sent. Nothing was saved.");
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{8}$/i.test(fingerprint)) throw new Error("Your key's fingerprint must be 8 characters, 0-9 and a-f.");
  if (typeof derivation_path !== "string" || derivation_path.length > 80 || !/^m(\/\d{1,10}'?){1,10}$/.test(derivation_path)) {
    throw new Error("Your key's derivation path is not readable (expected something like m/48'/0'/0'/2').");
  }
  return { pubkey: pubkey.toLowerCase(), xpub, fingerprint: fingerprint.toLowerCase(), derivation_path };
}

const xOnly = (pubkeyHex) => String(pubkeyHex).toLowerCase().slice(-64);

/**
 * Keys in `leaves` that belong to a member other than the owner and
 * have NOT been confirmed by the owner. Compile refuses if any exist.
 * A key that matches no member is the owner's own (picked, made or
 * pasted on their device) and is theirs to vouch for. Matching is by
 * x-only key, so the 02/03 twin of an unconfirmed key is caught too.
 */
export function unconfirmedMemberKeys(leaves, members, ownerUserId) {
  const byKey = new Map();
  for (const m of members ?? []) {
    if (!m?.pubkey || m.status === "removed" || m.user_id === ownerUserId) continue;
    byKey.set(xOnly(m.pubkey), m);
  }
  const out = [];
  for (const leaf of leaves ?? []) {
    for (const k of [...(leaf?.keys ?? []), ...(leaf?.required_keys ?? [])]) {
      const m = byKey.get(xOnly(k));
      if (m && !m.key_confirmed_at) out.push({ member: m.label || "a member", path: leaf.label || leaf.id });
    }
  }
  return out;
}

/**
 * What an invited person may see of a vault that is still being set
 * up: their own path, without anyone's keys, and none of the other
 * paths (operator's decision, 2026-11-11). The owner, a finalized
 * vault, and vaults of the older shapes are returned untouched.
 * `membership` is the caller's own vault_members row.
 */
export function draftViewForMember(vault, membership, callerUserId) {
  const isPathDraft = vault?.status === "draft" && Array.isArray(vault.leaves) && vault.leaves.length > 0;
  if (!isPathDraft || vault.user_id === callerUserId) return vault;
  const mine = vault.leaves.filter((l) => l && l.id === membership?.leaf_id).map((l) => ({ ...l, keys: [], ...(l.required_keys !== undefined ? { required_keys: [] } : {}) }));
  return { ...vault, leaves: mine, consent_keys: [], key_labels: [], key_origins: null, trust_doc: {} };
}

/** Who an invited person may see listed on a vault still being set up:
 *  themselves and the owner (by name only). */
export function draftRosterForMember(members, vault, callerUserId) {
  const isPathDraft = vault?.status === "draft" && Array.isArray(vault.leaves) && vault.leaves.length > 0;
  if (!isPathDraft || vault.user_id === callerUserId) return members;
  return (members ?? [])
    .filter((m) => m.user_id === callerUserId || m.user_id === vault.user_id)
    .map((m) => (m.user_id === callerUserId ? m : { id: m.id, vault_id: m.vault_id, user_id: m.user_id, role: m.role, label: m.label, status: m.status, created_at: m.created_at }));
}
