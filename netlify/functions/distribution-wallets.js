/**
 * distribution-wallets.js -- T-vesting distribution wallets.
 *
 * GET    /api/distribution-wallets?vault_id=<uuid>  list (member)
 * POST   /api/distribution-wallets                  create (owner)
 *          body: {
 *            vault_id, name, beneficiary_name?,
 *            beneficiary_xpub, beneficiary_pubkey,
 *            trustee_keys, trustee_quorum,
 *            network, tranches: [{
 *              index, unlock_block, amount_sats,
 *              address, descriptor
 *            }]
 *          }
 * PATCH  /api/distribution-wallets?id=<uuid>        update (owner or member)
 *          body: { tranches }   -- bump funded_txid / claimed_txid
 * DELETE /api/distribution-wallets?id=<uuid>        remove (owner only)
 *
 * The ceremony UI first calls /api/compile-tranche N times to build
 * the tranche addresses, then POSTs the whole plan here in one shot.
 * After funding and claiming, each tranche's `funded_txid` and
 * `claimed_txid` get patched in.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const FIELDS =
  "id, created_at, updated_at, vault_id, name, beneficiary_name, beneficiary_xpub, beneficiary_pubkey, trustee_keys, trustee_quorum, tranches, network";

async function assertOwner(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vaults")
    .select("id")
    .eq("id", vaultId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function assertMember(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vault_members")
    .select("id")
    .eq("vault_id", vaultId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return !!data;
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    if (!(await assertMember(supabase, vaultId, u.userId))) {
      return json(403, { error: "Not a member of this vault" });
    }
    const { data, error } = await supabase
      .from("distribution_wallets")
      .select(FIELDS)
      .eq("vault_id", vaultId)
      .order("created_at", { ascending: false });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, wallets: data });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const {
      vault_id, name,
      beneficiary_name = null, beneficiary_xpub, beneficiary_pubkey,
      trustee_keys, trustee_quorum,
      network, tranches,
    } = body;

    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!name) return json(400, { error: "Missing: name" });
    if (!beneficiary_xpub) return json(400, { error: "Missing: beneficiary_xpub" });
    if (!beneficiary_pubkey) return json(400, { error: "Missing: beneficiary_pubkey" });
    if (!Array.isArray(trustee_keys) || trustee_keys.length === 0) {
      return json(400, { error: "Missing: trustee_keys" });
    }
    if (!trustee_quorum) return json(400, { error: "Missing: trustee_quorum" });
    if (!["testnet", "bitcoin"].includes(network)) {
      return json(400, { error: "Invalid network" });
    }
    if (!Array.isArray(tranches) || tranches.length === 0) {
      return json(400, { error: "Tranches array is required" });
    }
    for (const t of tranches) {
      if (typeof t.unlock_block !== "number" || !t.address || !t.descriptor || !t.amount_sats) {
        return json(400, { error: "Every tranche needs unlock_block, amount_sats, address, descriptor" });
      }
    }
    if (!(await assertOwner(supabase, vault_id, u.userId))) {
      return json(403, { error: "Only the primary trustee can create distribution wallets" });
    }

    const row = {
      vault_id, name,
      beneficiary_name,
      beneficiary_xpub,
      beneficiary_pubkey,
      trustee_keys,
      trustee_quorum,
      tranches,
      network,
    };

    const { data, error } = await supabase
      .from("distribution_wallets")
      .insert(row)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id,
      user_id: u.userId,
      event_type: "distribution_wallet_created",
      metadata: {
        distribution_wallet_id: data.id,
        name,
        tranche_count: tranches.length,
      },
    });

    return json(201, { ok: true, wallet: data });
  }

  if (event.httpMethod === "PATCH") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing: id" });
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { data: existing } = await supabase
      .from("distribution_wallets")
      .select("vault_id")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return json(404, { error: "Distribution wallet not found" });
    if (!(await assertMember(supabase, existing.vault_id, u.userId))) {
      return json(403, { error: "Not a member of this vault" });
    }

    // Only tranches is patchable post-creation -- the rest is
    // baked into the compiled addresses and cannot change.
    const allowed = ["tranches", "name", "beneficiary_name"];
    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k)),
    );
    if (!Object.keys(updates).length) {
      return json(400, { error: `No editable fields. Allowed: ${allowed.join(", ")}` });
    }

    const { data, error } = await supabase
      .from("distribution_wallets")
      .update(updates)
      .eq("id", id)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, wallet: data });
  }

  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing: id" });
    const { data: existing } = await supabase
      .from("distribution_wallets")
      .select("vault_id")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return json(404, { error: "Distribution wallet not found" });
    if (!(await assertOwner(supabase, existing.vault_id, u.userId))) {
      return json(403, { error: "Only the primary trustee can delete distribution wallets" });
    }
    const { error } = await supabase.from("distribution_wallets").delete().eq("id", id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
