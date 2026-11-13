/**
 * key-session.js -- record that the CALLING session was made by proving a
 * key (email-free sign-in, slice 3; operator's chip: "Key sign-in is
 * enough" to join a real-bitcoin vault).
 *
 * POST /api/key-session   (auth: the session just made)
 *   Body: { claim }  -- the one-time claim key-signup.js or
 *   wallet-signin-verify.js returned with the login token.
 * The session id comes from the verified access token, never the body.
 */
import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { redeemKeySessionClaim } from "./_key-account.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON body" }); }
  const r = await redeemKeySessionClaim(getSupabaseAdmin(), { claim: body.claim, userId: u.userId, sessionId: u.claims?.session_id });
  if (r.error) return json(r.status, { error: r.error });
  return json(200, { ok: true });
}
