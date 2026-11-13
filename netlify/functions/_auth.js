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
import { placeholderAccountAllowed, currentAppMeta } from "./_placeholder-guard.js";

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
 * Returns true / false, or null when the lookup failed -- and requireUser
 * then refuses a password-only (aal1) request. It was fail-open until the
 * lookup was proven on the live project (2026-11-13, see the catch below
 * and docs/security-backlog.md item 10).
 */
export async function hasVerifiedFactor(userId) {
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
    // Fail CLOSED since 2026-11-13 (threat model C): the lookup was proven
    // working on the live project (key-signin-placeholder-test run
    // 43465741702, HTTP 200), so an error here is an outage or an attack,
    // and a password-only session is refused until it can be checked.
    console.error("[auth] MFA factor lookup FAILED -- refusing this password-only request:", e?.message || e);
    return null;
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
    if (payload.aal !== "aal2") {
      const has = await hasVerifiedFactor(payload.sub);
      if (has === null) {
        return { error: "Could not check your two-step sign-in just now. Try again in a moment." };
      }
      if (!aalSatisfied(payload.aal, has)) {
        return { error: "Two-step sign-in required: enter your authenticator code to continue" };
      }
    }

    // Threat model J: a never-mailed username/Tapit address this app did
    // not make (someone used Supabase's public sign-up with it) never acts.
    const allowed = await placeholderAccountAllowed(payload, currentAppMeta);
    if (allowed === null) return { error: "Could not check this account just now. Try again in a moment." };
    if (!allowed) return { error: "This account was not made by DynastyTrust. Sign in with your own username, email or Tapit wallet." };

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
