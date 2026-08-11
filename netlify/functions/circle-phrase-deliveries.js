/**
 * circle-phrase-deliveries.js -- persisted send-status for the circle
 * safety phrase pair (034_circle_phrase_deliveries.sql, operator: "these
 * phrases should show they've been sent and not do it again and again").
 *
 * GET  /api/circle-phrase-deliveries?vault_id=<uuid>   list this vault's deliveries
 *        -> { ok: true, deliveries: [{ id, recipient_key_id, recipient_label,
 *                                       recipient_persona, status, delivered_at,
 *                                       created_at, updated_at }] }
 * POST /api/circle-phrase-deliveries                    record/refresh a delivery
 *        body: { vault_id, recipient_key_id, recipient_label, recipient_persona, status }
 *        Upserts on (vault_id, recipient_key_id) -- a resend after
 *        "Change phrase" just bumps delivered_at, it never errors on
 *        the unique constraint.
 *
 * Never carries the phrase text itself -- only bookkeeping (who, when,
 * delivered vs queued).
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
      .from("circle_phrase_deliveries")
      .select("id, recipient_key_id, recipient_label, recipient_persona, status, delivered_at, created_at, updated_at")
      .eq("vault_id", vaultId)
      .eq("user_id", u.userId)
      .order("delivered_at", { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, deliveries: data ?? [] });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const { vault_id, recipient_key_id, recipient_label, recipient_persona, status } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!recipient_key_id) return json(400, { error: "Missing: recipient_key_id" });
    if (!recipient_label) return json(400, { error: "Missing: recipient_label" });
    if (status !== "delivered" && status !== "queued") {
      return json(400, { error: "status must be 'delivered' or 'queued'" });
    }

    const { data, error } = await supabase
      .from("circle_phrase_deliveries")
      .upsert(
        {
          vault_id,
          user_id: u.userId,
          recipient_key_id,
          recipient_label,
          recipient_persona: recipient_persona ?? "",
          status,
          delivered_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "vault_id,recipient_key_id" },
      )
      .select("id, recipient_key_id, recipient_label, recipient_persona, status, delivered_at, created_at, updated_at")
      .single();
    if (error) return json(500, { error: error.message });
    return json(201, { ok: true, delivery: data });
  }

  return json(405, { error: "Method not allowed" });
}
