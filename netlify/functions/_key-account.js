/**
 * _key-account.js -- the server half of email-free sign-in
 * (docs/key-signin-build-note.md). Operator, 2026-11-13: "never have an
 * email and only sign in with your key ... it can still be hooked to the
 * Supabase".
 *
 * A Supabase account needs an address, so an account made from a key gets
 * a random one at keys.dynastytrust.family -- a name with no mailbox that
 * nothing ever writes to. Proven live 2026-11-13 (key-signin-placeholder-
 * test.yml): Supabase creates it confirmed without sending anything, and
 * the same one-time login token wallet-signin-verify.js already uses logs
 * into it.
 */
import { verifySignIn } from "tapit-attest";
import { extractSignInAttestation } from "./_wallet-signin.js";

import { KEY_DOMAIN, isPlaceholderEmail } from "./_placeholder-guard.js";

export const PLACEHOLDER_DOMAIN = KEY_DOMAIN;
// A never-mailed address: a Tapit-made account, or a username account.
export { isPlaceholderEmail };

export function placeholderEmail() {
  const r = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");
  return `k-${r}@${PLACEHOLDER_DOMAIN}`;
}

/** A name the person chose, safe to store and show: trimmed, no control
 *  characters, at most 40 characters; empty becomes null. */
export function cleanDisplayName(v) {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || null;
}

/**
 * Check a key proof against the EXACT challenge this server issued and
 * consume that challenge (single use, atomically). Returns { pubkey } or
 * { status, error }. Never consumes a challenge for a proof that failed.
 */
export async function proveKeyControl(supabase, body) {
  const extracted = extractSignInAttestation(body);
  if (extracted.error) return { status: 400, error: extracted.error };
  const { attestation, nonce } = extracted;
  const { data: row, error: loadErr } = await supabase
    .from("wallet_signin_challenges")
    .select("nonce, challenge, consumed_at")
    .eq("nonce", nonce)
    .maybeSingle();
  if (loadErr) return { status: 500, error: loadErr.message };
  if (!row) return { status: 401, error: "Unknown or expired challenge" };
  if (row.consumed_at) return { status: 401, error: "Challenge already used" };
  // Threat model G: the sign-in number the person typed in Tapit, signed in.
  const result = verifySignIn({ attestation, expectedChallenge: row.challenge, requireScreenCode: true });
  if (!result.valid) return { status: 401, error: "Key proof failed: " + result.errors.join("; ") };
  return { pubkey: result.signer, nonce, audience: row.challenge.audience };
}

export async function consumeChallenge(supabase, nonce) {
  const { data, error } = await supabase
    .from("wallet_signin_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", nonce)
    .is("consumed_at", null)
    .select("nonce");
  if (error) return { status: 500, error: error.message };
  if (!data || data.length === 0) return { status: 401, error: "Challenge already used" };
  return {};
}

/** A one-time login token for this account, redeemed in the browser with
 *  supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }). Nothing is
 *  sent anywhere. */
export async function mintSession(supabase, userId) {
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
  const email = userData?.user?.email;
  if (userErr || !email) return { status: 500, error: "Could not resolve the account" };
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkErr || !tokenHash) return { status: 500, error: "Could not establish a session" };
  return { token_hash: tokenHash };
}

// -- Key-made sessions (slice 3) ---------------------------------------------
// A login token earned by a key proof comes with a one-time claim. The
// browser redeems the token, then hands the claim back with its NEW
// session's access token (key-session.js), and that session id is recorded
// as key-made. Only the hash of the claim is stored.

const CLAIM_TTL_MS = 10 * 60 * 1000;

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, "0")).join("");
}

export async function issueKeySessionClaim(supabase, userId) {
  const claim = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
  const { error } = await supabase.from("key_session_claims").insert({
    claim_hash: await sha256Hex(claim), user_id: userId, expires_at: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
  });
  return error ? null : claim; // a failed claim only means the join rule asks for the code
}

/** Redeem a claim for the session that is calling. Returns {} or { status, error }. */
export async function redeemKeySessionClaim(supabase, { claim, userId, sessionId }) {
  if (typeof claim !== "string" || !/^[0-9a-f]{64}$/.test(claim)) return { status: 400, error: "Malformed claim" };
  if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) return { status: 400, error: "This session has no id" };
  const hash = await sha256Hex(claim);
  const { data: row, error } = await supabase.from("key_session_claims").select("user_id, expires_at, used_at").eq("claim_hash", hash).maybeSingle();
  if (error) return { status: 500, error: error.message };
  if (!row || row.user_id !== userId) return { status: 403, error: "This claim is not for this account" };
  if (row.used_at) return { status: 409, error: "This claim was already used" };
  if (Date.parse(row.expires_at) < Date.now()) return { status: 410, error: "This claim has expired" };
  const { data: used, error: useErr } = await supabase.from("key_session_claims")
    .update({ used_at: new Date().toISOString() }).eq("claim_hash", hash).is("used_at", null).select("claim_hash");
  if (useErr) return { status: 500, error: useErr.message };
  if (!used || used.length === 0) return { status: 409, error: "This claim was already used" };
  const { error: insErr } = await supabase.from("key_sessions").insert({ session_id: sessionId, user_id: userId });
  if (insErr && insErr.code !== "23505") return { status: 500, error: insErr.message };
  return {};
}

/** Was the calling session made by proving a key? (verified JWT claims) */
export async function isKeySession(supabase, claims) {
  const sid = claims?.session_id, uid = claims?.sub;
  if (typeof sid !== "string" || typeof uid !== "string") return false;
  const { data } = await supabase.from("key_sessions").select("user_id").eq("session_id", sid).maybeSingle();
  return !!data && data.user_id === uid;
}
