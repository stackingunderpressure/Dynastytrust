/**
 * legacy-recovery.ts — long-horizon descriptor recovery, independent of
 * this app ever running again.
 *
 * The problem: a vault's descriptor has to survive decades so a surviving
 * keyholder can still craft a valid spend, without depending on a paper
 * backup surviving fire/loss or on DynastyTrust's own servers staying up.
 *
 * The mechanism -- "all you need is your key," no database, no shares to
 * combine: the whole recovery bundle (descriptor + policy) is encrypted
 * and published on-chain, per keyholder, keyed by that keyholder's own
 * deterministic signature. Nothing but a signature and the on-chain data
 * is ever needed to recover.
 *
 * Design constraints this satisfies:
 *   1. STANDARD-SHAPED, OFFSET-ACCOUNT PATH: the derivation path
 *      (m/84'/coin'/(900000+N)'/1/0) is the ordinary 5-level BIP84 shape
 *      -- hardened purpose/coin/account, unhardened change/index --
 *      exactly what any off-the-shelf hardware wallet's "Sign Message"
 *      feature already expects. An earlier design used a fully hardened
 *      4-level path (m/9999'/coin'/N'/1') for maximum unlinkability, but
 *      real message-signing firmware (confirmed against SeedSigner's
 *      source) only recognizes the standard 5-level shape and rejects a
 *      custom hardened path outright -- so the fully-hardened version
 *      couldn't actually be signed on the hardware this mechanism exists
 *      to support. Reshaping the path to standard form and forking
 *      signer firmware to accept a custom path are mutually exclusive
 *      fixes (only one path shape can be the canonical, on-chain one);
 *      depending on a patched firmware fork surviving decades is a worse
 *      fit for "works decades from now regardless of what still exists"
 *      than the large, fixed account-offset (900000) below, which keeps
 *      the account number far outside any real wallet's actively-used
 *      low account numbers (routinely exported to watch-only trackers)
 *      or typical account-level gap-limit scanning ranges -- closing the
 *      practical version of the xpub-exposure risk an unhardened
 *      change/index level otherwise reopens.
 *   2. SIGN, DON'T TYPE A SEED: recovery is "sign this fixed message,
 *      then that signature decrypts" -- a hardware wallet's ordinary
 *      "Sign Message" feature, never a raw private key or seed pasted
 *      into the recovery tool. A software/mnemonic-held key can produce
 *      the same deterministic signature locally when no hardware wallet
 *      is available.
 *   3. ONE MECHANISM: the same signature both proves key ownership AND
 *      directly derives the decryption key.
 *   4. NO ECDH: unlinkability already forces one on-chain publish PER
 *      keyholder (their hardened addresses are unlinkable from each
 *      OTHER by design, so there is no shared address multiple people
 *      could all find), so each keyholder's own deterministic signature
 *      directly derives the symmetric key for their own copy of the
 *      bundle -- no multi-recipient envelope to build.
 *   5. `vaultIndex` (0, 1, 2, ...) is this PERSON's own small sequential
 *      count of how many vaults they've published a share for -- never a
 *      vault UUID. A human can plausibly remember or just try "0, then
 *      1, then 2" decades from now; nobody is expected to remember a
 *      UUID with nothing to check it against.
 *
 * Every primitive here is a published, permanent standard -- BIP32
 * derivation, deterministic ECDSA (RFC 6979), SHA-256, AES-256-GCM -- not
 * DynastyTrust-specific math. That's deliberate: the same steps can be
 * reproduced by hand, decades from now, even if this codebase is gone.
 */

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { networkVersions, type Network } from './keystore';

// Legacy Recovery uses the standard BIP84 (native segwit) purpose field
// -- ordinary, not reserved -- so its derivation path is recognized by
// any hardware wallet's message-signing feature as a normal account, not
// a custom path. The large, fixed account-number offset below is what
// keeps this "recovery account" from colliding with a real wallet's own
// actively-used low account numbers or falling inside typical
// account-level gap-limit auto-discovery ranges -- deliberately public
// and identical for every vault, same as the old reserved-purpose
// constant it replaces: publishing the convention openly costs nothing,
// since knowing the account number alone still doesn't let anyone derive
// the resulting address without the account-level xpub or the seed.
const LEGACY_PURPOSE = "84'";
export const LEGACY_ACCOUNT_OFFSET = 900_000;

/**
 * The classic Bitcoin Signed Message digest ("\x18Bitcoin Signed
 * Message:\n" + varint(len) + message, double-SHA256) -- the same format
 * Sparrow/Electrum/Coldcard/every hardware wallet's "Sign Message"
 * feature already produces. Using this exact digest means a real
 * hardware wallet can sign legacyOnChainUnlockMessage() directly with
 * its own UI; nothing here is DynastyTrust-specific.
 */
