/**
 * proposals-mine.js
 *
 * GET /api/proposals-mine
 *
 * Cross-vault feed of non-terminal proposals on every vault where the
 * caller is an active member AND the caller has not yet added their own
 * signature. Powers the Dashboard "Waiting for your signature" section.
 *
 * 2026-08-25 fix -- operator: "The messages section gets stale. Even if
 * you've already signed a proposal it is annoying." This endpoint used to
 * return every non-terminal proposal on every vault the caller belongs
 * to, with no check at all for whether the CALLER specifically still
 * needed to act -- so a proposal the caller already signed kept sitting
 * under "Waiting for your signature" until every other co-signer caught
 * up, even though nothing was actually waiting on them anymore.
 * signer_sessions.member_id is always server-derived from (vault_id,
 * user_id) at signing time (signer-sessions.js), never client-supplied,
 * so it's a reliable way to ask "did I already sign this one."
 *
 * Response shape:
 *   { ok: true, proposals: [{ ...proposal, vault: { id, name, network, founder_quorum } }] }
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  // Vaults where the caller is an active member, plus the caller's own
  // member id in each one -- needed below to tell "still waiting on me"
  // apart from "waiting on someone else."
  const { data: memberships, error: mErr } = await supabase
    .from("vault_members")
    .select("id, vault_id")
    .eq("user_id", u.userId)
    .eq("status", "active");
  if (mErr) return json(500, { error: mErr.message });

  const vaultIds = (memberships ?? []).map(m => m.vault_id);
  if (vaultIds.length === 0) return json(200, { ok: true, proposals: [] });
  const myMemberIdByVault = new Map((memberships ?? []).map(m => [m.vault_id, m.id]));

  const { data, error } = await supabase
    .from("proposals")
    .select(`
      *,
      vault:vaults (id, name, network, founder_quorum, heir_quorum),
      signer_sessions (id, signer_index, signer_role, label, signed, signed_at, fingerprint, member_id)
    `)
    .in("vault_id", vaultIds)
    .not("status", "in", "(broadcast,cancelled)")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return json(500, { error: error.message });

  const stillWaitingOnMe = (data ?? []).filter(p => {
    const myMemberId = myMemberIdByVault.get(p.vault_id);
    if (!myMemberId) return true;
    const alreadySigned = (p.signer_sessions ?? []).some(s => s.member_id === myMemberId && s.signed);
    return !alreadySigned;
  });

  return json(200, { ok: true, proposals: stillWaitingOnMe });
}
