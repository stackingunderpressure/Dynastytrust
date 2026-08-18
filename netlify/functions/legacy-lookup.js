/**
 * legacy-lookup.js -- the hardware-wallet-compatible half of Legacy
 * Recovery (see apps/web/src/lib/legacy-recovery.ts's header, and
 * vault-legacy.js's header for the vault-scoped setup flow this
 * complements). That flow requires knowing which vault you're a member
 * of and having the vault owner walk you through sealing. This endpoint
 * answers a different, deliberately more permissive question: "here is
 * an xpub -- is there a sealed share hidden for it, anywhere?" -- for
 * the case a person no longer remembers, or was never told, which vault
 * a key of theirs belongs to (the actual "20 years from now" scenario
 * this whole feature exists for).
 *
 * GET /api/legacy-lookup?identity_pubkey_hex=<66-hex-char compressed pubkey>
 *   Any authenticated user (not required to be a member of the found
 *   vault -- see below for why that's safe). identity_pubkey_hex is the
 *   PUBLIC, non-hardened /1/0 child of a role's account xpub (see
 *   legacy-recovery.ts's legacyIdentityPubkeyFromXpub) -- the caller
 *   computes it client-side from their own xpub before calling, so this
 *   endpoint never sees or needs the xpub itself.
 *
 *   Returns everything needed to attempt recovery once the caller
 *   produces a matching signature: the vault's name (for the "yes, this
 *   is the right one" confirmation), the signature-locked fast-path
 *   share, the on-chain share (already unlocked by design), and the
 *   sealed bundle. Same trust boundary vault-legacy.js's GET already
 *   documents -- a full breach of this response alone never exposes a
 *   descriptor, since the fast-path share is still locked to a
 *   signature only the matching private key can produce, and the bundle
 *   is still AES-256-GCM sealed. Deliberately NOT scoped to vault
 *   membership: that is the entire point of this endpoint, and it costs
 *   nothing extra since the response is safe to hand to anyone who
 *   merely knows the identity pubkey.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  const pubkeyHex = (event.queryStringParameters?.identity_pubkey_hex || "").toLowerCase().trim();
  if (!/^[0-9a-f]{66}$/.test(pubkeyHex)) {
    return json(400, { error: "identity_pubkey_hex must be a 33-byte compressed pubkey (66 hex characters)" });
  }

  const supabase = getSupabaseAdmin();

  const { data: share, error: shareErr } = await supabase
    .from("vault_legacy_shares")
    .select("vault_id, key_role, locked_fast_share_sig_b64")
    .eq("identity_pubkey_hex", pubkeyHex)
    .maybeSingle();
  if (shareErr) return json(500, { error: shareErr.message });
  if (!share || !share.locked_fast_share_sig_b64) {
    return json(404, { error: "No sealed Legacy Recovery share found for that key." });
  }

  const [vaultRes, onchainRes, bundleRes] = await Promise.all([
    supabase.from("vaults").select("name, network").eq("id", share.vault_id).maybeSingle(),
    supabase.from("vault_legacy_onchain_shares").select("onchain_share_b64").eq("vault_id", share.vault_id).maybeSingle(),
    supabase.from("vault_legacy_bundles").select("nonce_b64, ciphertext_b64").eq("vault_id", share.vault_id).maybeSingle(),
  ]);
  if (vaultRes.error) return json(500, { error: vaultRes.error.message });
  if (onchainRes.error) return json(500, { error: onchainRes.error.message });
  if (bundleRes.error) return json(500, { error: bundleRes.error.message });
  if (!bundleRes.data) return json(404, { error: "Share found, but this vault has no sealed bundle -- data inconsistency, contact the vault owner." });

  return json(200, {
    ok: true,
    vault_id: share.vault_id,
    vault_name: vaultRes.data?.name ?? null,
    key_role: share.key_role,
    locked_fast_share_sig_b64: share.locked_fast_share_sig_b64,
    onchain_share_b64: onchainRes.data?.onchain_share_b64 ?? null,
    sealed_bundle: bundleRes.data,
  });
}
