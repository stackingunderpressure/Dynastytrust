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
import { fetchTipHeight, relativeToAbsolute, checkTimelockFloor } from "./_chain.js";
import { checkNumberBounds } from "./_numeric.js";
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

  const leaves = Array.isArray(vault.leaves) ? vault.leaves : [];
  if (!leaves.length) return json(400, { error: "Draft has no leaves configured" });

  for (const leaf of leaves) {
    if (!leaf || typeof leaf.id !== "string" || !leaf.id) {
      return json(400, { error: "Every leaf needs a non-empty id" });
    }
    if (!Array.isArray(leaf.keys) || !leaf.keys.length) {
      return json(400, { error: `Leaf '${leaf.id}' has no keys` });
    }
    // leaf.quorum was forwarded to the Rust compiler with zero
    // validation of any kind -- Rust's own verify_leaf_policy DOES
    // bound it (quorum == 0 || quorum > keys.len()), so this was
    // defense-in-depth-only, not an active bypass, but it means this
    // endpoint added none of its own protection: a future refactor of
    // that one Rust check would leave this path unguarded with nothing
    // else to catch it (Kimi K3 scan Family D).
    const quorumErr = checkNumberBounds(leaf.quorum, { field: `Leaf '${leaf.id}' quorum`, min: 1, max: leaf.keys.length, integer: true });
    if (quorumErr) return json(400, { error: quorumErr });
    for (const k of leaf.keys) {
      try {
        assertNotPrivateExtendedKey(k);
      } catch (e) {
        return json(400, { error: e.message });
      }
    }
    // Floor-check an After leaf's raw relative offset BEFORE tip+offset
    // conversion below -- Rust's own verify_leaf_policy check only ever
    // sees the already-absolute value by the time it runs and is a
    // structural no-op on any live network (same reason compile.js
    // checks recovery_after/inheritance_after here; this generic
    // leaf-list path never got the equivalent check at all -- Kimi K3
    // scan Family D). OlderThan leaves are a duration forwarded
    // unchanged, not converted, so Rust's own MAX_RELATIVE_BLOCKS check
    // against the raw value is already effective there -- no gap.
    if (leaf.unlock?.type === "after") {
      const err = checkTimelockFloor(leaf.unlock.blocks, `Leaf '${leaf.id}' unlock.blocks`);
      if (err) return json(400, { error: err });
    }
  }
  for (const k of vault.consent_keys ?? []) {
    try {
      assertNotPrivateExtendedKey(k);
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  // Only AFTER leaves carry a relative-offset-that-needs-a-tip; OLDER
  // leaves' block count is already the exact BIP68 duration the caller
  // wants and must be forwarded unchanged (see compiler/src/main.rs's
  // /compile-leaves doc comment for the same rule stated on the Rust
  // side). Fetch the tip only if at least one AFTER leaf needs it.
  const needsTip = leaves.some((l) => l.unlock?.type === "after");
  let tipHeight = 0;
  if (needsTip) {
    try {
      tipHeight = await fetchTipHeight(vault.network);
    } catch (e) {
      return json(502, { error: `Could not fetch chain tip for ${vault.network}: ${e.message}` });
    }
  }

  const wireLeaves = leaves.map((leaf) => {
    const unlock = leaf.unlock?.type === "after"
      ? { type: "after", blocks: relativeToAbsolute(leaf.unlock.blocks, tipHeight) }
      : leaf.unlock;
    return {
      id: leaf.id,
      label: leaf.label || leaf.id,
      keys: leaf.keys,
      quorum: leaf.quorum,
      unlock,
      decay: leaf.decay ?? null,
    };
  });

  let compiled;
  try {
    const res = await fetchCompiler(COMPILER_URL, "/compile-leaves", {
      name: vault.name,
      network: vault.network,
      leaves: wireLeaves,
      consent_keys: vault.consent_keys ?? [],
      consent_quorum: vault.consent_quorum,
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

  const { data: saved, error: saveErr } = await supabase
    .from("vaults")
    .update({
      address: compiled.address,
      descriptor: compiled.descriptor,
      miniscript_policy: compiled.miniscript_policy,
      // Store the leaf list with the AFTER entries' absolute heights now
      // baked in -- same reason vaults-compile.js overwrites
      // recovery_after/inheritance_after with absolute values post-compile:
      // this must match what the compiled tree actually bakes in, not the
      // relative offsets the draft started with.
      leaves: wireLeaves,
      address_type: "tr_multileaf",
      status: "compiled",
      // Per-leaf tapscript bytes, keyed by leaf id (compiler/src/main.rs's
      // compile_leaves handler). Was never persisted here -- the column
      // (026_leaf_scripts.sql) has existed since the named-field path
      // started writing it, but this handler never read compiled.leaf_scripts
      // off the compiler response at all, so every leaf-list vault compiled
      // to date has `leaf_scripts: null`, which is what silently breaks
      // Tapit circle-membership invites for this vault shape (see
      // circle-membership-delivery.ts / VaultMembershipSetup.tsx).
      leaf_scripts: compiled.leaf_scripts ?? null,
    })
    .eq("id", vaultId)
    .select("id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, status, leaves, leaf_scripts, consent_keys, consent_quorum")
    .single();
  if (saveErr) return json(500, { error: saveErr.message });

  await supabase.from("vault_events").insert({
    vault_id: vaultId,
    user_id: u.userId,
    event_type: "draft_compiled",
    metadata: { address_type: "tr_multileaf", network: vault.network, shape: "leaves" },
  });

  return json(200, { ok: true, vault: saved });
}
