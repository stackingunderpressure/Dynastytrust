/**
 * key-signup.js -- make an account from a key alone, no email.
 *
 * POST /api/key-signup   (no auth -- this CREATES an account)
 *   Body: { grant: { attestation }, display_name? }
 *   The attestation answers a challenge from /api/wallet-signin-challenge,
 *   signed by the person's Tapit wallet (lib/wallet-signin.ts, mode
 *   'signup'). Body may carry kind: 'tapit' (default) | 'device'.
 *
 * Proves the key, refuses a key that already has an account, consumes the
 * challenge, creates a confirmed Supabase account at a never-mailed
 * placeholder address (_key-account.js), binds the key to it as this
 * phone's sign-in key, and returns the same one-time login token
 * wallet-signin-verify.js returns. If binding the key fails, the account
 * just made is deleted again, so no orphan account is left behind.
 */
import { getSupabaseAdmin } from "./_supabase.js";
import { json } from "./_auth.js";
import { overLimit, TOO_MANY } from "./_rate-limit.js";
import { proveKeyControl, consumeChallenge, mintSession, placeholderEmail, cleanDisplayName, issueKeySessionClaim } from "./_key-account.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON body" }); }
  const supabase = getSupabaseAdmin();
  // Threat model H: account creation is limited per connection.
  if (await overLimit(supabase, { name: "key-signup", event, max: 5, windowSeconds: 3600 })) return json(429, { error: TOO_MANY });

  const proof = await proveKeyControl(supabase, body);
  if (proof.error) return json(proof.status, { error: proof.error });

  const { data: existing, error: exErr } = await supabase
    .from("wallet_identities").select("user_id").eq("pubkey", proof.pubkey).maybeSingle();
  if (exErr) return json(500, { error: exErr.message });
  if (existing) return json(409, { error: "This key already has an account. Use Sign in instead." });

  const consumed = await consumeChallenge(supabase, proof.nonce);
  if (consumed.error) return json(consumed.status, { error: consumed.error });

  const displayName = cleanDisplayName(body.display_name);
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: placeholderEmail(),
    email_confirm: true,
    user_metadata: { display_name: displayName, signin: "key" },
  });
  const userId = created?.user?.id;
  if (createErr || !userId) return json(500, { error: "Could not create the account" });

  // Since 2026-11-13 the sign-in page makes accounts only through a Tapit
  // wallet (operator: "run your own Tapit wallet, sign in through it");
  // "device" stays accepted for a key held in this app.
  const kind = body.kind === "device" ? "device" : "tapit";
  const { error: bindErr } = await supabase.from("wallet_identities").insert({
    user_id: userId, pubkey: proof.pubkey, kind, label: kind === "tapit" ? "Tapit wallet" : "Phone key", bound_at: new Date().toISOString(),
  });
  if (bindErr) {
    await supabase.auth.admin.deleteUser(userId);
    // Unique pubkey: a second sign-up with the same key won a race.
    return json(409, { error: "This key already has an account. Use Sign in instead." });
  }

  await supabase.from("wallet_signins").insert({ user_id: userId, pubkey: proof.pubkey, audience: proof.audience });

  const session = await mintSession(supabase, userId);
  if (session.error) return json(session.status, { error: session.error });
  const key_session_claim = await issueKeySessionClaim(supabase, userId);
  return json(200, { ok: true, token_hash: session.token_hash, key_session_claim });
}
