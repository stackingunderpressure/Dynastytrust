/**
 * sent-secrets.js -- recoverable record of secrets the owner has sent
 * to circle members (see db/migrations/032_sent_secrets.sql for the
 * full why).
 *
 * GET    /api/sent-secrets?vault_id=<uuid>   list this vault's records
 *          -> { ok: true, secrets: [{ id, kind, label, recipients,
 *                                     ciphertext_b64, salt_b64, nonce_b64,
 *                                     created_at }] }
 * POST   /api/sent-secrets                   create a record
 *          body: { vault_id, kind, label, recipients, blob: { ciphertextB64, saltB64, nonceB64 } }
 * DELETE /api/sent-secrets?id=<uuid>         remove one record
 *
 * The server only ever stores ciphertext -- it never sees the password
 * or the decrypted secret fields, same posture as messaging-key-backup.js.
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
      .from("sent_secrets")
      .select("id, kind, label, recipients, ciphertext_b64, salt_b64, nonce_b64, created_at")
      .eq("vault_id", vaultId)
      .eq("user_id", u.userId)
      .order("created_at", { ascending: false });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, secrets: data ?? [] });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const { vault_id, kind, label, recipients, blob } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!kind) return json(400, { error: "Missing: kind" });
    if (!label) return json(400, { error: "Missing: label" });
    if (!blob?.ciphertextB64 || !blob?.saltB64 || !blob?.nonceB64) {
      return json(400, { error: "Missing: blob.{ciphertextB64,saltB64,nonceB64}" });
    }

    const { data, error } = await supabase
      .from("sent_secrets")
      .insert({
        vault_id,
        user_id: u.userId,
        kind,
        label,
        recipients: Array.isArray(recipients) ? recipients : [],
        ciphertext_b64: blob.ciphertextB64,
        salt_b64: blob.saltB64,
        nonce_b64: blob.nonceB64,
      })
      .select("id, kind, label, recipients, ciphertext_b64, salt_b64, nonce_b64, created_at")
      .single();
    if (error) return json(500, { error: error.message });
    return json(201, { ok: true, secret: data });
  }

  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing: id" });

    const { error } = await supabase
      .from("sent_secrets")
      .delete()
      .eq("id", id)
      .eq("user_id", u.userId);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
