/**
 * circle-phrase-deliveries.js -- persisted send-status for the circle
 * safety phrase pair (034_circle_phrase_deliveries.sql, operator: "these
 * phrases should show they've been sent and not do it again and again"),
 * plus real receipt confirmation (035_circle_phrase_delivery_confirm.sql,
 * operator: "message couldn't drop in that situation").
 *
 * GET   /api/circle-phrase-deliveries?vault_id=<uuid>   list this vault's deliveries
 *         -> { ok: true, deliveries: [{ id, recipient_key_id, recipient_label,
 *                                        recipient_persona, status, delivered_at,
 *                                        reply_pubkey, reply_privkey, confirmed_at,
 *                                        created_at, updated_at }] }
 * POST  /api/circle-phrase-deliveries                    record/refresh a delivery
 *         body: { vault_id, recipient_key_id, recipient_label, recipient_persona,
 *                  status, reply_pubkey?, reply_privkey? }
 *         Upserts on (vault_id, recipient_key_id) -- a resend after
 *         "Change phrase" just bumps delivered_at (and clears any prior
 *         confirmed_at -- a new send needs its own fresh confirmation),
 *         it never errors on the unique constraint.
 * PATCH /api/circle-phrase-deliveries                    record a receipt ack
 *         body: { reply_pubkey }
 *         Looked up by reply_pubkey (the ack channel only knows that,
 *         not the row id) rather than a query-string id, scoped to the
 *         caller's own rows.
 *
 * Never carries the phrase text itself -- only bookkeeping (who, when,
 * delivered vs queued, and whether the recipient's wallet actually
 * confirmed receipt).
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const SELECT_COLS =
  "id, recipient_key_id, recipient_label, recipient_persona, status, delivered_at, reply_pubkey, reply_privkey, confirmed_at, created_at, updated_at";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });

    const { data, error } = await supabase
      .from("circle_phrase_deliveries")
      .select(SELECT_COLS)
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

    const { vault_id, recipient_key_id, recipient_label, recipient_persona, status, reply_pubkey, reply_privkey } = body;
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
          // Despite the column name, this is stamped on EVERY write,
          // not only when status === 'delivered' -- it's really "last
          // send attempt" (delivered or queued-for-retry alike). Safe
          // because every reader gates on `status` first before
          // trusting this as a delivery time (CirclePhraseSetup.tsx:
          // "Sent..." only for status==='delivered', "Queued --
          // retrying..." otherwise) -- don't "fix" this into only
          // setting it on delivered without also auditing every
          // caller's display text.
          delivered_at: new Date().toISOString(),
          // A fresh send supersedes any prior confirmation -- the
          // recipient hasn't acked THIS phrase yet, even if they acked
          // an earlier one for the same slot.
          reply_pubkey: reply_pubkey ?? null,
          reply_privkey: reply_privkey ?? null,
          confirmed_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "vault_id,recipient_key_id" },
      )
      .select(SELECT_COLS)
      .single();
    if (error) return json(500, { error: error.message });
    return json(201, { ok: true, delivery: data });
  }

  if (event.httpMethod === "PATCH") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    if (!body.reply_pubkey) return json(400, { error: "Missing: reply_pubkey" });

    const { data, error } = await supabase
      .from("circle_phrase_deliveries")
      .update({ confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("reply_pubkey", body.reply_pubkey)
      .eq("user_id", u.userId)
      .select(SELECT_COLS)
      .single();
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, delivery: data });
  }

  return json(405, { error: "Method not allowed" });
}
