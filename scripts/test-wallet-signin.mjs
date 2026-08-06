import test from "node:test";
import assert from "node:assert/strict";
import { extractSignInAttestation } from "../netlify/functions/_wallet-signin.js";

const goodNonce = "a".repeat(64);
function att(over = {}) {
  return {
    grant: {
      attestation: {
        v: 1,
        challenge: { v: 1, nonce: goodNonce, audience: "dynastytrust.family", issuedAt: "x", expiresAt: "y" },
        signer: "b".repeat(64),
        issuedAt: "x",
        signature: "c".repeat(128),
        ...over,
      },
    },
  };
}

test("extracts a well-formed sign-in attestation", () => {
  const r = extractSignInAttestation(att());
  assert.equal(r.error, undefined);
  assert.equal(r.nonce, goodNonce);
  assert.equal(r.attestation.signer, "b".repeat(64));
});

test("rejects a missing grant/attestation", () => {
  assert.match(extractSignInAttestation({}).error, /Missing sign-in attestation/);
  assert.match(extractSignInAttestation({ grant: {} }).error, /Missing sign-in attestation/);
});

test("rejects a missing challenge", () => {
  assert.match(extractSignInAttestation(att({ challenge: undefined })).error, /no challenge/);
});

test("rejects a bad nonce", () => {
  assert.match(
    extractSignInAttestation(att({ challenge: { v: 1, nonce: "short", audience: "x", issuedAt: "x", expiresAt: "y" } })).error,
    /nonce/,
  );
});

test("rejects a missing signer or signature", () => {
  assert.match(extractSignInAttestation(att({ signer: undefined })).error, /signer\/signature/);
  assert.match(extractSignInAttestation(att({ signature: undefined })).error, /signer\/signature/);
});
