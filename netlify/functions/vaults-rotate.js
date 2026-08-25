/**
 * POST /api/vaults-rotate
 * Body: {
 *   vault_id,
 *   overrides?: {
 *     name?: string,
 *     recovery_after?: number,
 *     inheritance_after?: number,
 *     founder_quorum?: number,
 *     heir_quorum?: number,
 *     recovery_quorum?: number | null,
 *   }
 * }
 *
 * Creates a successor DRAFT vault that inherits the predecessor's
 * members, trust document, address type, network, and shape.
 * Timelock offsets in `overrides` are stored as RELATIVE (the
 * draft's recovery_after etc). They get converted to absolute
 * CLTV heights at compile time, same as any other draft.
 *
 * Owner only. Response: { vault } - the new draft row.
 *
 * Use case: rotate keys, add a trustee, extend a timelock, or
 * otherwise evolve the trust without losing the trust doc / audit
 * history. The old vault keeps its address (funds stay spendable
 * by whoever held its keys) until swept into the new vault.
 */

import { requireUser, json } from "./_auth.js";
import { getSupabaseAdmin } from "./_supabase.js";

const VAULT_FIELDS =
  "id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, founder_quorum, heir_quorum, recovery_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, protector_keys, protector_quorum, protector_after, consent_keys, consent_quorum, archived, status, planned_founder_count, planned_heir_count, trust_doc, predecessor_id, leaves, bloc_policy";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const { vault_id, overrides = {} } = body;
  if (!vault_id) return json(400, { error: "Missing: vault_id" });

  const supabase = getSupabaseAdmin();

  const { data: src, error: srcErr } = await supabase
    .from("vaults")
    .select(VAULT_FIELDS)
    .eq("id", vault_id)
    .maybeSingle();
  if (srcErr) return json(500, { error: srcErr.message });
  if (!src) return json(404, { error: "Vault not found" });
  if (src.user_id !== u.userId) {
    return json(403, { error: "Only the primary trustee can rotate a vault" });
  }
  if (src.status !== "compiled") {
    return json(400, { error: "Only compiled vaults can be rotated" });
  }
  // 2026-08-25 fix: this endpoint always built the successor draft in
  // the named-field shape (founder_quorum/founder_keys/etc.), never
  // carrying forward vault.leaves or vault.bloc_policy -- rotating a
  // leaf-list or Bloc vault silently produced a broken standard-shape
  // draft (founder_quorum at its bare default, 0 keys, no leaves/policy
  // at all) with no way to recover the original structure. Refuse
  // outright rather than silently corrupting the vault's shape; a real
  // "carry this shape's own structure forward" rotation is a larger,
  // separate feature not built here.
  const srcIsLeafList = Array.isArray(src.leaves) && src.leaves.length > 0;
  if (srcIsLeafList || src.bloc_policy != null) {
    return json(400, {
      error: srcIsLeafList
        ? "Rotating a custom leaf-list vault isn't supported yet -- its spending paths can't be safely carried forward automatically. Build a fresh vault with the same leaves instead."
        : "Rotating a Dynasty Bloc vault isn't supported yet -- its policy can't be safely carried forward automatically. Build a fresh Bloc vault instead.",
    });
  }

  const { data: existingMembers, error: memErr } = await supabase
    .from("vault_members")
    .select("role, label, key_label, xpub, fingerprint, pubkey, derivation_path, user_id, status")
    .eq("vault_id", vault_id)
    .eq("status", "active");
  if (memErr) return json(500, { error: memErr.message });

  // Shape params: default to source values, allow explicit override.
  // Timelock overrides are RELATIVE offsets (blocks from compile
  // time) because the draft hasn't been compiled yet. The existing
  // compile pipeline converts relative -> absolute.
  const recoveryAfter    = overrides.recovery_after    ?? 0;
  const inheritanceAfter = overrides.inheritance_after ?? 0;

  const newRow = {
    user_id: u.userId,
    name: overrides.name || `${src.name} v2`,
    network: src.network,
    address_type: src.address_type,
    address: null,
    descriptor: null,
    miniscript_policy: null,
    // Shape params carry forward unless explicitly overridden.
    founder_quorum: overrides.founder_quorum ?? src.founder_quorum,
    heir_quorum: overrides.heir_quorum ?? src.heir_quorum,
    recovery_quorum: overrides.recovery_quorum !== undefined ? overrides.recovery_quorum : src.recovery_quorum,
    // Relative offsets for a fresh draft. Compile converts to
    // absolute at the caller's current tip.
    recovery_after: recoveryAfter,
    inheritance_after: inheritanceAfter,
    consent_keys: [],
    consent_quorum: src.consent_quorum,
    founder_keys: [],
    heir_keys: [],
    status: "draft",
    planned_founder_count: src.planned_founder_count ?? src.founder_keys.length,
    planned_heir_count: src.planned_heir_count ?? src.heir_keys.length,
    trust_doc: src.trust_doc ?? {},
    predecessor_id: src.id,
  };

  const { data: created, error: createErr } = await supabase
    .from("vaults")
    .insert(newRow)
    .select(VAULT_FIELDS)
    .single();
  if (createErr) return json(500, { error: createErr.message });

  // Copy members over. Owner role gets re-seeded by any owner
  // trigger; dedupe by user_id just in case.
  if (existingMembers && existingMembers.length > 0) {
    const seen = new Set();
    const rowsToInsert = [];
    for (const m of existingMembers) {
      const key = m.user_id || `stub-${Math.random()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rowsToInsert.push({
        vault_id: created.id,
        user_id: m.user_id,
        role: m.role,
        label: m.label,
        key_label: m.key_label,
        xpub: m.xpub,
        fingerprint: m.fingerprint,
        pubkey: m.pubkey,
        derivation_path: m.derivation_path,
        status: "active",
      });
    }
    if (rowsToInsert.length > 0) {
      // Members with an owner trigger will conflict; use upsert to
      // tolerate the auto-seeded owner row.
      const { error: insErr } = await supabase
        .from("vault_members")
        .upsert(rowsToInsert, { onConflict: "vault_id,user_id" });
      if (insErr) {
        /* Non-fatal: the vault exists, the owner can fill slots
           manually from the Members tab. */
      }
    }
  }

  await supabase.from("vault_events").insert({
    vault_id: created.id,
    user_id: u.userId,
    event_type: "rotated_from_predecessor",
    metadata: { predecessor_id: vault_id, predecessor_name: src.name },
  });
  await supabase.from("vault_events").insert({
    vault_id,
    user_id: u.userId,
    event_type: "rotated_to_successor",
    metadata: { successor_id: created.id, successor_name: created.name },
  });

  return json(201, { ok: true, vault: created });
}
