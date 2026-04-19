/**
 * vault-messages.js -- E2E encrypted message CRUD.
 *
 * GET    /api/vault-messages?vault_id=<uuid>     list (member-only)
 * POST   /api/vault-messages                     send
 *          body: { vault_id, subject?, thread_id?, sender_pubkey,
 *                  nonce, ciphertext, recipients }
 *
 * The server stores + returns ciphertext + per-recipient wrapped
 * keys. It cannot read a message; decryption happens in the
 * recipient's browser with their X25519 private key.
 *
 * RLS on the table already restricts SELECT to active vault
 * members; we rely on that plus a membership check here before
 * inserting.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const FIELDS =
  "id, vault_id, sender_user_id, sender_pubkey, created_at, subject, thread_id, nonce, ciphertext, recipients";

async function assertMember(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vault_members")
    .select("id")
    .eq("vault_id", vaultId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return !!data;
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    if (!(await assertMember(supabase, vaultId, u.userId))) {
      return json(403, { error: "Not a member of this vault" });
    }
    const { data, error } = await supabase
      .from("vault_messages")
      .select(FIELDS)
      .eq("vault_id", vaultId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, messages: data });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const {
      vault_id, sender_pubkey, nonce, ciphertext,
      recipients, subject = null, thread_id = null,
    } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!sender_pubkey) return json(400, { error: "Missing: sender_pubkey" });
    if (!nonce) return json(400, { error: "Missing: nonce" });
    if (!ciphertext) return json(400, { error: "Missing: ciphertext" });
    if (!Array.isArray(recipients)) return json(400, { error: "Missing: recipients" });

    if (!(await assertMember(supabase, vault_id, u.userId))) {
      return json(403, { error: "Not a member of this vault" });
    }

    const row = {
      vault_id,
      sender_user_id: u.userId,
      sender_pubkey,
      nonce,
      ciphertext,
      recipients,
      subject,
      thread_id,
    };

    const { data, error } = await supabase
      .from("vault_messages")
      .insert(row)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id,
      user_id: u.userId,
      event_type: "message_sent",
      metadata: { message_id: data.id, recipient_count: recipients.length, subject },
    });

    return json(201, { ok: true, message: data });
  }

  return json(405, { error: "Method not allowed" });
}
