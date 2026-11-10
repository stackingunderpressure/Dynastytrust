/**
 * _auth.js — JWKS-based JWT verification for all Netlify Functions.
 *
 * Uses Supabase's RS256/ES256 JWKS endpoint (the correct modern approach).
 * Replaces the HS256 jsonwebtoken approach that was in server.mjs.
 *
 * Usage:
 *   import { requireUser } from "./_auth.js";
 *   const u = await requireUser(event);
 *   if (u.error) return json(401, { error: u.error });
 *   // u.userId is the Supabase user UUID
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL) throw new Error("Missing env: SUPABASE_URL");

// JWKS is cached in-process by jose — no per-request HTTP calls after warm-up.
const JWKS = createRemoteJWKSet(
  new URL("/auth/v1/.well-known/jwks.json", SUPABASE_URL)
);

/**
 * Pure: may a token with this assurance level act for an account that
 * does / does not have a verified second factor? aal2 always may; aal1
 * only when the account has no second factor to ask for.
 */
export function aalSatisfied(aal, accountHasVerifiedFactor) {
  return aal === "aal2" || accountHasVerifiedFactor === false;
}

// userId -> { has, at }. A warm function instance re-checks at most
// once a minute per user, so the common case costs nothing extra. The
// only staleness that matters is the minute after someone turns
// two-step ON, during which an aal1 token minted before that still
// passes; turning it OFF needs an aal2 session, which always passes.
const FACTOR_CACHE = new Map();
const FACTOR_TTL_MS = 60_000;

/**
 * Does this account have a verified authenticator?
 *
 * ON A LOOKUP ERROR THIS RETURNS false (the step is not asked for) and
 * logs loudly. That is a deliberate, temporary choice: this check runs
 * in front of every function, it could not be exercised against the
 * live project when it was written (2026-11-10), and failing closed on
 * an untested lookup would turn one wrong assumption into a total
 * outage for every account. Once the operator has witnessed real
 * lookups succeeding in the function logs, flip this to throw -- see
 * docs/security-backlog.md item 10.
 */
async function hasVerifiedFactor(userId) {
  const hit = FACTOR_CACHE.get(userId);
  if (hit && Date.now() - hit.at < FACTOR_TTL_MS) return hit.has;
  try {
    const { getSupabaseAdmin } = await import("./_supabase.js");
    const { data, error } = await getSupabaseAdmin().auth.admin.mfa.listFactors({ userId });
    if (error) throw error;
    const has = (data?.factors ?? []).some((f) => f.status === "verified");
    FACTOR_CACHE.set(userId, { has, at: Date.now() });
    return has;
  } catch (e) {
    console.error("[auth] MFA factor lookup FAILED -- second step NOT enforced for this request:", e?.message || e);
    return false;
  }
}

/**
 * Verify the Bearer token in the event headers. Pass
 * `{ allowQueryToken: true }` to also fall back to a `?token=`
 * query-string param when there's no Authorization header -- needed
 * for endpoints opened as a plain navigation/link (window.open,
 * <a href>), which can't set custom request headers. Only the four
 * endpoints apps/web/src/lib/api.ts builds a `?token=`-bearing URL for
 * -- vault-pdf.js, vault-tax-summary.js, vault-audit-pdf.js, and
 * vault-activity-export.js -- opt in.
 *
 * This must stay opt-in, not the default: a query-string token ends up
 * in server access logs, browser history, and Referer headers wherever
 * it's followed from, and requireUser is imported by every one of this
 * app's ~40 Netlify functions -- most of which are called with fetch()
 * and never need this fallback at all.
 * Returns { userId } on success or { error } on failure.
 */
export async function requireUser(event, { allowQueryToken = false } = {}) {
  const auth =
    event.headers?.authorization || event.headers?.Authorization || "";
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : (allowQueryToken ? (event.queryStringParameters?.token || null) : null);

  if (!token) {
    return { error: "Missing Authorization: Bearer <token>" };
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: new URL("/auth/v1", SUPABASE_URL).toString(),
      audience: "authenticated",
    });

    if (!payload?.sub) {
      return { error: "Invalid token: missing sub claim" };
    }

    // Two-step sign-in is enforced HERE, not only in the browser: once
    // an account has a verified authenticator, a session that has only
    // proven the password (aal1) is refused by every function.
    if (payload.aal !== "aal2" && !aalSatisfied(payload.aal, await hasVerifiedFactor(payload.sub))) {
      return { error: "Two-step sign-in required: enter your authenticator code to continue" };
    }

    return { userId: payload.sub, claims: payload };
  } catch (err) {
    // Don't leak error details to the client
    return { error: "Invalid or expired token" };
  }
}

/** Helper: return a JSON response */
export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}
