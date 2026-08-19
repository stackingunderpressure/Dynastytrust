/**
 * wallet-link.js -- bind a Tapit wallet key to the CURRENT logged-in account.
 *
 * POST /api/wallet-link   (JWT required). Body: { grant: SignInGrant }.
 * GET  /api/wallet-link   (JWT required). Returns the current binding, if any.
 * DELETE /api/wallet-link (JWT required). Removes the current binding.
 *
 * The "bind once while logged in" half of the link model: an already
 * authenticated user proves control of their wallet key (same sign-in proof),
 * and we store user_id -> pubkey in wallet_identities. Afterward they can log
 * in by key via wallet-signin-verify. One wallet per user (user_id is PK);
 * a pubkey already bound to a DIFFERENT user is refused.
 *
 * GET/DELETE added 2026-08-19 (operator, after linking a wallet via the
 * Nostr pubkey-paste flow: "not showing back up in dynasty and frankly no
 * where for it to be") -- POST always worked and wrote the row, but nothing
 * in the frontend ever read it back, so a successful link had no lasting
 * place to be seen. WalletLinkCard.tsx now calls GET on mount to show
 * "Linked: <pubkey>" instead of always showing the connect buttons.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { verifySignIn } from "tapit-attest";
import { extractSignInAttestation } from "./_wallet-signin.js";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const { data, error } = await supabase
      .from("wallet_identities")
      .select("pubkey, bound_at")
      .eq("user_id", u.userId)
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, pubkey: data?.pubkey ?? null, bound_at: data?.bound_at ?? null });
  }

  if (event.httpMethod === "DELETE") {
    const { error } = await supabase
      .from("wallet_identities")
      .delete()
      .eq("user_id", u.userId);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const extracted = extractSignInAttestation(body);
  if (extracted.error) return json(400, { error: extracted.error });
  const { attestation, nonce } = extracted;

  const { data: row, error: loadErr } = await supabase
    .from("wallet_signin_challenges")
    .select("nonce, challenge, consumed_at")
    .eq("nonce", nonce)
    .maybeSingle();
  if (loadErr) return json(500, { error: loadErr.message });
  if (!row) return json(401, { error: "Unknown or expired challenge" });
  if (row.consumed_at) return json(401, { error: "Challenge already used" });

  const result = verifySignIn({ attestation, expectedChallenge: row.challenge });
  if (!result.valid) {
    return json(401, { error: "Proof failed: " + result.errors.join("; ") });
  }
  const pubkey = result.signer;

  // Refuse a pubkey already bound to a different account.
  const { data: existing, error: exErr } = await supabase
    .from("wallet_identities")
    .select("user_id")
    .eq("pubkey", pubkey)
    .maybeSingle();
  if (exErr) return json(500, { error: exErr.message });
  if (existing && existing.user_id !== u.userId) {
    return json(409, { error: "This wallet is already linked to another account" });
  }

  // Single-use: consume the challenge.
  await supabase
    .from("wallet_signin_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", nonce)
    .is("consumed_at", null);

  // Upsert the binding (one wallet per user; preserves readiness on re-bind).
  const { error: upErr } = await supabase
    .from("wallet_identities")
    .upsert(
      { user_id: u.userId, pubkey, bound_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (upErr) return json(500, { error: upErr.message });

  return json(200, { ok: true, pubkey });
}
