/**
 * POST /api/vaults-compile-bloc
 * Body: { vault_id, parent_keys, kid_keys, parent_xpubs, kid_xpubs, key_origins }
 *
 * Compiles a draft Dynasty Bloc vault into a live, spendable one.
 * Mirrors vaults-compile.js's role for the standard shape, but Bloc
 * vaults are single-owner-held with no vault_members-based key
 * provisioning -- every parent/kid key lives in the SAME user's local
 * keystore, so the caller (the wizard, once every slot is filled from
 * its own key list) sends the finished pubkey/xpub/key_origins arrays
 * directly rather than the server reading them off member rows.
 *
 * Preconditions (enforced):
 *   - caller is the vault owner
 *   - vault.status = 'draft'
 *   - vault.bloc_policy already has the quorums + RELATIVE timelock
 *     offsets set at draft-creation time (the wizard's Configure step)
 *
 * Flow:
 *   1. load vault, verify ownership + draft status + bloc_policy present
 *   2. convert the draft's relative timelock offsets to absolute CLTV
 *      heights (tip + offset) -- same reason compile-bloc.js does this
 *   3. forward to the Fly.io compiler's /compile-bloc
 *   4. UPDATE vaults SET address, descriptor, miniscript_policy,
 *      bloc_policy (now with pubkeys/xpubs/key_origins + absolute
 *      timelocks), status='compiled'
 *   5. log 'draft_compiled' event
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { fetchTipHeight, relativeToAbsolute, checkTimelockFloor } from "./_chain.js";
import { fetchCompiler, compilerFailureReason } from "./_compiler.js";
import { assertNotPrivateExtendedKey } from "./_xpub.js";

const COMPILER_URL = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

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

  const {
    parent_keys = [], kid_keys = [],
    parent_xpubs = [], kid_xpubs = [],
    key_origins = [],
  } = body;
  if (!parent_keys.length) return json(400, { error: "Missing: parent_keys" });
  if (!kid_keys.length)    return json(400, { error: "Missing: kid_keys" });

  // 2026-08-15 security audit: see compile.js's identical comment.
  for (const k of [...parent_keys, ...kid_keys, ...parent_xpubs, ...kid_xpubs]) {
    try {
      assertNotPrivateExtendedKey(k);
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  if (!COMPILER_URL) {
    return json(503, { error: "Compiler service not configured.", hint: "Set COMPILER_URL in Netlify env vars." });
  }

  const supabase = getSupabaseAdmin();

  const { data: vault, error: vaultErr } = await supabase
    .from("vaults")
    .select("id, user_id, name, network, address_type, status, bloc_policy")
    .eq("id", vaultId)
    .maybeSingle();
  if (vaultErr) return json(500, { error: vaultErr.message });
  if (!vault) return json(404, { error: "Vault not found" });
  if (vault.user_id !== u.userId) return json(403, { error: "Only the owner can compile" });
  if (vault.status !== "draft") return json(400, { error: "Vault is not in draft status" });

  const bp = vault.bloc_policy || {};
  const required = [
    "parents_together_quorum", "coparent_quorum", "kids_with_parent_quorum",
    "parent_solo_quorum", "kids_decay_start_quorum", "kids_decay_floor_quorum",
    "parent_solo_after", "kids_decay_start_after", "kids_decay_step_blocks",
  ];
  const missing = required.filter(k => bp[k] === undefined || bp[k] === null);
  if (missing.length) {
    return json(400, { error: `Draft is missing quorum/timelock config: ${missing.join(", ")}` });
  }

  // Floor-check the stored relative offsets BEFORE tip+offset conversion
  // below -- same reason compile-bloc.js checks them, and the identical
  // gap this file had until now (Kimi K3 scan Family D).
  for (const [value, field] of [
    [bp.parent_solo_after, "parent_solo_after"],
    [bp.kids_decay_start_after, "kids_decay_start_after"],
  ]) {
    const err = checkTimelockFloor(value, field);
    if (err) return json(400, { error: err });
  }

  // The draft stored RELATIVE offsets (set at Configure time, before any
  // address existed) -- convert to absolute CLTV heights now, same as
  // compile-bloc.js does for a same-session compile.
  let tipHeight;
  try {
    tipHeight = await fetchTipHeight(vault.network);
  } catch (e) {
    return json(502, { error: `Could not fetch chain tip for ${vault.network}: ${e.message}` });
  }
  const absParentSoloAfter = relativeToAbsolute(bp.parent_solo_after, tipHeight);
  const absKidsDecayStart  = relativeToAbsolute(bp.kids_decay_start_after, tipHeight);

  let compiled;
  try {
    const res = await fetchCompiler(COMPILER_URL, "/compile-bloc", {
      name: vault.name,
      network: vault.network,
      parent_keys, kid_keys,
      parents_together_quorum: bp.parents_together_quorum,
      coparent_quorum: bp.coparent_quorum,
      kids_with_parent_quorum: bp.kids_with_parent_quorum,
      parent_solo_quorum: bp.parent_solo_quorum,
      parent_solo_after: absParentSoloAfter,
      kids_decay_start_after: absKidsDecayStart,
      kids_decay_step_blocks: bp.kids_decay_step_blocks,
      kids_decay_start_quorum: bp.kids_decay_start_quorum,
      kids_decay_floor_quorum: bp.kids_decay_floor_quorum,
    }, { compilerSecret: COMPILER_SECRET });
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

  const finalBlocPolicy = {
    ...bp,
    parent_pubkeys: parent_keys,
    kid_pubkeys: kid_keys,
    parent_xpubs,
    kid_xpubs,
    parent_solo_after: absParentSoloAfter,
    kids_decay_start_after: absKidsDecayStart,
    key_origins,
  };

  const { data: saved, error: saveErr } = await supabase
    .from("vaults")
    .update({
      // The compiler's response is flat ({ ok, address, descriptor,
      // miniscript_policy, ... }), same shape compile.js reads via
      // `compiled.address` -- there is no nested `compiled.compiled`
      // key. This mismatch made every Bloc vault finalize throw
      // (saved.address always undefined, breaking the address_type
      // check downstream) until fixed.
      address: compiled.address,
      descriptor: compiled.descriptor,
      miniscript_policy: compiled.miniscript_policy,
      bloc_policy: finalBlocPolicy,
      status: "compiled",
    })
    .eq("id", vaultId)
    .select("id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, status, bloc_policy")
    .single();
  if (saveErr) return json(500, { error: saveErr.message });

  await supabase.from("vault_events").insert({
    vault_id: vaultId,
    user_id: u.userId,
    event_type: "draft_compiled",
    metadata: { address_type: vault.address_type, network: vault.network, shape: "bloc" },
  });

  return json(200, { ok: true, vault: saved });
}