export function bitcoinMessageDigest(message: string): Uint8Array {
  const magic = new TextEncoder().encode('\x18Bitcoin Signed Message:\n');
  const msgBytes = new TextEncoder().encode(message);
  // Bitcoin's varint: single byte for lengths under 0xfd, which every
  // legacyOnChainUnlockMessage() text is (well under 253 bytes for any
  // realistic vaultIndex).
  if (msgBytes.length >= 0xfd) {
    throw new Error(`bitcoinMessageDigest: message too long for single-byte varint (${msgBytes.length} bytes)`);
  }
  const payload = new Uint8Array(magic.length + 1 + msgBytes.length);
  payload.set(magic, 0);
  payload[magic.length] = msgBytes.length;
  payload.set(msgBytes, magic.length + 1);
  return sha256(sha256(payload));
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
 * needs r||s.
 *
 * Shared by DescriptorRetrieval.tsx and the standalone offline recovery
 * tool's "Sign to recover" tab -- one implementation of this parsing,
 * not two that could drift apart on which signature formats they accept.
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

// crypto.subtle's typings want an ArrayBuffer-backed BufferSource; bytes
// arriving from @noble/hashes are typed generically
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

/**
 * m/84'/coin'/(900000+N)'/1/0 -- N = this person's own small per-vault
 * index. Standard BIP84 5-level shape (hardened purpose/coin/account,
 * unhardened change/index) so any hardware wallet's message-signing
 * feature recognizes it as an ordinary account, not a custom path. The
 * fixed 900,000 account offset keeps it far outside any real wallet's
 * actively-used low account numbers or typical gap-limit scan range.
 * Change=1 (the internal chain) is a further, minor precaution -- it's
 * not where a normal wallet would ever show or watch a receive address.
 */
export function legacyOnChainDerivationPath(network: Network, vaultIndex: number): string {
  if (!Number.isSafeInteger(vaultIndex) || vaultIndex < 0) {
    throw new Error(`legacyOnChainDerivationPath: vaultIndex must be a non-negative whole number, got ${vaultIndex}`);
  }
  const coin = network === 'mainnet' ? '0' : '1';
  const account = LEGACY_ACCOUNT_OFFSET + vaultIndex;
  return `m/${LEGACY_PURPOSE}/${coin}'/${account}'/1/0`;
}

/** The fixed, domain-separated text a keyholder signs -- both to prove key ownership and to derive the decryption key. Plain ASCII, has to survive being retyped by hand decades from now. */
export function legacyOnChainUnlockMessage(vaultIndex: number): string {
  return `DynastyTrust Legacy Recovery v2\nvault index: ${vaultIndex}`;
}

/**
 * Derives the hardened identity keypair at legacyOnChainDerivationPath.
 * Needs the raw mnemonic (or an equivalent seed) -- this is the ONE
 * moment a software-held key needs its mnemonic for this whole mechanism;
 * a hardware wallet performs the equivalent derivation + signing
 * internally and never exposes this private key at all.
 */
export function legacyOnChainIdentity(
  mnemonic: string,
  network: Network,
  vaultIndex: number,
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed, networkVersions(network));
  const child = root.derive(legacyOnChainDerivationPath(network, vaultIndex));
  if (!child.privateKey || !child.publicKey) {
    throw new Error('legacy on-chain identity derivation produced no keypair (hardened path requires the seed, not an xpub)');
  }
  return { privateKey: child.privateKey, publicKey: child.publicKey };
}

/**
 * Signs legacyOnChainUnlockMessage(vaultIndex) with the hardened identity
 * key, using deterministic ECDSA (RFC 6979 -- @noble/curves' default, no
 * random nonce) over the classic Bitcoin-signed-message digest.
 * Determinism is the whole point: the same key signing the same message
 * always produces the same signature, so the signature itself can serve
 * as a reproducible unlock value. A real hardware wallet's "Sign Message"
 * feature reproduces the identical signature later from only its own
 * held key -- this function exists so a software-held key can do the
 * same thing without one.
 */
export function signLegacyOnChainUnlock(
  mnemonic: string,
  network: Network,
  vaultIndex: number,
): Uint8Array {
  const { privateKey } = legacyOnChainIdentity(mnemonic, network, vaultIndex);
  const digest = bitcoinMessageDigest(legacyOnChainUnlockMessage(vaultIndex));
  return secp256k1.sign(digest, privateKey).toCompactRawBytes();
}

/**
 * Verifies a signature -- however it was produced, software key or real
 * hardware wallet -- actually matches the identity pubkey it claims to,
 * over the exact legacyOnChainUnlockMessage digest. Callers should check
 * this BEFORE attempting to decrypt, so a wrong or garbled signature
 * fails with a clear "that signature doesn't match this key" instead of
 * a confusing AEAD failure three steps later.
 */
export function verifyLegacyOnChainSignature(
  signature: Uint8Array,
  identityPubkey: Uint8Array,
  vaultIndex: number,
): boolean {
  const digest = bitcoinMessageDigest(legacyOnChainUnlockMessage(vaultIndex));
  try {
    return secp256k1.verify(signature, digest, identityPubkey);
  } catch {
    return false;
  }
}

const LEGACY_ONCHAIN_KEY_TAG = 'dynastytrust-legacy-v2-key';

