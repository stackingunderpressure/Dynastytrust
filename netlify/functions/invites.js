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
import { randomBytes } from "node:crypto";

const INVITE_FIELDS =
  "id, created_at, vault_id, invited_by, invited_role, invited_label, invited_email, token, expires_at, claimed_at, claimed_by";

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

    const { vault_id, invited_role } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!["founder", "heir", "protector", "beneficiary", "viewer"].includes(invited_role)) {
      return json(400, { error: "Invalid invited_role" });
    }

    const ok = await assertOwner(supabase, vault_id, u.userId);
    if (ok.error) return json(403, ok);

    const insert = {
      vault_id,
      invited_by: u.userId,
      invited_role,
      invited_label: body.invited_label || null,
      invited_email: body.invited_email || null,
      token: newToken(),
    };

    const { data, error } = await supabase
      .from("vault_invites")
      .insert(insert)
      .select(INVITE_FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id,
      user_id: u.userId,
      event_type: "invite_created",
      metadata: { invite_id: data.id, role: invited_role },
    });

    return json(201, { ok: true, invite: data });
  }

  // ── DELETE /api/invites?id=<uuid> ─────────────────────────────
  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    const { data: invite, error: lookupErr } = await supabase
      .from("vault_invites")
      .select("id, vault_id, invited_by")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) return json(500, { error: lookupErr.message });
    if (!invite) return json(404, { error: "Invite not found" });

    const ok = await assertOwner(supabase, invite.vault_id, u.userId);
    if (ok.error) return json(403, ok);

    const { error } = await supabase.from("vault_invites").delete().eq("id", id);
    if (error) return json(500, { error: error.message });

    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
