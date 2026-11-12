/**
 * invites.js — vault invitations
 *
 * Routes (via the /api/invites/* redirect rule in netlify.toml):
 *   GET    /api/invites?vault_id=<uuid>      list invites for a vault (owner only)
 *   POST   /api/invites                      create an invite (owner only)
 *   DELETE /api/invites?id=<uuid>            revoke an invite (owner only)
 *   GET    /api/invites-lookup?token=<t>     public lookup for the claim page
 *   POST   /api/invites-claim                claim an invite (authenticated)
 *
 * The lookup and claim endpoints are separate functions (see
 * invites-lookup.js, invites-claim.js) so netlify.toml's default
 * `/api/<name>` redirect works without subpath rewrites.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { recordEvent } from "./_ledger.js";
import { randomBytes } from "node:crypto";
import { checkPathInvite } from "./_invite-rules.js";

const INVITE_FIELDS =
  "id, created_at, vault_id, invited_by, invited_role, invited_label, invited_email, leaf_id, must_sign, token, expires_at, claimed_at, claimed_by";

function newToken() {
  // 32 url-safe bytes -> 43 chars. Unlikely to collide in the token column.
  return randomBytes(32).toString("base64url");
}

async function assertOwner(supabase, vaultId, userId) {
  const { data, error } = await supabase
    .from("vaults")
    .select("id")
    .eq("id", vaultId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "Not vault owner" };
  return {};
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  // ── GET /api/invites?vault_id=<uuid> ──────────────────────────
  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing query param: vault_id" });

    const ok = await assertOwner(supabase, vaultId, u.userId);
    if (ok.error) return json(403, ok);

    const { data, error } = await supabase
      .from("vault_invites")
      .select(INVITE_FIELDS)
      .eq("vault_id", vaultId)
      .order("created_at", { ascending: false });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, invites: data });
  }

  // ── POST /api/invites ─────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { vault_id } = body;
    let { invited_role } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    // A path invite (path-builder vaults) names the path, the person and
    // their email; the role follows from the path. See _invite-rules.js.
    const isPathInvite = body.leaf_id != null;
    if (!isPathInvite && !["founder", "heir", "beneficiary", "viewer"].includes(invited_role)) {
      return json(400, { error: "Invalid invited_role" });
    }

    const ok = await assertOwner(supabase, vault_id, u.userId);
    if (ok.error) return json(403, ok);

    let pathInvite = null;
    if (isPathInvite) {
      const { data: vault, error: vErr } = await supabase
        .from("vaults").select("id, status, leaves").eq("id", vault_id).maybeSingle();
      if (vErr) return json(500, { error: vErr.message });
      // Must-sign slots already promised on this path: open invites for
      // one, and people who joined into one and are still in the vault.
      let mustSignTaken = 0;
      if (body.must_sign === true) {
        const now = Date.now();
        const { data: openInvites } = await supabase
          .from("vault_invites").select("id, expires_at, claimed_at").eq("vault_id", vault_id).eq("leaf_id", body.leaf_id).eq("must_sign", true);
        const { data: joined } = await supabase
          .from("vault_members").select("id, status").eq("vault_id", vault_id).eq("leaf_id", body.leaf_id).eq("must_sign", true);
        mustSignTaken = (openInvites ?? []).filter((i) => !i.claimed_at && (!i.expires_at || new Date(i.expires_at).getTime() > now)).length
          + (joined ?? []).filter((m) => m.status !== "removed").length;
      }
      try {
        pathInvite = checkPathInvite(vault, body, mustSignTaken);
      } catch (e) {
        return json(400, { error: e.message });
      }
      invited_role = pathInvite.role;
    }

    const insert = {
      vault_id,
      invited_by: u.userId,
      invited_role,
      invited_label: pathInvite ? pathInvite.label : body.invited_label || null,
      invited_email: pathInvite ? pathInvite.email : body.invited_email || null,
      ...(pathInvite ? { leaf_id: body.leaf_id, must_sign: pathInvite.mustSign } : {}),
      token: newToken(),
    };

    const { data, error } = await supabase
      .from("vault_invites")
      .insert(insert)
      .select(INVITE_FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await recordEvent(supabase, {
      vault_id,
      user_id: u.userId,
      event_type: "invite_created",
      // The email address is deliberately not sealed into the record.
      metadata: { invite_id: data.id, role: invited_role, ...(pathInvite ? { leaf_id: body.leaf_id, label: pathInvite.label, must_sign: pathInvite.mustSign } : {}) },
    });

    return json(201, { ok: true, invite: data });
  }

  // ── DELETE /api/invites?id=<uuid> ─────────────────────────────
  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    const { data: invite, error: lookupErr } = await supabase
      .from("vault_invites")
      .select("id, vault_id, invited_by, invited_role, invited_label, leaf_id, must_sign, claimed_at")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) return json(500, { error: lookupErr.message });
    if (!invite) return json(404, { error: "Invite not found" });

    const ok = await assertOwner(supabase, invite.vault_id, u.userId);
    if (ok.error) return json(403, ok);

    const { error } = await supabase.from("vault_invites").delete().eq("id", id);
    if (error) return json(500, { error: error.message });

    await recordEvent(supabase, {
      vault_id: invite.vault_id,
      user_id: u.userId,
      event_type: "invite_revoked",
      metadata: {
        invite_id: invite.id,
        role: invite.invited_role ?? null,
        label: invite.invited_label ?? null,
        ...(invite.leaf_id ? { leaf_id: invite.leaf_id, must_sign: Boolean(invite.must_sign) } : {}),
        was_claimed: Boolean(invite.claimed_at),
      },
    });

    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
