/**
 * members.js — vault member CRUD
 *
 * GET    /api/members?vault_id=<uuid>   list active members of a vault
 *                                        (caller must be a member too)
 * PATCH  /api/members?id=<uuid>         update the caller's own member row
 *                                        (label, xpub, fingerprint, key_label)
 * DELETE /api/members?id=<uuid>         owner removes a member
 *                                        (sets status='removed'; rows stay for audit)
 *
 * The vault owner is seeded automatically on vault creation, so
 * there is no POST here -- members arrive via invites-claim.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const MEMBER_FIELDS =
  "id, created_at, vault_id, user_id, role, label, xpub, fingerprint, pubkey, derivation_path, key_label, status";

async function isMember(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vault_members")
    .select("id")
    .eq("vault_id", vaultId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return !!data;
}

async function isOwner(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vaults")
    .select("id")
    .eq("id", vaultId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  // ── GET /api/members?vault_id=<uuid> ──────────────────────────
  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing query param: vault_id" });

    if (!(await isMember(supabase, vaultId, u.userId))) {
      return json(403, { error: "Not a member of this vault" });
    }

    const { data, error } = await supabase
      .from("vault_members")
      .select(MEMBER_FIELDS)
      .eq("vault_id", vaultId)
      .neq("status", "removed")
      .order("created_at", { ascending: true });
    if (error) return json(500, { error: error.message });

    // Xpub privacy: every member sees labels and fingerprints so they
    // can coordinate, but full xpubs are only returned to the vault
    // owner and to the member themselves. Other members see xpub:null.
    const callerIsOwner = await isOwner(supabase, vaultId, u.userId);
    const redacted = data.map(m => {
      const visible = callerIsOwner || m.user_id === u.userId;
      return visible ? m : { ...m, xpub: null };
    });

    return json(200, { ok: true, members: redacted });
  }

  // ── PATCH /api/members?id=<uuid> ──────────────────────────────
  if (event.httpMethod === "PATCH") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { data: member, error: lookupErr } = await supabase
      .from("vault_members")
      .select("id, vault_id, user_id")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) return json(500, { error: lookupErr.message });
    if (!member) return json(404, { error: "Member not found" });

    // A member can only update their own row. The vault owner can
    // also update other members' labels (not their keys).
    const isSelf = member.user_id === u.userId;
    const ownerAccess = !isSelf && (await isOwner(supabase, member.vault_id, u.userId));
    if (!isSelf && !ownerAccess) return json(403, { error: "Cannot edit this member" });

    const selfFields = ["label", "xpub", "fingerprint", "pubkey", "derivation_path", "key_label"];
    const ownerFields = ["label"];
    const allowed = isSelf ? selfFields : ownerFields;

    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k)),
    );
    if (Object.keys(updates).length === 0) {
      return json(400, {
        error: `No updatable fields provided (allowed: ${allowed.join(", ")})`,
      });
    }

    const { data, error } = await supabase
      .from("vault_members")
      .update(updates)
      .eq("id", id)
      .select(MEMBER_FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    return json(200, { ok: true, member: data });
  }

  // ── DELETE /api/members?id=<uuid> ─────────────────────────────
  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    const { data: member, error: lookupErr } = await supabase
      .from("vault_members")
      .select("id, vault_id, user_id, role")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) return json(500, { error: lookupErr.message });
    if (!member) return json(404, { error: "Member not found" });

    if (member.role === "owner") {
      return json(400, { error: "Cannot remove the vault owner" });
    }

    if (!(await isOwner(supabase, member.vault_id, u.userId))) {
      return json(403, { error: "Only the vault owner can remove members" });
    }

    const { error } = await supabase
      .from("vault_members")
      .update({ status: "removed" })
      .eq("id", id);
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id: member.vault_id,
      user_id: u.userId,
      event_type: "member_removed",
      metadata: { member_id: id, role: member.role },
    });

    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
