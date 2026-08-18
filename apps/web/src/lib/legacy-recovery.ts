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
 *   2. That secret is split TWO ways, sharing the same 32 bytes:
 *        - the FAST PATH: one shared random pad published unlocked
 *          on-chain, XORed against a single "fast share" value every
 *          keyholder separately locks with their own key. Recovering with
 *          ONE surviving keyholder's key plus the on-chain pad is a single
 *          XOR -- no field arithmetic at all, the common case stays as
 *          simple as this problem can possibly get.
 *        - the FALLBACK PATH: a genuine (2, N)-threshold Shamir split of
 *          the SAME secret across the N keyholders only (the on-chain pad
 *          never participates in this layer). Any two keyholders'
 *          fallback shares reconstruct the secret via real Shamir math,
 *          without needing the on-chain pad at all -- kept as the
 *          documented escape hatch for "the on-chain piece is somehow
 *          gone, but two people survived," a rarer case that can afford
 *          to cost more machinery.
 *   3. Every share -- fast and fallback alike -- is locked with a value
 *      derived from that keyholder's OWN key at a fixed, dedicated,
 *      hardened path -- never a separately stored secret. Deliberately NOT
 *      a signature: raw BIP32 derivation + one hash + one XOR has zero
 *      room for cross-implementation drift the way signature nonce
 *      derivation could, which matters when "redo this in 30 years with
 *      different software" is a real requirement.
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

export function b64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}
export function unb64(s: string): Uint8Array {
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

// ── Hybrid split: fast XOR path (common case) + Shamir fallback path
// (rare case). Both reconstruct the SAME secret; which one a recovering
// keyholder uses depends only on what they have on hand. ──────────────────

export interface HybridSplitResult {
  /** Published unlocked -- no key needed to read it. Goes on-chain. */
  onChainShare: Uint8Array;
  /**
   * `secret XOR onChainShare` -- identical raw value for every keyholder
   * before locking. Each keyholder locks this same value with their own
   * distinct lock bytes (see deriveLegacyLockBytes), so the LOCKED blobs
   * differ per person even though the plaintext underneath is shared.
   * That's safe: a locked blob alone reveals nothing without that one
   * person's key, regardless of how many other people locked the same
   * plaintext with their own different keys.
   */
  fastPathShare: Uint8Array;
  /**
   * One genuine (2, keyholderCount)-threshold Shamir share per keyholder,
   * in keyholder order, from splitting `secret` alone -- the on-chain
   * share never participates in this polynomial. Any two of these
   * reconstruct the secret without the on-chain piece.
   */
  fallbackShares: Uint8Array[];
}

export async function splitLegacySecretHybrid(
  secret: Uint8Array,
  keyholderCount: number,
): Promise<HybridSplitResult> {
  if (keyholderCount < 2) {
    // The fallback path is "any TWO keyholders reconstruct it" -- with
    // only one keyholder there is no second person to fall back to, so
    // asking the underlying Shamir library for a (2, 1) split is a
    // meaningless request it would otherwise reject with an opaque
    // "shares must be at least 2" error. Fail clearly instead: the fast
    // path (this one key + the on-chain share) is still fully available
    // and is the only path such a vault ever needed.
    throw new Error(
      `splitLegacySecretHybrid: fallback path needs at least 2 keyholders, got ${keyholderCount}. ` +
      `The fast path (one key + the on-chain share) works fine with a single keyholder -- ` +
      `only the two-keyholder fallback path requires a second person.`,
    );
  }
  const onChainShare = crypto.getRandomValues(new Uint8Array(secret.length));
  const fastPathShare = xorBytes(secret, onChainShare);
  const fallbackShares = await splitLegacySecret(secret, keyholderCount, 2);
  return { onChainShare, fastPathShare, fallbackShares };
}

/**
 * The common-case recovery: one surviving keyholder's key plus the
 * published on-chain share. Pure XOR, synchronous, no field arithmetic.
 */
export function recoverViaFastPath(
  lockedFastPathShare: Uint8Array,
  lockBytes: Uint8Array,
  onChainShare: Uint8Array,
): Uint8Array {
  const fastPathShare = unlockShare(lockedFastPathShare, lockBytes);
  return xorBytes(fastPathShare, onChainShare);
}

/**
 * The rare-case recovery: two surviving keyholders, on-chain share
 * unavailable. Real (2, N) Shamir reconstruction over the two keyholders'
 * fallback shares -- see combineLegacySecret / the module header for the
 * underlying GF(2^8) math.
 */
export async function recoverViaFallbackPath(
  lockedFallbackShareA: Uint8Array,
  lockBytesA: Uint8Array,
  lockedFallbackShareB: Uint8Array,
  lockBytesB: Uint8Array,
): Promise<Uint8Array> {
  const shareA = unlockShare(lockedFallbackShareA, lockBytesA);
  const shareB = unlockShare(lockedFallbackShareB, lockBytesB);
  return combineLegacySecret([shareA, shareB]);
}
