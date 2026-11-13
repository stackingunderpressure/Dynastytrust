/**
 * wallet-signin-challenge.js -- mint a single-use TA-1 sign-in challenge.
 *
 * POST /api/wallet-signin-challenge   (no auth -- this STARTS a login or a
 *   bind). Returns { challenge }. The client packages the challenge into the
 *   Tapit wallet deeplink (/sign?req=<base64 with intent:'sign-in'>). We
 *   persist it by nonce so wallet-signin-verify / wallet-link can check the
 *   returned proof against the EXACT challenge we issued -- verifying against
 *   a signer-supplied challenge proves nothing (see tapit-attest sign-in.ts).
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { json } from "./_auth.js";
import { overLimit, TOO_MANY } from "./_rate-limit.js";
import { buildSignInChallenge } from "tapit-attest";

const AUDIENCE = "dynastytrust.family";
const TTL_SECONDS = 300;

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const challenge = buildSignInChallenge({ audience: AUDIENCE, ttlSeconds: TTL_SECONDS });

  const supabase = getSupabaseAdmin();
  // Threat model H: limit challenge minting per connection.
  if (await overLimit(supabase, { name: "challenge", event, max: 30, windowSeconds: 600 })) return json(429, { error: TOO_MANY });
  const { error } = await supabase.from("wallet_signin_challenges").insert({
    nonce: challenge.nonce,
    challenge,
    audience: challenge.audience,
    expires_at: challenge.expiresAt,
  });
  if (error) return json(500, { error: error.message });

  return json(200, { ok: true, challenge });
}
