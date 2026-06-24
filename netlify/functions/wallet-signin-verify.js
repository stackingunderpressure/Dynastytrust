/**
 * wallet-signin-verify.js -- verify a Tapit sign-in proof and mint a session.
 *
 * POST /api/wallet-signin-verify   (no auth -- this COMPLETES a login).
 *   Body: { grant: SignInGrant }  (the wallet's redirect ?grant=<base64>).
 *
 * Flow: load the EXACT challenge we issued (by nonce), run verifySignIn
 * (echo + freshness + signature), resolve pubkey -> the bound account,
 * consume the challenge (single-use), append the "same wallet as last time"
 * trail, then mint a Supabase session for the linked user via an admin
 * magiclink token the client redeems with verifyOtp.
 *
 * GREEN/RED is GUIDANCE ONLY: if the wallet is red the login STILL succeeds;
 * we return a `red` flag so the UI can surface the sweep / readiness flow.
 * Never a block, and nothing here touches a member's base multisig spend.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { json } from "./_auth.js";
import { verifySignIn } from "tapit-attest";
import { extractSignInAttestation } from "./_wallet-signin.js";

export async function handler(event) {
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

  const supabase = getSupabaseAdmin();

  // Load the challenge WE issued. The echo check inside verifySignIn is only
  // meaningful against our own stored copy.
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
    return json(401, { error: "Sign-in proof failed: " + result.errors.join("; ") });
  }
  const pubkey = result.signer;

  // Resolve the bound account. Logging in by key requires a prior bind.
  const { data: identity, error: idErr } = await supabase
    .from("wallet_identities")
    .select("user_id, readiness, readiness_reason")
    .eq("pubkey", pubkey)
    .maybeSingle();
  if (idErr) return json(500, { error: idErr.message });
  if (!identity) {
    return json(403, {
      error:
        "This wallet is not linked to a DynastyTrust account. Sign in with email, then link your wallet.",
    });
  }

  // Single-use: consume before minting the session.
  await supabase
    .from("wallet_signin_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", nonce)
    .is("consumed_at", null);

  // Append the visible "same wallet as last time" trail.
  await supabase.from("wallet_signins").insert({
    user_id: identity.user_id,
    pubkey,
    audience: row.challenge.audience,
  });

  // Mint a session: admin magiclink -> hashed_token; the client redeems it
  // with supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }).
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(
    identity.user_id,
  );
  if (userErr || !userData?.user?.email) {
    return json(500, { error: "Could not resolve the linked account" });
  }
  const email = userData.user.email;

  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    return json(500, { error: "Could not establish a session" });
  }

  const red = identity.readiness === "red";

  return json(200, {
    ok: true,
    email,
    token_hash: linkData.properties.hashed_token,
    red,
    red_reason: red ? identity.readiness_reason || null : null,
  });
}
