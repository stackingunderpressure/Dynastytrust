/**
 * vault-membership-grants.js -- persisted "granted membership" state +
 * the accept/decline acknowledgment round trip (033_vault_membership_grants.sql,
 * operator 2026-08-11: "we need to have a return roster of it... a
 * verified member that's signed it").
 *
 * GET   /api/vault-membership-grants?vault_id=<uuid>   list this vault's grants
 *         -> { ok: true, grants: [{ id, role, key_id, recipient_label,
 *                                    recipient_persona, recipient_pubkey,
 *                                    request_event_id, reply_pubkey,
 *                                    reply_privkey, status, responded_at,
 *                                    created_at, updated_at }] }
 * POST  /api/vault-membership-grants                   create/upsert a grant
 *         body: { vault_id, role, key_id, recipient_label, recipient_persona,
 *                  recipient_pubkey, request_event_id, reply_pubkey, reply_privkey }
 *         Upserts on (vault_id, role, key_id) -- re-sending to the same
 *         member/role resets status back to 'sent' with a fresh reply
 *         keypair rather than erroring on the unique constraint.
 * PATCH /api/vault-membership-grants?id=<uuid>          record an ack
 *         body: { status: 'accepted' | 'declined' }
 *
 * reply_privkey is a Nostr messaging keypair only -- never a Bitcoin key,
 * see the migration header for why it's safe to persist unencrypted here.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });

    const { data, error } = await supabase
      .from("vault_membership_grants")
      .select("id, role, key_id, recipient_label, recipient_persona, recipient_pubkey, request_event_id, reply_pubkey, reply_privkey, status, responded_at, created_at, updated_at")
      .eq("vault_id", vaultId)
      .eq("user_id", u.userId)
      .order("created_at", { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, grants: data ?? [] });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const {
      vault_id, role, key_id, recipient_label, recipient_persona,
      recipient_pubkey, request_event_id, reply_pubkey, reply_privkey,
    } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!role) return json(400, { error: "Missing: role" });
    if (!key_id) return json(400, { error: "Missing: key_id" });
    if (!recipient_label) return json(400, { error: "Missing: recipient_label" });
    if (!recipient_pubkey) return json(400, { error: "Missing: recipient_pubkey" });
    if (!reply_pubkey) return json(400, { error: "Missing: reply_pubkey" });
    if (!reply_privkey) return json(400, { error: "Missing: reply_privkey" });

    const { data, error } = await supabase
      .from("vault_membership_grants")
      .upsert(
        {
          vault_id,
          user_id: u.userId,
          role,
          key_id,
          recipient_label,
          recipient_persona: recipient_persona ?? "",
          recipient_pubkey,
          request_event_id: request_event_id ?? null,
          reply_pubkey,
          reply_privkey,
          status: "sent",
          responded_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "vault_id,role,key_id" },
      )
      .select("id, role, key_id, recipient_label, recipient_persona, recipient_pubkey, request_event_id, reply_pubkey, reply_privkey, status, responded_at, created_at, updated_at")
      .single();
    if (error) return json(500, { error: error.message });
    return json(201, { ok: true, grant: data });
  }

  if (event.httpMethod === "PATCH") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing: id" });
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    if (body.status !== "accepted" && body.status !== "declined") {
      return json(400, { error: "status must be 'accepted' or 'declined'" });
    }

    const { data, error } = await supabase
      .from("vault_membership_grants")
      .update({ status: body.status, responded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", u.userId)
      .select("id, role, key_id, recipient_label, recipient_persona, recipient_pubkey, request_event_id, reply_pubkey, reply_privkey, status, responded_at, created_at, updated_at")
      .single();
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, grant: data });
  }

  return json(405, { error: "Method not allowed" });
}
