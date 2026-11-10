/**
 * _attest.js -- server-side verification of a governance attestation
 * signature. Pure (no Supabase, no HTTP) so scripts/test-attestation-verify.mjs
 * can prove it against the browser's own signer.
 *
 * MUST stay byte-identical in meaning to apps/web/src/lib/attest.ts's
 * buildDigest:
 *
 *   digest = SHA256("DT-ATT-v1" || attestation_type || 0x00 || target_hash)
 *   signature = BIP340 Schnorr over digest, x-only pubkey
 *
 * Until 2026-11-10 the server stored whatever 64-byte hex it was handed
 * and left verification to the browser at render time, so a member with a
 * session could file a proof-of-life or death-declaration row that no key
 * ever signed. It could not unlock a leaf, but it could mislead heirs and
 * trustees about liveness and succession. This closes that: the row is
 * refused unless the signature verifies under the member's registered key.
 */

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

const TAG = "DT-ATT-v1";

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

export function attestationDigest(attestationType, targetHashHex) {
  const enc = new TextEncoder();
  return sha256(concat(enc.encode(TAG), enc.encode(attestationType), new Uint8Array([0x00]), fromHex(targetHashHex)));
}

/** true iff `signatureHex` (64B Schnorr) verifies for `pubkeyHex` (32B x-only)
 *  over the attestation digest. Never throws: malformed input is `false`. */
export function verifyAttestationSignature({ attestationType, targetHash, signature, pubkey }) {
  try {
    return schnorr.verify(fromHex(signature), attestationDigest(attestationType, targetHash), fromHex(pubkey));
  } catch {
    return false;
  }
}
