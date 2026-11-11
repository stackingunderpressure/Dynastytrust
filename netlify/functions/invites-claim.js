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
import { recordEvent } from "./_ledger.js";
import { emailMatches, joinAllowedAtAal, checkClaimedKey } from "./_invite-rules.js";

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
    .select("id, vault_id, invited_role, invited_label, invited_email, leaf_id, expires_at, claimed_at")
    .eq("token", token)
    .maybeSingle();
  if (lookupErr) return json(500, { error: lookupErr.message });
  if (!invite) return json(404, { error: "Invite not found" });
  if (invite.claimed_at) return json(409, { error: "Invite already claimed" });
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return json(410, { error: "Invite expired" });
  }

  // Reject if this user is already a member of this vault. This catches
  // the common foot-gun where a vault owner clicks an invite link meant
  // for someone else (e.g. to test) while logged in as themselves: the
  // old logic silently consumed the invite and left the intended
  // recipient unable to claim it later. Now the invite stays unclaimed
  // and the intended recipient can still use the link.
  const { data: existing } = await supabase
    .from("vault_members")
    .select("id, role, label")
    .eq("vault_id", invite.vault_id)
    .eq("user_id", u.userId)
    .neq("status", "removed")
    .maybeSingle();

  if (existing) {
    return json(409, {
      error:
        "You are already a member of this vault (as " +
        (existing.label || existing.role) +
        "). Share this invite link with the intended recipient; they must " +
        "be logged in as themselves -- not you -- to claim it.",
      already_member: true,
      member_id: existing.id,
      vault_id: invite.vault_id,
    });
  }

  // A path invite (path-builder vaults) is for one named person and
  // must arrive with their key. All three checks run BEFORE the invite
  // is consumed, so a refused attempt leaves it usable by the right
  // person. See _invite-rules.js for what each one closes.
  let claimedKey = null;
  if (invite.leaf_id) {
    if (!emailMatches(u.claims?.email, invite.invited_email)) {
      return json(403, { error: "This invite is for a different email address. Sign in with the address it was sent to." });
    }
    const { data: vault, error: vErr } = await supabase
      .from("vaults").select("id, network, status").eq("id", invite.vault_id).maybeSingle();
    if (vErr) return json(500, { error: vErr.message });
    if (!vault) return json(404, { error: "This vault no longer exists." });
    if (vault.status !== "draft") {
      return json(409, { error: "This vault has already been finalized, so nobody new can join it." });
    }
    if (!joinAllowedAtAal(vault.network, u.claims?.aal)) {
      return json(403, {
        error: "Joining a real-bitcoin vault needs two-step sign-in. Turn it on under Keys, sign in again with your code, then open this link again.",
        needs_two_step: true,
      });
    }
    try {
      claimedKey = checkClaimedKey(body, vault.network);
    } catch (e) {
      return json(400, { error: e.message });
    }
    const { data: clash } = await supabase
      .from("vault_members").select("id").eq("vault_id", invite.vault_id).eq("fingerprint", claimedKey.fingerprint).neq("status", "removed").maybeSingle();
    if (clash) return json(409, { error: "A key with this fingerprint is already in this vault. Each person needs their own key." });
  }

  // Claim the invite FIRST, atomically: the update only matches while
  // claimed_at is still null, so two accounts racing on one token cannot
  // both pass (previously both read claimed_at = null, both inserted a
  // member row, and one invite minted two members in the invited role).
  const { data: claimedRows, error: claimErr } = await supabase
    .from("vault_invites")
    .update({ claimed_at: new Date().toISOString(), claimed_by: u.userId })
    .eq("id", invite.id)
    .is("claimed_at", null)
    .select("id");
  if (claimErr) return json(500, { error: claimErr.message });
  if (!claimedRows || claimedRows.length === 0) {
    return json(409, { error: "Invite already claimed" });
  }

  const { data: member, error: memberErr } = await supabase
    .from("vault_members")
    .insert({
      vault_id: invite.vault_id,
      user_id: u.userId,
      role: invite.invited_role,
      label: body.label || invite.invited_label || null,
      xpub: claimedKey ? claimedKey.xpub : body.xpub || null,
      fingerprint: claimedKey ? claimedKey.fingerprint : body.fingerprint || null,
      pubkey: claimedKey ? claimedKey.pubkey : body.pubkey || null,
      derivation_path: claimedKey ? claimedKey.derivation_path : body.derivation_path || null,
      key_label: body.key_label || null,
      ...(invite.leaf_id ? { leaf_id: invite.leaf_id } : {}),
      status: "active",
    })
    .select("id")
    .single();
  if (memberErr) {
    // Release the claim so the invite is not burned by a failed join.
    await supabase
      .from("vault_invites")
      .update({ claimed_at: null, claimed_by: null })
      .eq("id", invite.id)
      .eq("claimed_by", u.userId);
    return json(500, { error: memberErr.message });
  }
  const memberId = member.id;

  await recordEvent(supabase, {
    vault_id: invite.vault_id,
    user_id: u.userId,
    event_type: "member_joined",
    metadata: { member_id: memberId, role: invite.invited_role, via_invite: invite.id, ...(claimedKey ? { leaf_id: invite.leaf_id, fingerprint: claimedKey.fingerprint } : {}) },
  });

  return json(200, { ok: true, member_id: memberId, vault_id: invite.vault_id });
}
