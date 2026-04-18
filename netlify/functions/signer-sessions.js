/**
 * signer-sessions.js -- per-member partial signatures on a proposal
 *
 * GET  /api/signer-sessions?proposal_id=<uuid>
 *        List existing partial signatures (visible to any vault
 *        member).
 *
 * POST /api/signer-sessions
 *        Body: { proposal_id, psbt_partial_hex, fingerprint, label? }
 *        Record the caller's partial signature. Uses the member
 *        row implied by (vault_id, user_id). Idempotent: if the
 *        caller already has a session for this proposal, the new
 *        PSBT replaces the old one.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const FIELDS =
  "id, created_at, proposal_id, signer_index, signer_role, label, signed, signed_at, fingerprint, member_id, psbt_partial_hex";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const proposalId = event.queryStringParameters?.proposal_id;
    if (!proposalId) return json(400, { error: "Missing: proposal_id" });

    const { data: proposal, error: pErr } = await supabase
      .from("proposals")
      .select("vault_id")
      .eq("id", proposalId)
      .maybeSingle();
    if (pErr) return json(500, { error: pErr.message });
    if (!proposal) return json(404, { error: "Proposal not found" });

    const { data: membership } = await supabase
      .from("vault_members")
      .select("id")
      .eq("vault_id", proposal.vault_id)
      .eq("user_id", u.userId)
      .eq("status", "active")
      .maybeSingle();
    if (!membership) return json(403, { error: "Not a member of this vault" });

    const { data, error } = await supabase
      .from("signer_sessions")
      .select(FIELDS)
      .eq("proposal_id", proposalId)
      .order("created_at", { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, sessions: data });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { proposal_id, psbt_partial_hex, fingerprint, label } = body;
    if (!proposal_id) return json(400, { error: "Missing: proposal_id" });
    if (!psbt_partial_hex) return json(400, { error: "Missing: psbt_partial_hex" });

    const { data: proposal, error: pErr } = await supabase
      .from("proposals")
      .select("vault_id")
      .eq("id", proposal_id)
      .maybeSingle();
    if (pErr) return json(500, { error: pErr.message });
    if (!proposal) return json(404, { error: "Proposal not found" });

    const { data: member } = await supabase
      .from("vault_members")
      .select("id, fingerprint, label, role")
      .eq("vault_id", proposal.vault_id)
      .eq("user_id", u.userId)
      .eq("status", "active")
      .maybeSingle();
    if (!member) return json(403, { error: "Not a member of this vault" });

    // Upsert by (proposal_id, member_id). Existing row -> replace the
    // partial PSBT so re-signing after a fix replaces the stale one.
    const { data: existing } = await supabase
      .from("signer_sessions")
      .select("id, signer_index")
      .eq("proposal_id", proposal_id)
      .eq("member_id", member.id)
      .maybeSingle();

    const row = {
      proposal_id,
      member_id: member.id,
      signer_role: member.role === "heir" ? "heir" : "founder",
      label: label ?? member.label ?? null,
      fingerprint: fingerprint ?? member.fingerprint ?? null,
      psbt_partial_hex,
      signed: true,
      signed_at: new Date().toISOString(),
    };

    let data;
    if (existing) {
      const { data: updated, error } = await supabase
        .from("signer_sessions")
        .update(row)
        .eq("id", existing.id)
        .select(FIELDS)
        .single();
      if (error) return json(500, { error: error.message });
      data = updated;
    } else {
      // signer_index is not-null in the existing schema -- use the
      // current count as a stable per-proposal index.
      const { count } = await supabase
        .from("signer_sessions")
        .select("*", { count: "exact", head: true })
        .eq("proposal_id", proposal_id);
      const { data: inserted, error } = await supabase
        .from("signer_sessions")
        .insert({ ...row, signer_index: count ?? 0 })
        .select(FIELDS)
        .single();
      if (error) return json(500, { error: error.message });
      data = inserted;
    }

    await supabase.from("vault_events").insert({
      vault_id: proposal.vault_id,
      user_id: u.userId,
      event_type: "signed",
      metadata: { proposal_id, member_id: member.id, fingerprint: row.fingerprint },
    });

    return json(200, { ok: true, session: data });
  }

  return json(405, { error: "Method not allowed" });
}
