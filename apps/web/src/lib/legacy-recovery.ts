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
import { secp256k1 } from '@noble/curves/secp256k1';
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

// ── Signature-locked shares -- the hardware-wallet-compatible sibling of
// deriveLegacyLockBytes above. That function needs the raw mnemonic
// (fine for the vault-scoped setup flow, where the owner already reveals
// each key's mnemonic once to seal), but a hardware wallet never exports
// its private key at all -- it only ever produces signatures. This gives
// every keyholder a SECOND way to unlock the exact same fast-path share:
// prove key ownership with a signature instead of a raw derivation.
//
// The reserved child path is `<account path>/1/0` -- the standard BIP32
// "change, index 0" slot under whatever account-level path a key already
// uses (the same `derivationPath` stored on every LocalKey). Deliberately
// NOT a new hardened purpose field: because this step is non-hardened,
// its PUBLIC key is derivable from the account xpub alone (no private
// key needed), which is exactly what lets someone who only has an xpub
// -- not the key itself -- ask "is there a share hidden for this xpub?"
// without that lookup ever risking anything: an xpub can prove nothing
// about the corresponding private key, and a signature never exposes it
// either (that is the entire point of a signature scheme). The vault's
// own spend key already permanently occupies index /0/0 (see
// keystore.ts's deriveAccount), so /1/0 is guaranteed unused by anything
// else this app does with the same account.
export const LEGACY_IDENTITY_PATH = '1/0';

const LEGACY_SIG_TAG_PREFIX = 'dynastytrust-legacy-sig-v1';

/** The fixed, domain-separated text a keyholder signs to unlock their signature-locked share. Plain ASCII on purpose -- this has to survive being retyped by hand decades from now. */
export function legacyUnlockMessage(vaultId: string, keyRole: string): string {
  return `DynastyTrust Legacy Recovery Unlock v1\nvault: ${vaultId}\nrole: ${keyRole}`;
}

/**
 * The classic Bitcoin Signed Message digest ("\x18Bitcoin Signed
 * Message:\n" + varint(len) + message, double-SHA256) -- the same format
 * Sparrow/Electrum/Coldcard/every hardware wallet's "Sign Message"
 * feature already produces. Using this exact digest means a real
 * hardware wallet can, in principle, sign legacyUnlockMessage() directly
 * with its own UI; nothing here is DynastyTrust-specific.
 */
export function bitcoinMessageDigest(message: string): Uint8Array {
  const magic = new TextEncoder().encode('\x18Bitcoin Signed Message:\n');
  const msgBytes = new TextEncoder().encode(message);
  // Bitcoin's varint: single byte for lengths under 0xfd, which every
  // legacyUnlockMessage() text is (well under 253 bytes for any
  // realistic vaultId/keyRole).
  if (msgBytes.length >= 0xfd) {
    throw new Error(`bitcoinMessageDigest: message too long for single-byte varint (${msgBytes.length} bytes)`);
  }
  const payload = new Uint8Array(magic.length + 1 + msgBytes.length);
  payload.set(magic, 0);
  payload[magic.length] = msgBytes.length;
  payload.set(msgBytes, magic.length + 1);
  return sha256(sha256(payload));
}

/**
 * Derives the identity keypair at `<derivationPath>/1/0` from a raw
 * mnemonic. Used at seal time (the owner already has the mnemonic in
 * hand to seal) to produce the deterministic signature that locks the
 * signature-based share -- see signLegacyUnlockMessage below. A real
 * hardware wallet reproduces the same signature later using only its own
 * held key, never this function.
 */
function deriveLegacyIdentityChild(mnemonic: string, network: Network, derivationPath: string) {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed, networkVersions(network));
  const child = root.derive(derivationPath).deriveChild(1).deriveChild(0);
  if (!child.privateKey || !child.publicKey) {
    throw new Error('legacy identity derivation produced no keypair');
  }
  return { privateKey: child.privateKey, publicKey: child.publicKey };
}

