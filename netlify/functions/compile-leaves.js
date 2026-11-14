/**
 * POST /api/compile-leaves
 * Body: { vault_id }
 *
 * Compiles a draft generic leaf-list vault (the "toggle-a-leaf" builder,
 * migration 042) into a live, spendable one. Mirrors vaults-compile-bloc.js's
 * role for the Bloc shape: single-owner-held, no vault_members-based key
 * provisioning -- every leaf's keys live in the caller's own local keystore,
 * already saved onto the draft row's `leaves` column (PATCH /api/vaults) by
 * the leaf-card builder before this is called.
 *
 * Preconditions (enforced):
 *   - caller is the vault owner
 *   - vault.status = 'draft'
 *   - vault.leaves already has every leaf's keys filled (the wizard is
 *     responsible for not calling this until every card is complete --
 *     the Rust compiler's own verify_leaf_policy is the final backstop)
 *
 * Flow:
 *   1. load vault, verify ownership + draft status + leaves present
 *   2. convert only AFTER leaves' relative timelock offsets to absolute
 *      CLTV heights (tip + offset) -- an OLDER leaf's block count is a
 *      DURATION, never an offset from a calendar point, so it is
 *      forwarded unchanged (see CLAUDE.md's timelock section)
 *   3. forward to the Fly.io compiler's /compile-leaves
 *   4. UPDATE vaults SET address, descriptor, miniscript_policy, leaves
 *      (now with absolute heights baked into its After entries),
 *      status='compiled'
 *   5. log 'draft_compiled' event
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { realBitcoinFinalizeProblem } from "./_finalize-guard.js";
import { recordEvent } from "./_ledger.js";
import { fetchVerifiedTipHeight } from "./_chain.js";
import { fetchCompiler, compilerFailureReason } from "./_compiler.js";
import { unconfirmedMemberKeys } from "./_invite-rules.js";
import {
  leavesKeyOrigins, leavesCheck, leavesNeedTip, leavesWire,
  leavesCompilePayload, leavesCompiledProblem, leavesCompiledRow,
} from "../../packages/vault-rules/src/leaves.js";

const COMPILER_URL = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

// The compile rules themselves -- each path's checks, the tip conversion,
// the compiler request, the must-sign backstop and the stored row -- are
// ONE copy in packages/vault-rules, shared with the downloaded app
// (scripts/test-vault-rules-leaves.mjs holds this handler to its recorded
// behaviour). What stays here is what only the website's server does:
// sign-in, the database, the finalize guard, invited people's keys.
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const vaultId = body.vault_id;
  if (!vaultId) return json(400, { error: "Missing: vault_id" });

  // BIP32 origins for hardware-wallet signing (2026-08-25 fix): without
  // them a hardware wallet cannot recognise its own key on a leaf.
  const keyOrigins = leavesKeyOrigins(body.key_origins);

  if (!COMPILER_URL) {
    return json(503, { error: "Compiler service not configured.", hint: "Set COMPILER_URL in Netlify env vars." });
  }

  const supabase = getSupabaseAdmin();

  const { data: vault, error: vaultErr } = await supabase
    .from("vaults")
    .select("id, user_id, name, network, address_type, status, leaves, consent_keys, consent_quorum")
    .eq("id", vaultId)
    .maybeSingle();
  if (vaultErr) return json(500, { error: vaultErr.message });
  if (!vault) return json(404, { error: "Vault not found" });
  if (vault.user_id !== u.userId) return json(403, { error: "Only the owner can compile" });
  if (vault.status !== "draft") return json(400, { error: "Vault is not in draft status" });
  // Threat model C: a password alone cannot finish a real-bitcoin vault.
  {
    const strong = await realBitcoinFinalizeProblem(supabase, u.claims, vault.network);
    if (strong) return json(403, { error: strong, needs_two_step: true });
  }

  const checked = leavesCheck(vault);
  if (!checked.ok) return json(checked.status, { error: checked.error });
  const { leaves } = checked;

  // A key that belongs to an invited person goes into the vault only
  // after the owner has confirmed it by its fingerprint (operator's
  // decision, 2026-11-11: always, test coins included).
  {
    const { data: members, error: mErr } = await supabase
      .from("vault_members")
      .select("user_id, label, pubkey, status, key_confirmed_at")
      .eq("vault_id", vaultId);
    if (mErr) return json(500, { error: mErr.message });
    const waiting = unconfirmedMemberKeys(leaves, members, vault.user_id);
    if (waiting.length > 0) {
      const w = waiting[0];
      return json(400, { error: `${w.member}'s key on "${w.path}" has not been confirmed. Check its fingerprint with them and confirm it before finalizing.` });
    }
  }

  let tipHeight = 0;
  if (leavesNeedTip(leaves)) {
    try {
      tipHeight = await fetchVerifiedTipHeight(vault.network);
    } catch (e) {
      return json(502, { error: `Could not fetch chain tip for ${vault.network}: ${e.message}` });
    }
  }

  const wireLeaves = leavesWire(leaves, tipHeight);

  let compiled;
  try {
    const res = await fetchCompiler(COMPILER_URL, "/compile-leaves", leavesCompilePayload(vault, wireLeaves), { compilerSecret: COMPILER_SECRET });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json(502, {
        error: `Compiler returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`,
        hint: "Check COMPILER_SECRET matches between Netlify and Fly.io.",
      });
    }
    if (!res.ok || !data.ok) {
      return json(400, { error: data.error || "Compiler returned an error" });
    }
    const problem = leavesCompiledProblem(wireLeaves, data);
    if (problem) return json(problem.status, { error: problem.error });
    compiled = data;
  } catch (err) {
    return json(502, { error: `Compiler unreachable: ${compilerFailureReason(err)}` });
  }

  const { data: saved, error: saveErr } = await supabase
    .from("vaults")
    .update(leavesCompiledRow(compiled, wireLeaves, keyOrigins))
    .eq("id", vaultId)
    .select("id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, status, leaves, leaf_scripts, consent_keys, consent_quorum, key_origins")
    .single();
  if (saveErr) return json(500, { error: saveErr.message });

  await recordEvent(supabase, {
    vault_id: vaultId,
    user_id: u.userId,
    event_type: "draft_compiled",
    metadata: { address_type: "tr_multileaf", network: vault.network, shape: "leaves" },
  });

  return json(200, { ok: true, vault: saved });
}
