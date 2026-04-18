/**
 * invites-claim.js
 *
 * POST /api/invites-claim
 * Body: { token: string, label?: string, xpub?: string,
 *         fingerprint?: string, key_label?: string }
 *
 * Authenticated. Claims an invite:
 *   1. Look up the invite by token (must be unexpired and unclaimed)
 *   2. Insert a vault_members row with the calling user
 *   3. Mark the invite claimed
 *
 * xpub/fingerprint/key_label are optional here -- the user can
 * claim the slot first and provision their key later via
 * /api/members PATCH. A founder/heir member without a key can't
 * sign proposals; the UI surfaces this.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const token = body.token;
  if (!token) return json(400, { error: "Missing: token" });

  const supabase = getSupabaseAdmin();

  const { data: invite, error: lookupErr } = await supabase
    .from("vault_invites")
    .select("id, vault_id, invited_role, invited_label, expires_at, claimed_at")
    .eq("token", token)
    .maybeSingle();
  if (lookupErr) return json(500, { error: lookupErr.message });
  if (!invite) return json(404, { error: "Invite not found" });
  if (invite.claimed_at) return json(409, { error: "Invite already claimed" });
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return json(410, { error: "Invite expired" });
  }

  // Reject if this user is already a member of this vault (idempotent claim
  // still succeeds -- we mark the invite consumed but don't duplicate the row).
  const { data: existing } = await supabase
    .from("vault_members")
    .select("id")
    .eq("vault_id", invite.vault_id)
    .eq("user_id", u.userId)
    .maybeSingle();

  let memberId;
  if (existing) {
    memberId = existing.id;
  } else {
    const { data: member, error: memberErr } = await supabase
      .from("vault_members")
      .insert({
        vault_id: invite.vault_id,
        user_id: u.userId,
        role: invite.invited_role,
        label: body.label || invite.invited_label || null,
        xpub: body.xpub || null,
        fingerprint: body.fingerprint || null,
        pubkey: body.pubkey || null,
        derivation_path: body.derivation_path || null,
        key_label: body.key_label || null,
        status: "active",
      })
      .select("id")
      .single();
    if (memberErr) return json(500, { error: memberErr.message });
    memberId = member.id;
  }

  // Mark invite consumed. If the update races, the member row still exists
  // so the user isn't left without access.
  await supabase
    .from("vault_invites")
    .update({ claimed_at: new Date().toISOString(), claimed_by: u.userId })
    .eq("id", invite.id);

  await supabase.from("vault_events").insert({
    vault_id: invite.vault_id,
    user_id: u.userId,
    event_type: "member_joined",
    metadata: { member_id: memberId, role: invite.invited_role, via_invite: invite.id },
  });

  return json(200, { ok: true, member_id: memberId, vault_id: invite.vault_id });
}