/**
 * Derives the 32-byte AES-256-GCM key straight from the deterministic
 * signature -- this IS the encryption key, not just a value that locks
 * some other secret. Domain-separated by vaultIndex so the same
 * signature-producing key, reused across a person's different vaults,
 * never derives the same encryption key twice.
 */
export function deriveLegacyOnChainKey(signature: Uint8Array, vaultIndex: number): Uint8Array {
  const tag = new TextEncoder().encode(`${LEGACY_ONCHAIN_KEY_TAG}:${vaultIndex}`);
  const input = new Uint8Array(signature.length + tag.length);
  input.set(signature, 0);
  input.set(tag, signature.length);
  return sha256(input);
}

/**
 * Seals a bundle for this mechanism: derive this keyholder's
 * deterministic signature, use it directly as the AES-256-GCM key
 * (reusing sealBundle as-is -- it already accepts any 32-byte key), and
 * return both the sealed bundle and the identity pubkey (safe to publish
 * -- it's what the on-chain address is derived from, and never reveals
 * the private key or the signature).
 */
export async function sealBundleOnChain(
  bundleText: string,
  mnemonic: string,
  network: Network,
  vaultIndex: number,
): Promise<{ sealed: SealedBundle; identityPubkey: Uint8Array }> {
  const { publicKey } = legacyOnChainIdentity(mnemonic, network, vaultIndex);
  const signature = signLegacyOnChainUnlock(mnemonic, network, vaultIndex);
  const key = deriveLegacyOnChainKey(signature, vaultIndex);
  const sealed = await sealBundle(bundleText, key);
  return { sealed, identityPubkey: publicKey };
}

/**
 * Recovers a sealed bundle given the keyholder's signature (however it
 * was produced) and the sealed bundle found on-chain. Callers should
 * call verifyLegacyOnChainSignature first for a clear error on a wrong
 * signature rather than a confusing AEAD failure here.
 */
export async function recoverViaOnChainPath(
  signature: Uint8Array,
  vaultIndex: number,
  sealed: SealedBundle,
): Promise<string> {
  const key = deriveLegacyOnChainKey(signature, vaultIndex);
  return unsealBundle(sealed, key);
}

// ── On-chain payload framing -- what actually gets published in the
// OP_RETURN output. A fixed magic + version header lets a scanner walking
// a list of transactions at the keyholder's own hardened address cheaply
// recognize "this might be a Legacy Recovery payload" and skip anything
// that isn't (someone else's data, a stray transaction, junk sent to the
// address once it's public -- an address becomes visible, though never
// derivable by anyone else, the moment it's first used) before ever
// attempting an AES-GCM decrypt.

const ONCHAIN_PAYLOAD_MAGIC = new Uint8Array([0x44, 0x54, 0x4c, 0x32]); // ASCII "DTL2"
const ONCHAIN_PAYLOAD_VERSION = 1;
const ONCHAIN_NONCE_LENGTH = 12; // matches sealBundle's fixed AES-GCM nonce length

/** Packs a sealed bundle into the exact bytes published on-chain: magic + version + nonce + ciphertext. */
export function encodeOnChainPayload(sealed: SealedBundle): Uint8Array {
  const nonce = unb64(sealed.nonceB64);
  const ciphertext = unb64(sealed.ciphertextB64);
  if (nonce.length !== ONCHAIN_NONCE_LENGTH) {
    throw new Error(`encodeOnChainPayload: expected a ${ONCHAIN_NONCE_LENGTH}-byte nonce, got ${nonce.length}`);
  }
  const out = new Uint8Array(ONCHAIN_PAYLOAD_MAGIC.length + 1 + nonce.length + ciphertext.length);
  let offset = 0;
  out.set(ONCHAIN_PAYLOAD_MAGIC, offset);
  offset += ONCHAIN_PAYLOAD_MAGIC.length;
  out[offset] = ONCHAIN_PAYLOAD_VERSION;
  offset += 1;
  out.set(nonce, offset);
  offset += nonce.length;
  out.set(ciphertext, offset);
  return out;
}

/**
 * Inverse of encodeOnChainPayload. Returns null -- never throws -- for
 * anything that doesn't match the expected header exactly, so a scanner
 * can cleanly skip every non-matching payload found at an address
 * instead of treating a mismatch as an error.
 */
export function decodeOnChainPayload(bytes: Uint8Array): SealedBundle | null {
  const headerLen = ONCHAIN_PAYLOAD_MAGIC.length + 1 + ONCHAIN_NONCE_LENGTH;
  if (bytes.length <= headerLen) return null;
  for (let i = 0; i < ONCHAIN_PAYLOAD_MAGIC.length; i++) {
    if (bytes[i] !== ONCHAIN_PAYLOAD_MAGIC[i]) return null;
  }
  if (bytes[ONCHAIN_PAYLOAD_MAGIC.length] !== ONCHAIN_PAYLOAD_VERSION) return null;
  const nonce = bytes.slice(ONCHAIN_PAYLOAD_MAGIC.length + 1, headerLen);
  const ciphertext = bytes.slice(headerLen);
  return { version: 1, nonceB64: b64(nonce), ciphertextB64: b64(ciphertext) };
}
