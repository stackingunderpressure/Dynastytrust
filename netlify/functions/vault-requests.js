/**
 * vault-requests.js -- distribution request queue.
 *
 * GET    /api/vault-requests?vault_id=<uuid>
 *          List requests for a vault (member-only).
 * POST   /api/vault-requests
 *          Body: { vault_id, rule_id?, rule_name?, amount_sats,
 *                  recipient_name?, reason? }
 *          Any active member (beneficiary, trustee, etc.) can
 *          open a request.
 * PATCH  /api/vault-requests?id=<uuid>
 *          Body: { status, resolution_note?, linked_proposal_id? }
 *          Trustees (role in ['owner', 'founder']) only.
 *          Approving or declining stamps resolved_by + _at.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const FIELDS =
  "id, created_at, updated_at, vault_id, requested_by, rule_id, rule_name, amount_sats, recipient_name, reason, status, linked_proposal_id, resolved_by, resolved_at, resolution_note";

async function membership(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vault_members")
    .select("id, role")
    .eq("vault_id", vaultId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return data;
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    const me = await membership(supabase, vaultId, u.userId);
    if (!me) return json(403, { error: "Not a member of this vault" });

    const { data, error } = await supabase
      .from("vault_requests")
      .select(FIELDS)
      .eq("vault_id", vaultId)
      .order("created_at", { ascending: false });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, requests: data });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
    const { vault_id, rule_id, rule_name, amount_sats, recipient_name, reason } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!amount_sats || amount_sats < 546) {
      return json(400, { error: "amount_sats must be >= 546" });
    }

    const me = await membership(supabase, vault_id, u.userId);
    if (!me) return json(403, { error: "Not a member of this vault" });

    const row = {
      vault_id,
      requested_by: u.userId,
      rule_id: rule_id || null,
      rule_name: rule_name || null,
      amount_sats,
      recipient_name: recipient_name || null,
      reason: reason || null,
      status: "pending",
    };

    const { data, error } = await supabase
      .from("vault_requests")
      .insert(row)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id,
      user_id: u.userId,
      event_type: "request_created",
      metadata: {
        request_id: data.id,
        amount_sats,
        rule_name: rule_name || null,
        recipient_name: recipient_name || null,
      },
    });

    return json(201, { ok: true, request: data });
  }

  if (event.httpMethod === "PATCH") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { data: existing } = await supabase
      .from("vault_requests")
      .select("vault_id, requested_by, status")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return json(404, { error: "Request not found" });

    const me = await membership(supabase, existing.vault_id, u.userId);
    if (!me) return json(403, { error: "Not a member of this vault" });

    // Requester can cancel their own pending request.
    // Trustees (owner/founder) can approve/decline/fulfill.
    const isRequester = existing.requested_by === u.userId;
    const isTrustee = me.role === "owner" || me.role === "founder";

    const wantsStatus = body.status;
    if (
      wantsStatus === "cancelled" && !isRequester
    ) {
      return json(403, { error: "Only the requester can cancel" });
    }
    if (
      ["approved", "declined", "fulfilled"].includes(wantsStatus) && !isTrustee
    ) {
      return json(403, { error: "Only trustees can approve, decline, or mark fulfilled" });
    }

    const allowed = ["status", "resolution_note", "linked_proposal_id"];
    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k)),
    );
    if (wantsStatus && wantsStatus !== "pending") {
      updates.resolved_by = u.userId;
      updates.resolved_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from("vault_requests")
      .update(updates)
      .eq("id", id)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id: existing.vault_id,
      user_id: u.userId,
      event_type: `request_${wantsStatus ?? "updated"}`,
      metadata: { request_id: id, resolution_note: updates.resolution_note ?? null },
    });

    return json(200, { ok: true, request: data });
  }

  return json(405, { error: "Method not allowed" });
}
