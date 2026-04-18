/**
 * vault-events.js
 *
 * GET /api/vault-events?vault_id=<uuid>&limit=50
 *
 * Timeline feed for a vault. Any active member can read.
 * Returns newest first; `limit` defaults to 50, max 200.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const vaultId = event.queryStringParameters?.vault_id;
  if (!vaultId) return json(400, { error: "Missing query param: vault_id" });

  const limit = Math.min(
    200,
    Math.max(1, parseInt(event.queryStringParameters?.limit ?? "50", 10) || 50),
  );

  const supabase = getSupabaseAdmin();

  const { data: membership } = await supabase
    .from("vault_members")
    .select("id")
    .eq("vault_id", vaultId)
    .eq("user_id", u.userId)
    .eq("status", "active")
    .maybeSingle();
  if (!membership) return json(403, { error: "Not a member of this vault" });

  const { data, error } = await supabase
    .from("vault_events")
    .select("id, created_at, vault_id, user_id, event_type, metadata")
    .eq("vault_id", vaultId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return json(500, { error: error.message });

  return json(200, { ok: true, events: data });
}
