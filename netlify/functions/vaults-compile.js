/**
 * POST /api/vaults-compile
 * Body: { vault_id } -- invite-based (members bring their own xpub via a
 *   claim link), OR { vault_id, direct_keys: { founder_keys, heir_keys,
 *   consent_keys? } } -- single-owner direct mode, each
 *   entry { pubkey, xpub, fingerprint, derivation_path }, same shape the
 *   Bloc draft path (vaults-compile-bloc.js) already uses. This is for
 *   the common "I'm bringing every key myself, just not all in the same
 *   sitting as Configure" case -- the vault already exists as a real,
 *   revisitable draft row; direct_keys lets the SAME owner finish it
 *   later without needing to invite anyone.
 *
 * Compiles a draft vault into a live, spendable one.
 *
 * Preconditions (enforced):
 *   - caller is the vault owner
 *   - vault.status = 'draft'
 *   - invite-based: active member count with role='founder' and
 *     xpub/pubkey/fingerprint/derivation_path all set >= planned_founder_count
 *     (same for heirs, if planned_heir_count > 0)
 *   - direct_keys: founder_keys.length >= planned_founder_count (same for
 *     heirs, if planned_heir_count > 0) -- no vault_members lookup at all
 *
 * Flow:
 *   1. load vault (+ active members, unless direct_keys given)
 *   2. forward each key's pubkey hex + quorums + timelocks to the
 *      Fly.io compiler
 *   3. post-process the returned descriptor into Nunchuk key-origin
 *      form pk([fp/path]xpub/0/0) using the xpubs
 *   4. UPDATE vaults SET address, descriptor, miniscript_policy,
 *      founder_keys, heir_keys, status='compiled'
 *   5. log 'draft_compiled' event
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { realBitcoinFinalizeProblem } from "./_finalize-guard.js";
import { recordEvent } from "./_ledger.js";
import { pubkeyFromXpub } from "./_xpub.js";
import { fetchVerifiedTipHeight } from "./_chain.js";
import { standardKeys, standardCompilePayload, standardCompiledRow } from "../../packages/vault-rules/src/standard.js";
import { fetchCompiler, compilerFailureReason } from "./_compiler.js";

const COMPILER_URL = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

const VAULT_FIELDS =
  "id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, founder_quorum, heir_quorum, recovery_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, protector_keys, protector_quorum, protector_after, consent_keys, consent_quorum, archived, status, planned_founder_count, planned_heir_count, trust_doc, predecessor_id, leaf_scripts, backup_keys, backup_quorum, second_heir_keys, second_heir_quorum, second_inheritance_after, key_origins";

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

  if (!COMPILER_URL) {
    return json(503, {
      error: "Compiler service not configured.",
      hint: "Set COMPILER_URL in Netlify env vars.",
    });
  }

  const supabase = getSupabaseAdmin();

  // Load vault and verify ownership + draft status.
  const { data: vault, error: vaultErr } = await supabase
    .from("vaults")
    .select(VAULT_FIELDS)
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

  // The standard vault's rules -- which keys, exact counts, dedupe,
  // optional parts, timelock floor and ceiling, the compiler request and
  // the stored row -- are ONE copy in packages/vault-rules, shared with
  // the downloaded app (scripts/test-vault-rules-standard.mjs holds this
  // function to its recorded behaviour).
  let members;
  if (!(body.direct_keys && typeof body.direct_keys === "object")) {
    const { data, error: memErr } = await supabase
      .from("vault_members")
      .select("id, role, xpub, fingerprint, pubkey, derivation_path")
      .eq("vault_id", vaultId)
      .eq("status", "active");
    if (memErr) return json(500, { error: memErr.message });
    members = data;
  }
  const keys = standardKeys(vault, body.direct_keys, members);
  if (!keys.ok) return json(keys.status, { error: keys.error });

  let tipHeight = 0;
  if (keys.needsTip) {
    try {
      tipHeight = await fetchVerifiedTipHeight(vault.network);
    } catch (e) {
      return json(502, {
        error: `Could not fetch chain tip for ${vault.network}: ${e.message}`,
      });
    }
  }
  const compilePayload = standardCompilePayload(vault, keys, tipHeight, pubkeyFromXpub);

  let compiled;
  try {
    const res = await fetchCompiler(COMPILER_URL, "/compile", compilePayload, { compilerSecret: COMPILER_SECRET });
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
    compiled = data;
  } catch (err) {
    return json(502, { error: `Compiler unreachable: ${compilerFailureReason(err)}` });
  }

  // Update the vault row with compiled output.
  const { data: saved, error: saveErr } = await supabase
    .from("vaults")
    .update(standardCompiledRow(vault, keys, compiled, tipHeight))
    .eq("id", vaultId)
    .select(VAULT_FIELDS)
    .single();
  if (saveErr) return json(500, { error: saveErr.message });

  await recordEvent(supabase, {
    vault_id: vaultId,
    user_id: u.userId,
    event_type: "draft_compiled",
    metadata: {
      address_type: vault.address_type,
      network: vault.network,
      founder_count: keys.founders.length,
      heir_count: keys.heirs.length,
    },
  });

  return json(200, { ok: true, vault: saved });
}
