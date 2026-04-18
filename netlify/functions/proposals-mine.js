/**
 * proposals-mine.js
 *
 * GET /api/proposals-mine
 *
 * Cross-vault feed of non-terminal proposals on every vault where
 * the caller is an active member. Powers the Dashboard "Waiting
 * for your signature" section.
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

  // Vaults where the caller is an active member.
  const { data: memberships, error: mErr } = await supabase
    .from("vault_members")
    .select("vault_id")
    .eq("user_id", u.userId)
    .eq("status", "active");
  if (mErr) return json(500, { error: mErr.message });

  const vaultIds = (memberships ?? []).map(m => m.vault_id);
  if (vaultIds.length === 0) return json(200, { ok: true, proposals: [] });

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

  return json(200, { ok: true, proposals: data });
}
