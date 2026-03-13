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
 * Verify the Bearer token in the event headers.
 * Returns { userId } on success or { error } on failure.
 */
export async function requireUser(event) {
  const auth =
    event.headers?.authorization || event.headers?.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

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
