/**
 * legacy-recovery.ts — long-horizon descriptor recovery, independent of
 * this app ever running again.
 *
 * The problem: a vault's descriptor has to survive decades so a surviving
 * keyholder can still craft a valid spend, without depending on a paper
 * backup surviving fire/loss or on DynastyTrust's own servers staying up.
 *
 * The mechanism (see docs -- this is the crypto core only, stage 1 of the
 * Legacy Recovery plan):
 *   1. A random 32-byte secret seals the recovery bundle (descriptor +
 *      policy) with AES-256-GCM.
 *   2. That secret is split via audited Shamir secret sharing into one
 *      share per long-horizon keyholder plus one unlocked on-chain share,
 *      threshold 2 -- any two pieces reconstruct it.
 *   3. Each keyholder's share is locked with a value derived from their
 *      OWN key at a fixed, dedicated, hardened path -- never a separately
 *      stored secret. Deliberately NOT a signature: raw BIP32 derivation +
 *      one hash + one XOR has zero room for cross-implementation drift the
 *      way signature nonce derivation could, which matters when "redo this
 *      in 30 years with different software" is a real requirement.
 *
 * Every primitive here is a published, permanent standard -- BIP32
 * derivation, SHA-256, XOR, Shamir secret sharing, AES-256-GCM -- not
 * DynastyTrust-specific math. That's deliberate: the written recovery
 * recipe (see descriptor-backup.ts) is the real durability guarantee, not
 * this file. This module exists so the app can do the same steps
 * conveniently; it is not the only way those steps can ever be done.
 */

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { sha256 } from '@noble/hashes/sha256';
import { split as shamirSplit, combine as shamirCombine } from 'shamir-secret-sharing';
import { networkVersions, type Network } from './keystore';

// Reserved purpose field for the legacy-recovery derivation path. Not a
// registered BIP (44/49/84/86/48 are all taken) -- a DynastyTrust-wide
// constant, deliberately public and identical for every vault. Publicness
// is safe: hardened derivation means nobody can compute this path's
// resulting key from an xpub alone, only from the actual private key, so
// naming the convention openly leaks nothing. See legacy-recovery.ts's
// header and docs/-- the written recovery recipe documents this path
// verbatim so recovery never depends on this constant surviving in code.
export const LEGACY_PURPOSE = "9999'";

export function legacyDerivationPath(network: Network): string {
  const coin = network === 'mainnet' ? '0' : '1';
  return `m/${LEGACY_PURPOSE}/${coin}'/0'/0'`;
}

const LEGACY_TAG_PREFIX = 'dynastytrust-legacy-v1';

/**
 * Derives the 32-byte value that locks/unlocks ONE keyholder's share for
 * ONE vault. Domain-separated by vaultId + keyRole so the same mnemonic
 * reused across different vaults or roles never produces the same lock
 * value twice -- compromising one vault's legacy share never helps
 * reconstruct another's.
 */
export function deriveLegacyLockBytes(
  mnemonic: string,
  network: Network,
  vaultId: string,
  keyRole: string,
): Uint8Array {
  const seed  = mnemonicToSeedSync(mnemonic);
  const root  = HDKey.fromMasterSeed(seed, networkVersions(network));
  const child = root.derive(legacyDerivationPath(network));
  if (!child.privateKey) {
    throw new Error('legacy derivation produced no private key (hardened path requires the seed, not an xpub)');
  }
  const tag = new TextEncoder().encode(`${LEGACY_TAG_PREFIX}:${vaultId}:${keyRole}`);
  const input = new Uint8Array(child.privateKey.length + tag.length);
  input.set(child.privateKey, 0);
  input.set(tag, child.privateKey.length);
  return sha256(input);
}

/**
 * Expands lockBytes into a keystream of exactly `length` bytes via
 * repeated counter-hashing (a minimal HKDF-expand, not the full RFC 5869
 * extract+expand -- lockBytes is already uniformly random 32-byte output
 * from deriveLegacyLockBytes, so the extract step buys nothing here).
 * Needed because a Shamir share's byte length isn't guaranteed to equal
 * the 32-byte lock value's length.
 */
function expandKeystream(lockBytes: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let filled = 0;
  let counter = 0;
  while (filled < length) {
    const block = new Uint8Array(lockBytes.length + 1);
    block.set(lockBytes, 0);
    block[lockBytes.length] = counter;
    const digest = sha256(block);
    const take = Math.min(digest.length, length - filled);
    out.set(digest.subarray(0, take), filled);
    filled += take;
    counter += 1;
  }
  return out;
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new Error(`xorBytes: length mismatch (${a.length} vs ${b.length})`);
  }
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** Locks a raw Shamir share so only the matching lock value can read it. XOR is its own inverse, so unlockShare is the same function. */
export function lockShare(shareBytes: Uint8Array, lockBytes: Uint8Array): Uint8Array {
  return xorBytes(shareBytes, expandKeystream(lockBytes, shareBytes.length));
}
export const unlockShare = lockShare;

// ── Descriptor bundle sealing (AES-256-GCM, native WebCrypto -- same
// primitive keystore.ts uses for secure-mode key encryption) ──────────────

export interface SealedBundle {
  version: 1;
  nonceB64: string;
  ciphertextB64: string;
}

function b64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

/** Generates a fresh random 32-byte secret. Callers split this via splitLegacySecret and encrypt the bundle with it -- never persist it unsplit. */
export function generateLegacySecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// crypto.subtle's typings want an ArrayBuffer-backed BufferSource; bytes
// arriving from @noble/hashes / the Shamir library are typed generically
// (Uint8Array<ArrayBufferLike>). The assertion below is accurate to
// runtime reality (these are always plain ArrayBuffer-backed views in
// practice), not a workaround for a real bug -- same root cause as the
// pre-existing Uint8Array/BufferSource variance CLAUDE.md already
// documents for keystore.ts, not introduced by this file.
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource;
}

export async function sealBundle(bundleText: string, secret: Uint8Array): Promise<SealedBundle> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', asBufferSource(secret), 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(bundleText));
  return { version: 1, nonceB64: b64(nonce), ciphertextB64: b64(new Uint8Array(ct)) };
}

export async function unsealBundle(sealed: SealedBundle, secret: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', asBufferSource(secret), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(unb64(sealed.nonceB64)) }, key, asBufferSource(unb64(sealed.ciphertextB64)),
  );
  return new TextDecoder().decode(plain);
}

// ── Shamir split/combine -- thin, documented wrapper over the audited
// `shamir-secret-sharing` library (Privy, Apache-2.0, zero-dependency).
// Not hand-rolled: this repo does not implement its own GF(256) polynomial
// math. ─────────────────────────────────────────────────────────────────

/**
 * Splits `secret` into `totalShares` pieces, any `threshold` of which
 * reconstruct it. Caller is responsible for locking the keyholder-tied
 * shares (via lockShare) before storing/publishing them -- this function
 * only performs the underlying Shamir split.
 */
export async function splitLegacySecret(
  secret: Uint8Array,
  totalShares: number,
  threshold: number,
): Promise<Uint8Array[]> {
  return shamirSplit(secret, totalShares, threshold);
}

export async function combineLegacySecret(shares: Uint8Array[]): Promise<Uint8Array> {
  return shamirCombine(shares);
}
