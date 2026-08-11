/**
 * messaging-key-backup.js -- durable, passphrase-wrapped backup of a
 * member's X25519 messaging private key (see db/migrations/
 * 030_messaging_key_backup.sql for the full why).
 *
 * GET  /api/messaging-key-backup          fetch the caller's own backup
 *        -> { ok: true, backup: {...} | null }
 * PUT  /api/messaging-key-backup          create/replace the caller's own backup
 *        body: { pubkey, wrapped_priv_b64, salt_b64, nonce_b64 }
 *
 * The server only ever stores ciphertext -- wrapped_priv_b64 is the
 * AES-256-GCM-encrypted private key, unreadable without the passphrase
 * the browser derived the wrap key from. This endpoint never sees that
 * passphrase and cannot decrypt the blob it stores, same posture as
 * vault-messages.js for message content.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const { data, error } = await supabase
      .from("messaging_key_backups")
      .select("pubkey, wrapped_priv_b64, salt_b64, nonce_b64, updated_at")
      .eq("user_id", u.userId)
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, backup: data ?? null });
  }

  if (event.httpMethod === "PUT") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const { pubkey, wrapped_priv_b64, salt_b64, nonce_b64 } = body;
    if (!pubkey) return json(400, { error: "Missing: pubkey" });
    if (!wrapped_priv_b64) return json(400, { error: "Missing: wrapped_priv_b64" });
    if (!salt_b64) return json(400, { error: "Missing: salt_b64" });
    if (!nonce_b64) return json(400, { error: "Missing: nonce_b64" });

    const { data, error } = await supabase
      .from("messaging_key_backups")
      .upsert(
        {
          user_id: u.userId,
          pubkey,
          wrapped_priv_b64,
          salt_b64,
          nonce_b64,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .select("pubkey, wrapped_priv_b64, salt_b64, nonce_b64, updated_at")
      .single();
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, backup: data });
  }

  return json(405, { error: "Method not allowed" });
}
