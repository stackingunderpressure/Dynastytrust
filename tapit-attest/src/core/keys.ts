/**
 * secp256k1 / Schnorr key material.
 *
 * tapit-attest is storage-agnostic about WHERE a key comes from.
 * DynastyTrust derives the signing key as the `/0/0` BIP32 child of
 * a vault member's mnemonic; another consumer might use a hardware
 * key or a fresh keypair. This module only deals in raw 32-byte
 * private keys and 32-byte x-only public keys -- exactly the
 * BIP340 shape DynastyTrust signs PSBTs and attestations with.
 *
 * No Bitcoin-script dependency: no descriptors, no PSBT, no
 * Miniscript. Just the curve.
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { fromHex, toHex } from '../internal/hex.js';

export interface Keypair {
  /** 32-byte private key, hex. */
  readonly privateKey: string;
  /** 32-byte x-only public key, hex (64 chars). */
  readonly publicKey: string;
}

function asBytes(key: string | Uint8Array): Uint8Array {
  return typeof key === 'string' ? fromHex(key) : key;
}

/** Fresh random keypair. Uses the platform CSPRNG. */
export function generateKeypair(): Keypair {
  const priv = secp256k1.utils.randomPrivateKey();
  return {
    privateKey: toHex(priv),
    publicKey: toHex(schnorr.getPublicKey(priv)),
  };
}

/** Derive the x-only public key for a private key. */
export function publicKeyFromPrivate(privateKey: string | Uint8Array): string {
  return toHex(schnorr.getPublicKey(asBytes(privateKey)));
}

/** True if `s` is a 64-char hex x-only public key. */
export function isPublicKey(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

/** True if `s` is a 128-char hex Schnorr signature. */
export function isSignature(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-fA-F]{128}$/.test(s);
}
