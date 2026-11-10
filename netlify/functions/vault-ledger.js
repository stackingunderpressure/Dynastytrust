/**
 * vault-ledger.js -- read a vault's tamper-evident record.
 *
 * GET /api/vault-ledger?vault_id=<uuid>
 *   Any active member. Returns every sealed entry, oldest first, plus
 *   this server's own verification of the chain. The entries carry
 *   everything needed to re-check them independently (see _ledger.js
 *   verifyLedger), so a member does not have to take `verified` on
 *   trust.
 */
import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { activeMembership } from "./_authz.js";
import { verifyLedger } from "./_ledger.js";
import { verifyAnchors, merkleRootAt } from "./_anchor.js";

const FIELDS = "vault_id, seq, recorded_at, actor_user_id, event_type, payload, payload_canon, prev_hash, entry_hash";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  const vaultId = event.queryStringParameters?.vault_id;
  if (!vaultId) return json(400, { error: "Missing query param: vault_id" });

  const supabase = getSupabaseAdmin();
  if (!(await activeMembership(supabase, vaultId, u.userId))) {
    return json(403, { error: "Not a member of this vault" });
  }

  const entries = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("vault_ledger")
      .select(FIELDS)
      .eq("vault_id", vaultId)
      .order("seq", { ascending: true })
      .range(from, from + 999);
    if (error) return json(500, { error: error.message });
    entries.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const { data: anchors, error: aErr } = await supabase
    .from("vault_ledger_anchors")
    .select("seq, entry_hash, digest, calendar, kind, commitment, proof_b64, bitcoin_height, created_at, reason")
    .eq("vault_id", vaultId)
    .order("seq", { ascending: true })
    .limit(5000);
  if (aErr) return json(500, { error: aErr.message });

  // Look the claimed Bitcoin blocks up (two independent sources each)
  // so "confirmed" means "is really in that block", not "a row says so".
  // If the chain cannot be reached, the answer says the blocks were not
  // checked instead of pretending.
  let merkleRoots = {};
  try {
    const heights = [...new Set((anchors ?? []).filter((a) => a.kind === "bitcoin").map((a) => a.bitcoin_height))].slice(-12);
    for (const h of heights) merkleRoots[h] = await merkleRootAt("bitcoin", h);
  } catch (e) {
    console.error(`[vault-ledger] block lookup failed: ${e?.message || e}`);
    merkleRoots = null;
  }

  return json(200, {
    ok: true,
    entries,
    anchors: anchors ?? [],
    verification: verifyLedger(entries),
    // Every anchor must still point at an entry that is in the ledger,
    // at that position, with that hash -- this is what catches a ledger
    // whose recent entries were cut off or replaced.
    anchoring: verifyAnchors(entries, anchors ?? [], merkleRoots),
  });
}
