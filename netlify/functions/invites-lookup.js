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

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  const token = event.queryStringParameters?.token;
  if (!token) return json(400, { error: "Missing token" });

  const supabase = getSupabaseAdmin();

  const { data: invite, error } = await supabase
    .from("vault_invites")
    .select("id, vault_id, invited_role, invited_label, expires_at, claimed_at")
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

  const { data: vault } = await supabase
    .from("vaults")
    .select("id, name, network")
    .eq("id", invite.vault_id)
    .maybeSingle();

  return json(200, {
    ok: true,
    invite: {
      id: invite.id,
      vault_id: invite.vault_id,
      invited_role: invite.invited_role,
      invited_label: invite.invited_label,
      expires_at: invite.expires_at,
    },
    vault: vault ? { id: vault.id, name: vault.name, network: vault.network } : null,
  });
}
