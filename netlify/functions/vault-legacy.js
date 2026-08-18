/**
 * vault-legacy.js -- Legacy Recovery storage (long-horizon descriptor
 * recovery; see apps/web/src/lib/legacy-recovery.ts for the crypto core
 * and docs in that file's header for the full mechanism).
 *
 * GET   /api/vault-legacy?vault_id=<uuid>
 *   Any active vault member. Returns everything needed to attempt
 *   recovery for this vault: the sealed bundle, every keyholder's locked
 *   shares, and the on-chain share (already unlocked by design -- no key
 *   needed to read it, safe to return to anyone who can see the vault).
 *
 * POST  /api/vault-legacy
 *   Owner only. Seals/reseals the vault's legacy recovery data in one
 *   shot -- called after a successful compile, or after any change that
 *   invalidates a previously sealed bundle (key rotation, new leaf).
 *   body: {
 *     vault_id,
 *     sealed_bundle: { nonce_b64, ciphertext_b64 },
 *     onchain_share_b64,
 *     shares: [{ key_role, locked_fast_share_b64, locked_fallback_share_b64 }]
 *   }
 *   Replaces any prior sealed bundle/shares/on-chain share for this vault
 *   wholesale -- a partial reseal would leave stale shares next to a
 *   fresh bundle, silently breaking recovery.
 *
 * PATCH /api/vault-legacy?vault_id=<uuid>
 *   Owner only. Records on-chain publication of the (already-stored,
 *   already-unlocked) on-chain share -- txid only. Does not broadcast
 *   anything itself; that is a separate, deliberate, human-triggered step.
 *   body: { txid }
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

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
  const { data: owned } = await supabase
    .from("vaults")
    .select("id")
    .eq("id", vaultId)
    .eq("user_id", userId)
    .maybeSingle();
  if (owned) return true;
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

    const [bundleRes, sharesRes, onchainRes] = await Promise.all([
      supabase.from("vault_legacy_bundles").select("nonce_b64, ciphertext_b64, updated_at")
        .eq("vault_id", vaultId).maybeSingle(),
      supabase.from("vault_legacy_shares")
        .select("key_role, locked_fast_share_b64, locked_fallback_share_b64")
        .eq("vault_id", vaultId),
      supabase.from("vault_legacy_onchain_shares")
        .select("onchain_share_b64, txid, published_at")
        .eq("vault_id", vaultId).maybeSingle(),
    ]);
    if (bundleRes.error) return json(500, { error: bundleRes.error.message });
    if (sharesRes.error) return json(500, { error: sharesRes.error.message });
    if (onchainRes.error) return json(500, { error: onchainRes.error.message });

    return json(200, {
      ok: true,
      sealed: !!bundleRes.data,
      bundle: bundleRes.data || null,
      shares: sharesRes.data || [],
      onchain: onchainRes.data || null,
    });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { vault_id, sealed_bundle, onchain_share_b64, shares } = body;

    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!sealed_bundle?.nonce_b64 || !sealed_bundle?.ciphertext_b64) {
      return json(400, { error: "Missing: sealed_bundle.nonce_b64 / ciphertext_b64" });
    }
    if (!onchain_share_b64) return json(400, { error: "Missing: onchain_share_b64" });
    if (!Array.isArray(shares) || shares.length === 0) {
      return json(400, { error: "Missing: shares (non-empty array)" });
    }
    for (const s of shares) {
      if (!s.key_role || !s.locked_fast_share_b64 || !s.locked_fallback_share_b64) {
        return json(400, {
          error: "Every share needs key_role, locked_fast_share_b64, locked_fallback_share_b64",
        });
      }
    }

    if (!(await assertOwner(supabase, vault_id, u.userId))) {
      return json(403, { error: "Only the vault owner can seal legacy recovery data" });
    }

    // Replace wholesale: a stale share next to a freshly sealed bundle
    // would silently produce a bundle that reconstructs to the WRONG
    // secret for anyone still holding an old share, so reseal is
    // delete-then-insert, never a partial patch.
    const { error: bundleErr } = await supabase
      .from("vault_legacy_bundles")
      .upsert({ vault_id, nonce_b64: sealed_bundle.nonce_b64, ciphertext_b64: sealed_bundle.ciphertext_b64 });
    if (bundleErr) return json(500, { error: bundleErr.message });

    const { error: onchainErr } = await supabase
      .from("vault_legacy_onchain_shares")
      .upsert({ vault_id, onchain_share_b64 });
    if (onchainErr) return json(500, { error: onchainErr.message });

    const { error: deleteErr } = await supabase
      .from("vault_legacy_shares")
      .delete()
      .eq("vault_id", vault_id);
    if (deleteErr) return json(500, { error: deleteErr.message });

    const rows = shares.map(s => ({
      vault_id,
      key_role: s.key_role,
      locked_fast_share_b64: s.locked_fast_share_b64,
      locked_fallback_share_b64: s.locked_fallback_share_b64,
    }));
    const { error: insertErr } = await supabase.from("vault_legacy_shares").insert(rows);
    if (insertErr) return json(500, { error: insertErr.message });

    await supabase.from("vault_events").insert({
      vault_id,
      user_id: u.userId,
      event_type: "legacy_recovery_sealed",
      metadata: { share_count: shares.length },
    });

    return json(201, { ok: true });
  }

  if (event.httpMethod === "PATCH") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
    const { txid } = body;
    if (!txid) return json(400, { error: "Missing: txid" });

    if (!(await assertOwner(supabase, vaultId, u.userId))) {
      return json(403, { error: "Only the vault owner can record on-chain publication" });
    }

    const { data: existing } = await supabase
      .from("vault_legacy_onchain_shares")
      .select("vault_id")
      .eq("vault_id", vaultId)
      .maybeSingle();
    if (!existing) return json(404, { error: "No on-chain share sealed for this vault yet" });

    const { error } = await supabase
      .from("vault_legacy_onchain_shares")
      .update({ txid, published_at: new Date().toISOString() })
      .eq("vault_id", vaultId);
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id: vaultId,
      user_id: u.userId,
      event_type: "legacy_recovery_onchain_published",
      metadata: { txid },
    });

    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
