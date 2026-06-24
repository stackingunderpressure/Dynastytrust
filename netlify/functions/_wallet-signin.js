/**
 * _wallet-signin.js -- shared, pure helpers for the Tapit sign-in functions.
 *
 * Kept tiny and dependency-free so it is unit-testable on its own (the
 * Supabase + session-mint paths in the handlers need a live smoke). The
 * crypto verify itself lives in tapit-attest (verifySignIn) and is tested
 * there -- never re-implemented here.
 */

/**
 * Pull the SignInAttestation out of a request body { grant: { attestation } }
 * and shape-check it enough to safely look up the stored challenge. Returns
 * { attestation, nonce } on success or { error } with a client-safe message.
 */
export function extractSignInAttestation(body) {
  const grant = body && typeof body === "object" ? body.grant : null;
  const attestation = grant && typeof grant === "object" ? grant.attestation : null;
  if (!attestation || typeof attestation !== "object") {
    return { error: "Missing sign-in attestation" };
  }
  const challenge = attestation.challenge;
  if (!challenge || typeof challenge !== "object") {
    return { error: "Malformed sign-in attestation: no challenge" };
  }
  const nonce = challenge.nonce;
  if (typeof nonce !== "string" || !/^[0-9a-fA-F]{64}$/.test(nonce)) {
    return { error: "Malformed challenge nonce" };
  }
  if (typeof attestation.signer !== "string" || typeof attestation.signature !== "string") {
    return { error: "Malformed sign-in attestation: missing signer/signature" };
  }
  return { attestation, nonce };
}
