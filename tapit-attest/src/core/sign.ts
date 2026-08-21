/**
 * Sign and verify attestation envelopes.
 *
 * Signing appends an `AttestationSignature` over `attestationDigest`.
 * Multiple signers each sign the SAME digest -- that is how a
 * co-signed (notable / high-stakes) attestation and a multi-witness
 * declaration both work, exactly like DynastyTrust's death
 * declaration where N witnesses sign one shared target hash.
 *
 * BIP340 Schnorr over secp256k1, via `@noble/curves` -- the same
 * library and curve DynastyTrust signs PSBTs with. No Ed25519.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { fromHex, toHex } from '../internal/hex.js';
import {
  attestationDigest,
  type AttestationEnvelope,
  type AttestationSignature,
} from './envelope.js';
import { isPublicKey, isSignature, publicKeyFromPrivate } from './keys.js';

export interface SignOptions {
  /** Weight this signer contributes to tier evaluation. Default 1. */
  readonly weight?: number;
  /** Optional named role recorded on the signature. */
  readonly role?: string;
  /** ISO timestamp; defaults to now. */
  readonly signedAt?: string;
}

/**
 * Sign an envelope and return a NEW envelope with the signature
 * appended. Envelopes are treated as immutable; the input is not
 * mutated. Re-signing with a key that already signed is rejected.
 */
export function signEnvelope(
  env: AttestationEnvelope,
  privateKey: string | Uint8Array,
  opts: SignOptions = {},
): AttestationEnvelope {
  const priv = typeof privateKey === 'string' ? fromHex(privateKey) : privateKey;
  const signer = publicKeyFromPrivate(priv);
  if (env.signatures.some((s) => s.signer === signer)) {
    throw new Error('this key has already signed the envelope');
  }
  const digest = attestationDigest(env);
  const sig = schnorr.sign(digest, priv);
  const signature: AttestationSignature = {
    signer,
    sig: toHex(sig),
    signedAt: opts.signedAt ?? new Date().toISOString(),
    weight: opts.weight ?? 1,
    ...(opts.role ? { role: opts.role } : {}),
  };
  return { ...env, signatures: [...env.signatures, signature] };
}

// `AttestationSignature.weight` is never covered by attestationDigest --
// it's free-form metadata a signer (or a hostile relay/MITM, since it
// isn't signed) can set to anything. `verifyEnvelope` feeds it straight
// into `signerWeights`, which `evaluateTier` sums against a threshold:
// an unbounded weight lets one otherwise-legitimate signature satisfy
// any threshold alone (Number.MAX_VALUE), or a negative one depress a
// legitimate tally. Clamp rather than reject the whole signature --
// weight corruption doesn't invalidate the Schnorr signature itself,
// and rejecting the signature over it would let an attacker who can
// only tamper with the UNSIGNED weight field (not forge a signature)
// DoS an otherwise-valid attestation's `valid` flag.
const MAX_SIGNER_WEIGHT = 2 ** 31;

function sanitizeWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 && weight <= MAX_SIGNER_WEIGHT
    ? weight
    : 1;
}

/** Verify one signature against an envelope's digest. */
export function verifySignature(
  env: AttestationEnvelope,
  signature: AttestationSignature,
): boolean {
  try {
    if (!isPublicKey(signature.signer) || !isSignature(signature.sig)) {
      return false;
    }
    const digest = attestationDigest(env);
    return schnorr.verify(fromHex(signature.sig), digest, fromHex(signature.signer));
  } catch {
    return false;
  }
}

export interface VerifyResult {
  /** True when there is at least one signature and all of them verify. */
  readonly valid: boolean;
  readonly validSigners: readonly string[];
  readonly invalidSigners: readonly string[];
  /** Valid signers mapped to their declared weight -- feed to evaluateTier. */
  readonly signerWeights: ReadonlyMap<string, number>;
}

/** Verify every signature on an envelope. */
export function verifyEnvelope(env: AttestationEnvelope): VerifyResult {
  const validSigners: string[] = [];
  const invalidSigners: string[] = [];
  const signerWeights = new Map<string, number>();

  for (const sig of env.signatures) {
    if (verifySignature(env, sig)) {
      validSigners.push(sig.signer);
      signerWeights.set(sig.signer, sanitizeWeight(sig.weight));
    } else {
      invalidSigners.push(sig.signer);
    }
  }

  return {
    valid: env.signatures.length > 0 && invalidSigners.length === 0,
    validSigners,
    invalidSigners,
    signerWeights,
  };
}
