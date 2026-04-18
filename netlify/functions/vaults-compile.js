/**
 * POST /api/vaults-compile
 * Body: { vault_id }
 *
 * Compiles a draft vault into a live, spendable one.
 *
 * Preconditions (enforced):
 *   - caller is the vault owner
 *   - vault.status = 'draft'
 *   - active member count with role='founder' and xpub/pubkey/fingerprint
 *     /derivation_path all set >= vault.planned_founder_count
 *   - same for heirs (if planned_heir_count > 0)
 *
 * Flow:
 *   1. load vault + all active members
 *   2. forward each member's pubkey hex + quorums + timelocks to the
 *      Fly.io compiler
 *   3. post-process the returned descriptor into Nunchuk key-origin
 *      form pk([fp/path]xpub/0/*) using the members' xpubs
 *   4. UPDATE vaults SET address, descriptor, miniscript_policy,
 *      founder_keys, heir_keys, status='compiled'
 *   5. log 'draft_compiled' event
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const COMPILER_URL = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

const VAULT_FIELDS =
  "id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, founder_quorum, heir_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, archived, status, planned_founder_count, planned_heir_count";

// Replace every occurrence of a raw pubkey hex in the descriptor
// with its Nunchuk-format key origin expression. Pure string work,
// same algorithm as the browser's upgradeDescriptor.
function upgradeDescriptor(descriptor, origins) {
  let out = descriptor;
  for (const { pubkey, fingerprint, derivation_path, xpub } of origins) {
    if (!pubkey || !fingerprint || !derivation_path || !xpub) continue;
    const cleanPath = derivation_path.replace(/^m\//, "");
    const keyExpr = `[${fingerprint}/${cleanPath}]${xpub}/0/*`;
    out = out.split(pubkey).join(keyExpr);
  }
  return out;
}

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

  // Load members that have completed their key provisioning.
  const { data: members, error: memErr } = await supabase
    .from("vault_members")
    .select("id, role, xpub, fingerprint, pubkey, derivation_path")
    .eq("vault_id", vaultId)
    .eq("status", "active");
  if (memErr) return json(500, { error: memErr.message });

  const ready = (members ?? []).filter(
    m => m.xpub && m.fingerprint && m.pubkey && m.derivation_path,
  );
  const founders = ready.filter(m => m.role === "founder" || m.role === "owner");
  const heirs = ready.filter(m => m.role === "heir");

  const plannedF = vault.planned_founder_count ?? founders.length;
  const plannedH = vault.planned_heir_count ?? heirs.length;

  if (founders.length < plannedF) {
    return json(400, {
      error: `Need ${plannedF} provisioned founder(s); only ${founders.length} ready.`,
    });
  }
  if (plannedH > 0 && heirs.length < plannedH) {
    return json(400, {
      error: `Need ${plannedH} provisioned heir(s); only ${heirs.length} ready.`,
    });
  }

  // Forward to the Fly.io compiler.
  const compilePayload = {
    name: vault.name,
    network: vault.network,
    address_type: vault.address_type,
    founder_keys: founders.map(m => m.pubkey),
    founder_quorum: vault.founder_quorum,
    heir_keys: heirs.map(m => m.pubkey),
    heir_quorum: vault.heir_quorum,
    recovery_after: vault.recovery_after,
    inheritance_after: vault.inheritance_after,
  };

  let compiled;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${COMPILER_URL.replace(/\/$/, "")}/compile`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
      },
      body: JSON.stringify(compilePayload),
    });
    clearTimeout(timeout);
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
    const reason = err?.name === "AbortError" ? "Compiler timed out after 15s" : err?.message;
    return json(502, { error: `Compiler unreachable: ${reason}` });
  }

  const upgraded = upgradeDescriptor(compiled.descriptor, [...founders, ...heirs]);

  // Update the vault row with compiled output.
  const { data: saved, error: saveErr } = await supabase
    .from("vaults")
    .update({
      address: compiled.address,
      descriptor: upgraded,
      miniscript_policy: compiled.miniscript_policy,
      founder_keys: founders.map(m => m.xpub),
      heir_keys: heirs.map(m => m.xpub),
      status: "compiled",
    })
    .eq("id", vaultId)
    .select(VAULT_FIELDS)
    .single();
  if (saveErr) return json(500, { error: saveErr.message });

  await supabase.from("vault_events").insert({
    vault_id: vaultId,
    user_id: u.userId,
    event_type: "draft_compiled",
    metadata: {
      address_type: vault.address_type,
      network: vault.network,
      founder_count: founders.length,
      heir_count: heirs.length,
    },
  });

  return json(200, { ok: true, vault: saved });
}
