/**
 * ledger-anchor.js -- the daily Bitcoin-anchoring job (scheduled; see
 * netlify.toml). Two things, both idempotent:
 *   1. collect Bitcoin proofs for anchors whose calendar commitment has
 *      since been mined (checked against the real block, two sources);
 *   2. anchor the ledger tip of every vault that has entries since its
 *      last anchor.
 * Milestone events are anchored immediately by recordEvent; this job is
 * what covers everything in between and what turns receipts into proofs.
 */
import { getSupabaseAdmin } from "./_supabase.js";
import { upgradePending, anchorAllUnanchored } from "./_anchor.js";

export async function handler() {
  const supabase = getSupabaseAdmin();
  const out = {};
  try { out.upgrade = await upgradePending(supabase); } catch (e) { out.upgradeError = String(e?.message || e); }
  try { out.anchor = await anchorAllUnanchored(supabase); } catch (e) { out.anchorError = String(e?.message || e); }
  console.log("[ledger-anchor]", JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
}
