/**
 * GET /api/vault-activity-export?vault_id=<uuid>             (active member)
 *
 * Every row of one vault -- the vault, members, invites, proposals, signer
 * sessions, comments, requests, stipends, distribution wallets, events and
 * attestations -- as JSON, redacted exactly as the regular endpoints redact.
 *
 * Zero-knowledge storage (Z1 slice 4): names, labels, notes and comments in
 * these rows are sealed with the vault key, so this is the ONE data source
 * the browser builds every report from (lib/reports/: the backup sheet, the
 * audit PDF, the tax summary and the readable activity JSON), opening the
 * sealed values on the device. The server renders nothing readable.
 */

import { requireUser, json } from "./_auth.js";
import { isVaultOwner, redactMember, redactInvite } from "./_authz.js";
import { getSupabaseAdmin } from "./_supabase.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // Fetched by the app with its normal Authorization header (zero-knowledge
  // storage: the browser opens the sealed names and builds the reports), so
  // the ?token= fallback for plain links is no longer needed here.
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
  // Exports redact exactly as the regular endpoints do: an invite token is
  // the credential to join the vault and never leaves; full xpubs go only
  // to the owner and to the member themselves.
  const callerIsOwner = await isVaultOwner(supabase, id, u.userId);

  const [
    vaultRes, membersRes, invitesRes, proposalsRes,
    requestsRes, stipendsRes, walletsRes, eventsRes,
    attestationsRes,
  ] = await Promise.all([
    supabase.from("vaults").select("*").eq("id", id).single(),
    supabase.from("vault_members").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("vault_invites").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("proposals").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("vault_requests").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("scheduled_stipends").select("*").eq("vault_id", id).order("next_due_at"),
    supabase.from("distribution_wallets").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("vault_events").select("*").eq("vault_id", id).order("created_at"),
    supabase.from("vault_attestations").select("*").eq("vault_id", id).order("signed_at"),
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
    members: (membersRes.data ?? []).map(m => redactMember(m, { callerIsOwner, callerUserId: u.userId })),
    invites: (invitesRes.data ?? []).map(i => redactInvite(i, { callerIsOwner })),
    proposals: proposalsRes.data ?? [],
    signer_sessions: signerSessionsRes.data ?? [],
    proposal_comments: commentsRes.data ?? [],
    vault_requests: requestsRes.data ?? [],
    scheduled_stipends: stipendsRes.data ?? [],
    distribution_wallets: walletsRes.data ?? [],
    events: eventsRes.data ?? [],
    attestations: attestationsRes.data ?? [],
  };

  // The vault's name is sealed, so the file name is chosen in the browser.
  return json(200, { ok: true, ...payload });
}