/** The identity child's public key, derived from the mnemonic side at seal time -- byte-identical to legacyIdentityPubkeyFromXpub(thatKey'sXpub) by construction, since both derive the same non-hardened /1/0 child. Stored (safely -- it's public) alongside a sealed share so the retrieval page can find it later from just an xpub. */
export function legacyIdentityPubkeyFromMnemonic(mnemonic: string, network: Network, derivationPath: string): Uint8Array {
  return deriveLegacyIdentityChild(mnemonic, network, derivationPath).publicKey;
}

/**
 * HDKey.fromExtendedKey() requires the caller to name the exact version
 * bytes it expects and throws "Version mismatch" otherwise -- it does
 * NOT sniff xpub-vs-tpub from the string itself. The retrieval page has
 * no separate "which network" field (asking for one defeats the point:
 * a person 20 years from now has an xpub, not necessarily a memory of
 * which network it was for), so this tries every version set this app
 * ever mints one of (mainnet, then testnet/signet, which share version
 * bytes -- see networkVersions) and returns whichever one actually
 * parses, along with the resulting node.
 */
function parseAnyNetworkXpub(xpub: string): { account: HDKey; network: Network } {
  const candidates: Network[] = ['mainnet', 'testnet'];
  for (const network of candidates) {
    try {
      return { account: HDKey.fromExtendedKey(xpub, networkVersions(network)), network };
    } catch {
      // Try the next version set.
    }
  }
  throw new Error('Not a recognized xpub/tpub (unknown version bytes)');
}

/** Which network (mainnet, or testnet/signet -- they share version bytes) an xpub string was encoded for. Used to pick the right bech32 hrp when displaying an address for this key. */
export function detectXpubNetwork(xpub: string): Network {
  return parseAnyNetworkXpub(xpub).network;
}

/**
 * The identity child's PUBLIC key, computable from an account xpub alone
 * -- no mnemonic, no private key, ever. This is what the retrieval page
 * uses to look up a share from just an xpub.
 */
export function legacyIdentityPubkeyFromXpub(xpub: string): Uint8Array {
  const { account } = parseAnyNetworkXpub(xpub);
  const child = account.deriveChild(1).deriveChild(0);
  if (!child.publicKey) throw new Error('legacy identity derivation produced no public key');
  return child.publicKey;
}

/**
 * Signs legacyUnlockMessage(vaultId, keyRole) with the mnemonic's
 * identity child key, using ordinary deterministic ECDSA (RFC 6979 --
 * @noble/curves' default, no random nonce). Determinism is the whole
 * point: the same key signing the same message always produces the same
 * signature, so the signature itself can serve as a reproducible unlock
 * value -- unlike a BIP340 Schnorr signature, whose reference behavior
 * mixes in fresh randomness by default and would produce a DIFFERENT
 * signature (and so a different lock value) on every attempt.
 */
export function signLegacyUnlockMessage(
  mnemonic: string,
  network: Network,
  derivationPath: string,
  vaultId: string,
  keyRole: string,
): Uint8Array {
  const { privateKey } = deriveLegacyIdentityChild(mnemonic, network, derivationPath);
  const digest = bitcoinMessageDigest(legacyUnlockMessage(vaultId, keyRole));
  return secp256k1.sign(digest, privateKey).toCompactRawBytes();
}

/**
 * Verifies a signature -- however it was produced, software key or real
 * hardware wallet -- actually matches the identity pubkey it claims to,
 * over the exact legacyUnlockMessage digest. The retrieval page calls
 * this BEFORE attempting to unlock, so a wrong or garbled signature
 * fails with a clear "that signature doesn't match this key" instead of
 * a confusing decrypt/AEAD failure three steps later.
 */
export function verifyLegacyUnlockSignature(
  signature: Uint8Array,
  identityPubkey: Uint8Array,
  vaultId: string,
  keyRole: string,
): boolean {
  const digest = bitcoinMessageDigest(legacyUnlockMessage(vaultId, keyRole));
  try {
    return secp256k1.verify(signature, digest, identityPubkey);
  } catch {
    return false;
  }
}

