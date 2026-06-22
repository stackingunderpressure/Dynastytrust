import { schnorr } from '@noble/curves/secp256k1';
import { canonicalJson } from '../internal/canonical.js';
import { taggedHash } from '../internal/hash.js';
import { utf8, toHex, fromHex, randomBytes } from '../internal/hex.js';

/**
 * Sign-in by attestation -- prove control of a key by signing a fresh,
 * single-use challenge, the same nonce-bearing pattern the recovery
 * request/response uses. The relying party (the verifier) mints a
 * challenge with a random nonce, the holder signs a domain-separated
 * digest over it, and the verifier checks two things: that the answer
 * echoes the exact challenge it issued, and that the Schnorr signature
 * is valid for the claimed key.
 *
 * Security model -- read before using `verifySignIn`. The challenge is a
 * bearer nonce, not itself signed. Its whole security value is freshness:
 * the verifier MUST persist the challenge it issued and pass that same
 * object back as `expectedChallenge`. Verifying an attestation against a
 * challenge the *signer* supplied proves nothing -- anyone can sign a
 * nonce they chose themselves. The echo check is what binds the proof to
 * a live, server-chosen challenge and defeats replay.
 *
 * Cross-repo parity: this is a faithful port of the Tapit wallet's
 * `tapit-attest/src/core/sign-in.ts`. The digest is
 * `taggedHash('tapit/sign-in', utf8(canonicalJson(base)))` and is proven
 * byte-identical to the Tapit primitive by `test/sign-in.test.mjs`, which
 * verifies a real Tapit-produced attestation. A Schnorr signature only
 * verifies when both sides compute the identical digest, so that test is
 * the parity gate. Never change the tag, the base shape, or canonicalJson
 * without regenerating the golden fixture from Tapit's source.
 */

/** A verifier-issued, single-use sign-in challenge. */
export interface SignInChallenge {
  v: 1;
  /** Random freshness nonce (32-byte hex). The anti-replay heart of the flow. */
  nonce: string;
  /**
   * Who the challenge is for -- the relying party identifier (a domain, an
   * app id). Binds the proof to one context so a sign-in minted for app A
   * can never be presented to app B.
   */
  audience: string;
  issuedAt: string;
  /** ISO timestamp after which the challenge is stale and must be rejected. */
  expiresAt: string;
}

/** A holder's signed proof that they control `signer`, answering one challenge. */
export interface SignInAttestation {
  v: 1;
  /** The exact challenge being answered, echoed back verbatim. */
  challenge: SignInChallenge;
  /** x-only public key of the holder proving key control. */
  signer: string;
  issuedAt: string;
  /** The holder's Schnorr signature over the sign-in digest. */
  signature: string;
}

type SignInBase = Omit<SignInAttestation, 'signature'>;

function isHex(value: unknown, byteLength?: number): value is string {
  if (typeof value !== 'string' || value.length % 2 !== 0) return false;
  if (!/^[0-9a-fA-F]*$/.test(value)) return false;
  return byteLength === undefined || value.length === byteLength * 2;
}

function signInBase(attestation: SignInAttestation): SignInBase {
  return {
    v: attestation.v,
    challenge: attestation.challenge,
    signer: attestation.signer,
    issuedAt: attestation.issuedAt,
  };
}

function signInDigest(base: SignInBase): Uint8Array {
  return taggedHash('tapit/sign-in', utf8(canonicalJson(base)));
}

/** True when a value has the full, well-typed shape of a sign-in challenge. */
function isChallengeShape(value: unknown): value is SignInChallenge {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    isHex(c.nonce, 32) &&
    typeof c.audience === 'string' &&
    c.audience.length > 0 &&
    typeof c.issuedAt === 'string' &&
    typeof c.expiresAt === 'string'
  );
}

/**
 * Mint a fresh sign-in challenge. The caller persists the returned object
 * (keyed by nonce) and hands it back to `verifySignIn` as
 * `expectedChallenge` when the answer arrives. `ttlSeconds` defaults to
 * five minutes; pass `nonce` / `issuedAt` only for deterministic tests.
 */
