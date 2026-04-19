/**
 * GET /api/vault-activity-export?vault_id=<uuid>
 *
 * Returns a structured JSON file of every vault event, proposal,
 * request, signer session, comment, stipend, and distribution
 * wallet for a single vault. Intended for inspection, attorney
 * review, or long-term archival alongside the PDF audit.
 *
 * The client triggers a download by hitting this URL with a
 * ?token=<jwt> query param so <a href> works without custom
 * headers.
 */

import { requireUser, json } from "./_auth.js";
import { getSupabaseAdmin } from "./_supabase.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const id = event.queryStringParameters?.vault_id ?? event.queryStringParameters?.id;
  if (!id) return json(400, { error: "Missing: vault_id" });

  const supabase = getSupabaseAdmin();

  const { data: mem } = await supabase
    .from("vault_members")
    .select("id")
    .eq("vault_id", id)
    .eq("user_id", u.userId)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json(403, { error: "Not a member" });

  const [
    vaultRes, membersRes, invitesRes, proposalsRes,
    requestsRes, stipendsRes, walletsRes, eventsRes,
  ] = await Promise.all([
    supabase.from("vaults").select("*").eq("id", id).single(),
    supabase.from("vault_members").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("vault_invites").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("proposals").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("vault_requests").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("scheduled_stipends").select("*").eq("vault_id", id).order("next_due_at"),
    supabase.from("distribution_wallets").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("vault_events").select("*").eq("vault_id", id).order("created_at"),
  ]);

  if (vaultRes.error || !vaultRes.data) return json(404, { error: "Vault not found" });

  const proposalIds = (proposalsRes.data ?? []).map(p => p.id);
  const [signerSessionsRes, commentsRes] = await Promise.all([
    proposalIds.length > 0
      ? supabase.from("signer_sessions").select("*").in("proposal_id", proposalIds).order("signed_at")
      : Promise.resolve({ data: [] }),
    proposalIds.length > 0
      ? supabase.from("proposal_comments").select("*").in("proposal_id", proposalIds).order("created_at")
      : Promise.resolve({ data: [] }),
  ]);

  const payload = {
    export_version: 1,
    exported_at: new Date().toISOString(),
    exported_by_user_id: u.userId,
    vault: vaultRes.data,
    members: membersRes.data ?? [],
    invites: invitesRes.data ?? [],
    proposals: proposalsRes.data ?? [],
    signer_sessions: signerSessionsRes.data ?? [],
    proposal_comments: commentsRes.data ?? [],
    vault_requests: requestsRes.data ?? [],
    scheduled_stipends: stipendsRes.data ?? [],
    distribution_wallets: walletsRes.data ?? [],
    events: eventsRes.data ?? [],
  };

  const safeName = (vaultRes.data.name || "vault").replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="dynastytrust_${safeName}_activity_${ts}.json"`,
    },
    body: JSON.stringify(payload, null, 2),
  };
}