function hexToBytesStrict(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Not valid hex');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A real hardware wallet's "Sign Message" feature -- Coldcard, Sparrow,
 * Electrum -- outputs BIP-137: base64, 65 bytes (a 1-byte recovery/
 * compression header, then the 64-byte compact r||s signature), NOT bare
 * hex. This accepts that real-world format, plus bare 64-byte hex or
 * base64 (what a deterministic software signature produces), rather than
 * forcing the recovering keyholder to hand-edit whatever their wallet
 * gave them. The header byte, when present, is discarded -- unlock only
 * needs r||s; which pubkey signed is established by the caller (a
 * lookup, or an assumed match), not by this function.
 *
 * Shared by DescriptorRetrieval.tsx (the online, app-hosted signature
 * unlock page) and the standalone offline recovery tool's signature-based
 * Fast Path -- one implementation of this parsing, not two that could
 * drift apart on which signature formats they accept.
 */
export function parseUnlockSignature(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('No signature provided');
  let bytes: Uint8Array;
  if (/^(0x)?[0-9a-fA-F]+$/.test(trimmed) && trimmed.replace(/^0x/, '').length % 2 === 0) {
    bytes = hexToBytesStrict(trimmed);
  } else {
    bytes = Uint8Array.from(atob(trimmed), c => c.charCodeAt(0));
  }
  if (bytes.length === 65) return bytes.slice(1); // strip BIP-137 header byte
  if (bytes.length === 64) return bytes;
  throw new Error(`Signature is ${bytes.length} bytes -- expected 64 (raw) or 65 (BIP-137, with header byte)`);
}

/**
 * Derives the 32-byte value that locks/unlocks the SIGNATURE-based copy
 * of a keyholder's fast-path share -- the sibling of deriveLegacyLockBytes
 * above, keyed off a signature instead of a raw key derivation. Same
 * domain separation reasoning (vaultId + keyRole), distinct tag so this
 * scheme's lock values never collide with the mnemonic-based scheme's.
 */
export function deriveLegacyLockBytesFromSignature(
  signature: Uint8Array,
  vaultId: string,
  keyRole: string,
): Uint8Array {
  const tag = new TextEncoder().encode(`${LEGACY_SIG_TAG_PREFIX}:${vaultId}:${keyRole}`);
  const input = new Uint8Array(signature.length + tag.length);
  input.set(signature, 0);
  input.set(tag, signature.length);
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

/**
 * Short, stable stamp of a vault's descriptor -- 8 bytes of SHA-256 as
 * 16 hex chars, long enough to be a real fingerprint, short enough to
 * eyeball-compare on a phone or in a printed backup. NOT a security
 * mechanism (recovery already fails safely on a mismatched secret --
 * see legacy-seal.ts's header) -- purely a label so a person can tell
 * WHICH version of a vault a sealed bundle or downloaded package
 * belongs to, decades later, without needing DynastyTrust itself to
 * still be running to check.
 *
 * 2026-08-20 (operator, thinking through a 20-year-out edge case: a
 * vault gets recompiled -- same shape, different keys -- after its
 * Legacy Recovery bundle was already sealed and an on-chain pad
 * already published; nothing told the owner the sealed data was now
 * stale, and nothing told a future finder which version they held).
 * Computed fresh from the vault's CURRENT descriptor at seal time and
 * stored alongside the bundle (vault_legacy_bundles.sealed_descriptor_hash);
 * LegacyRecoverySetup.tsx recomputes it from the vault's live
 * descriptor on every load and compares the two to warn on a stale
 * seal, and descriptor-backup.ts stamps the sealed-at value into the
 * downloadable package text.
 */
export function descriptorFingerprint(descriptor: string): string {
  const hash = sha256(new TextEncoder().encode(descriptor));
  return Array.from(hash.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
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