export function buildSignInChallenge(input: {
  audience: string;
  ttlSeconds?: number;
  nonce?: string;
  issuedAt?: string;
}): SignInChallenge {
  if (typeof input.audience !== 'string' || input.audience.length === 0) {
    throw new Error('audience must be a non-empty string');
  }
  const ttlSeconds = input.ttlSeconds ?? 300;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive number');
  }
  let nonce: string;
  if (input.nonce !== undefined) {
    if (!isHex(input.nonce, 32)) throw new Error('nonce must be 32-byte hex');
    nonce = input.nonce;
  } else {
    nonce = toHex(randomBytes(32));
  }
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const issuedMs = Date.parse(issuedAt);
  if (Number.isNaN(issuedMs)) throw new Error('issuedAt must be an ISO timestamp');
  const expiresAt = new Date(issuedMs + ttlSeconds * 1000).toISOString();
  return { v: 1, nonce, audience: input.audience, issuedAt, expiresAt };
}

/**
 * Sign a challenge, producing the sign-in attestation the verifier checks.
 * The signer's key never leaves the caller -- only the public key and the
 * signature travel. Present for completeness and tests; in production the
 * Tapit wallet is the signer and DynastyTrust is the verifier.
 */
export function answerSignInChallenge(input: {
  challenge: SignInChallenge;
  signerPrivateKey: string;
  issuedAt?: string;
}): SignInAttestation {
  if (!isChallengeShape(input.challenge)) {
    throw new Error('challenge is malformed');
  }
  if (!isHex(input.signerPrivateKey, 32)) {
    throw new Error('signerPrivateKey must be 32-byte hex');
  }
  const priv = fromHex(input.signerPrivateKey);
  const base: SignInBase = {
    v: 1,
    challenge: input.challenge,
    signer: toHex(schnorr.getPublicKey(priv)),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  return { ...base, signature: toHex(schnorr.sign(signInDigest(base), priv)) };
}

export interface SignInVerifyResult {
  /** True only when echo, freshness, and signature all hold. */
  valid: boolean;
  /** The x-only key that proved control, or null when the proof fails. */
  signer: string | null;
  errors: string[];
}

/**
 * Verify a sign-in attestation against the challenge the verifier issued.
 * Never throws. Three independent checks must all pass: the answered
 * challenge is byte-identical to the issued one (echo), the issued
 * challenge has not expired (freshness), and the Schnorr signature is
 * valid for the claimed key (control). `expectedChallenge` is mandatory
 * and must be the verifier's own stored copy -- see the module security
 * note for why verifying against a signer-supplied challenge is worthless.
 */
export function verifySignIn(input: {
  attestation: SignInAttestation;
  expectedChallenge: SignInChallenge;
  /** Current time in ms for the freshness check. Defaults to `Date.now()`. */
  now?: number;
}): SignInVerifyResult {
  const att = input.attestation;
  if (!att || !isHex(att.signature, 64) || !isHex(att.signer, 32)) {
    return { valid: false, signer: null, errors: ['malformed sign-in attestation'] };
  }
  if (!isChallengeShape(input.expectedChallenge) || !isChallengeShape(att.challenge)) {
    return { valid: false, signer: null, errors: ['malformed challenge'] };
  }

  const errors: string[] = [];

  // Echo: the answered challenge must be exactly what the verifier issued.
  if (canonicalJson(att.challenge) !== canonicalJson(input.expectedChallenge)) {
    errors.push('challenge echo does not match the issued challenge');
  }

  // Freshness: reject a challenge past its expiry.
  const now = input.now ?? Date.now();
  const expiresMs = Date.parse(input.expectedChallenge.expiresAt);
  if (Number.isNaN(expiresMs)) {
    errors.push('challenge expiresAt is not a valid timestamp');
  } else if (now > expiresMs) {
    errors.push('challenge has expired');
  }

  // Control: the signature must verify for the claimed key.
  let signatureOk = false;
  try {
    signatureOk = schnorr.verify(
      fromHex(att.signature),
      signInDigest(signInBase(att)),
      fromHex(att.signer),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) errors.push('sign-in signature is invalid');

  const valid = errors.length === 0;
  return { valid, signer: valid ? att.signer : null, errors };
}
