/**
 * invites-lookup.js
 *
 * GET /api/invites-lookup?token=<t>
 *
 * Public (unauthenticated) — the claim page needs to show the
 * invite details before the user has an account. Returns only
 * the fields the claim page needs: role, label, vault name,
 * inviter email (not user_id), and expiry state. Never exposes
 * anything sensitive.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { json } from "./_auth.js";
import { stripPathKeys } from "./_authz.js";
import { isLeafListVault, getSpendingPaths } from "./_vault-shape.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  const token = event.queryStringParameters?.token;
  if (!token) return json(400, { error: "Missing token" });

  const supabase = getSupabaseAdmin();

  const { data: invite, error } = await supabase
    .from("vault_invites")
    .select("id, vault_id, invited_role, invited_label, invited_email, leaf_id, must_sign, expires_at, claimed_at")
    .eq("token", token)
    .maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!invite) return json(404, { error: "Invite not found" });

  const now = Date.now();
  if (invite.claimed_at) {
    return json(410, { error: "Invite already claimed", invite: null });
  }
  if (new Date(invite.expires_at).getTime() < now) {
    return json(410, { error: "Invite expired", invite: null });
  }

  // Pull the vault record plus the shape fields the claim page
  // shows in its preview: trust doc (purpose + distribution rules
  // + beneficiaries + succession notes), quorums, timelocks, and
  // the member roster (roles + labels only, never xpubs). Enough
  // for a prospective member to decide whether to accept without
  // exposing anything sensitive.
  const { data: vault } = await supabase
    .from("vaults")
    .select(
      "id, name, network, status, address_type, founder_quorum, heir_quorum, " +
      "recovery_quorum, recovery_after, inheritance_after, " +
      "consent_quorum, trust_doc, founder_keys, heir_keys, " +
      "consent_keys, planned_founder_count, planned_heir_count, leaves",
    )
    .eq("id", invite.vault_id)
    .maybeSingle();

  // Member roster: only public-facing fields. No xpubs, no
  // fingerprints, no pubkeys -- this endpoint is unauthenticated
  // and the inviter may not want those leaked to a stranger who
  // only has the invite link.
  const { data: members } = await supabase
    .from("vault_members")
    .select("id, role, label, status, created_at")
    .eq("vault_id", invite.vault_id)
    .neq("status", "removed")
    .order("created_at", { ascending: true });

  // A path invite shows the invited person THEIR path and nothing else
  // (operator's decision, 2026-11-11): not the other paths, not the
  // other people. The email is shown masked so they know which of their
  // addresses to sign in with without the page publishing it.
  if (invite.leaf_id) {
    const path = vault ? stripPathKeys(getSpendingPaths(vault)).find((p) => p.id === invite.leaf_id) ?? null : null;
    const [local, domain] = String(invite.invited_email || "").split("@");
    return json(200, {
      ok: true,
      invite: {
        id: invite.id,
        vault_id: invite.vault_id,
        invited_role: invite.invited_role,
        invited_label: invite.invited_label,
        expires_at: invite.expires_at,
        leaf_id: invite.leaf_id,
        // The invited person's key will be one that EVERY spend on this
        // path needs (a must-sign slot), not one of the k-of-n group.
        must_sign: Boolean(invite.must_sign),
        email_hint: local && domain ? `${local.slice(0, 1)}***@${domain}` : null,
      },
      // On a draft the path's keys are not all in yet; planned_keys is how
      // many it will have, which is the "of N" the invited person needs.
      vault: vault ? {
        id: vault.id, name: vault.name, network: vault.network, status: vault.status, is_leaf_list: true,
        paths: path ? [{
          ...path,
          keyCount: (vault.leaves ?? []).find((l) => l.id === invite.leaf_id)?.planned_keys ?? path.keyCount,
          // How many keys must ALWAYS sign on this path besides the group
          // the invited person joins -- a number, never the keys themselves.
          requiredKeys: [],
          mustSignCount: (vault.leaves ?? []).find((l) => l.id === invite.leaf_id)?.planned_required ?? path.requiredKeys.length,
        }] : [],
      } : null,
      members: [],
    });
  }

  return json(200, {
    ok: true,
    invite: {
      id: invite.id,
      vault_id: invite.vault_id,
      invited_role: invite.invited_role,
      invited_label: invite.invited_label,
      expires_at: invite.expires_at,
    },
    vault: vault ? {
      id: vault.id,
      name: vault.name,
      network: vault.network,
      status: vault.status,
      address_type: vault.address_type,
      founder_quorum: vault.founder_quorum,
      heir_quorum: vault.heir_quorum,
      recovery_quorum: vault.recovery_quorum,
      recovery_after: vault.recovery_after,
      inheritance_after: vault.inheritance_after,
      consent_quorum: vault.consent_quorum,
      trust_doc: vault.trust_doc || {},
      founder_count: (vault.founder_keys || []).length,
      heir_count: (vault.heir_keys || []).length,
      consent_count: (vault.consent_keys || []).length,
      planned_founder_count: vault.planned_founder_count,
      planned_heir_count: vault.planned_heir_count,
      // 2026-08-25 fix: a leaf-list vault never populates founder_quorum/
      // heir_quorum/recovery_after/inheritance_after -- the fields above
      // were showing bogus DB-default numbers ("Trustees: 2 of ?") for
      // this vault shape. `paths` carries the vault's real spending
      // paths (leaf label/quorum/key count/timing) so InviteClaim.tsx
      // can render this shape honestly instead of the fixed
      // Trustees/Successors/Recovery/Inheritance facts.
      is_leaf_list: isLeafListVault(vault),
      // Shape only -- no keys. This endpoint is unauthenticated.
      paths: stripPathKeys(getSpendingPaths(vault)),
    } : null,
    members: members ?? [],
  });
}
