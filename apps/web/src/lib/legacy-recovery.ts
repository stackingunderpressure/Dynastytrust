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
 *   1. STANDARD-SHAPED, FIXED-ACCOUNT PATH: the derivation path
 *      (m/84'/coin'/900000'/1/0) is the ordinary 5-level BIP84 shape --
 *      hardened purpose/coin/account, unhardened change/index -- exactly
 *      what any off-the-shelf hardware wallet's "Sign Message" feature
 *      already expects. An earlier design used a fully hardened 4-level
 *      path (m/9999'/coin'/N'/1') for maximum unlinkability, but real
 *      message-signing firmware (confirmed against SeedSigner's source)
 *      only recognizes the standard 5-level shape and rejects a custom
 *      hardened path outright -- so the fully-hardened version couldn't
 *      actually be signed on the hardware this mechanism exists to
 *      support. The account number (900000) is fixed, not offset by a
 *      per-vault index -- see point 5 below for why -- and stays far
 *      outside any real wallet's actively-used low account numbers
 *      (routinely exported to watch-only trackers) or typical
 *      account-level gap-limit scanning ranges, closing the practical
 *      version of the xpub-exposure risk an unhardened change/index
 *      level otherwise reopens.
 *   2. SIGN A NONCE, NOT A REMEMBERED SENTENCE: recovery needs nothing
 *      memorized or hand-transcribed at all. The thing that gets signed
 *      is the random 12-byte AES-GCM nonce that's already published in
 *      plain sight as part of the on-chain payload (right before the
 *      ciphertext -- see the payload framing below), not a fixed
 *      sentence the recovering keyholder has to reconstruct correctly
 *      from memory. At recovery time you read the nonce straight off
 *      the transaction you already found and sign THAT -- there is
 *      nothing to get wrong. This also answers the obvious follow-up,
 *      "why not just sign the whole OP_RETURN": the ciphertext is the
 *      OUTPUT of encrypting with the key that signing produces, so at
 *      sealing time the ciphertext (and therefore the full OP_RETURN)
 *      doesn't exist yet -- nothing that depends on it can be the thing
 *      you sign to derive it. The nonce is chosen before encryption, so
 *      it's the one piece of the eventual payload that's actually
 *      available to sign up front, at both sealing and recovery time.
 *   3. ONE MECHANISM: the same signature both proves key ownership AND
 *      directly derives the decryption key.
 *   4. NO ECDH: unlinkability already forces one on-chain publish PER
 *      keyholder (their hardened addresses are unlinkable from each
 *      OTHER by design, so there is no shared address multiple people
 *      could all find), so each keyholder's own deterministic signature
 *      directly derives the symmetric key for their own copy of the
 *      bundle -- no multi-recipient envelope to build.
 *   5. NO VAULT INDEX: the derivation path and the AES key's domain tag
 *      are both fixed, single constants per seed -- there is no per-
 *      vault index number to enter, remember, or get wrong at recovery
 *      time. Operator's call: the overwhelming common case is one
 *      recovery key doing one job for one vault, and the mechanism is
 *      optimized against user error in a last-resort, decades-later
 *      recovery scenario, not against the rare case of the SAME seed
 *      being reused to publish Legacy Recovery for a SECOND, different
 *      vault. That rare case still degrades gracefully rather than
 *      breaking silently: both publishes land at the same address as
 *      separate on-chain transactions, and each one's own nonce still
 *      only unlocks its own ciphertext (nonce -> signature -> key is a
 *      1:1 chain), so nothing decrypts to the wrong vault's data --
 *      recovery just needs to know which transaction it wants, the same
 *      way it already has to disambiguate a re-sealed vault's older vs.
 *      newer publish.
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
import { networkVersions, normalizeXpub, type Network } from './keystore';

// Legacy Recovery uses the standard BIP84 (native segwit) purpose field
// -- ordinary, not reserved -- so its derivation path is recognized by
// any hardware wallet's message-signing feature as a normal account, not
// a custom path. The large, fixed account number below is what keeps
// this "recovery account" from colliding with a real wallet's own
// actively-used low account numbers or falling inside typical
// account-level gap-limit auto-discovery ranges -- deliberately public
// and identical for every vault: publishing the convention openly costs
// nothing, since knowing the account number alone still doesn't let
// anyone derive the resulting address without the account-level xpub or
// the seed. Fixed, not offset by a vault index -- see the header's point
// 5 for why there is no per-vault index at all any more.
const LEGACY_PURPOSE = "84'";
export const LEGACY_ACCOUNT_NUMBER = 900_000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The classic Bitcoin Signed Message digest ("\x18Bitcoin Signed
 * Message:\n" + varint(len) + message, double-SHA256) -- the same format
 * Sparrow/Electrum/Coldcard/every hardware wallet's "Sign Message"
 * feature already produces. Using this exact digest means a real
 * hardware wallet can sign legacyOnChainNonceMessage() directly with
 * its own UI; nothing here is DynastyTrust-specific.
 */
export function bitcoinMessageDigest(message: string): Uint8Array {
  const magic = new TextEncoder().encode('\x18Bitcoin Signed Message:\n');
  const msgBytes = new TextEncoder().encode(message);
  // Bitcoin's varint: single byte for lengths under 0xfd, which every
  // legacyOnChainNonceMessage() text is (well under 253 bytes -- a fixed
  // prefix plus a 12-byte nonce as 24 hex characters).
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

/**
 * secret is the AES-256-GCM key. nonce defaults to a fresh random value
 * (the ordinary case), but the on-chain mechanism below needs to choose
 * the nonce FIRST -- before the key even exists -- so it can sign that
 * nonce to derive the key; passing one in explicitly makes that possible
 * without a second encryption implementation.
 */
export async function sealBundle(
  bundleText: string,
  secret: Uint8Array,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(12)),
): Promise<SealedBundle> {
  const key = await crypto.subtle.importKey('raw', asBufferSource(secret), 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(nonce) }, key, new TextEncoder().encode(bundleText));
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
 * m/84'/coin'/900000'/1/0 -- one fixed path, the same for every vault
 * this seed ever publishes Legacy Recovery for. Standard BIP84 5-level
 * shape (hardened purpose/coin/account, unhardened change/index) so any
 * hardware wallet's message-signing feature recognizes it as an ordinary
 * account, not a custom path. The fixed 900,000 account number keeps it
 * far outside any real wallet's actively-used low account numbers or
 * typical gap-limit scan range. Change=1 (the internal chain) is a
 * further, minor precaution -- it's not where a normal wallet would ever
 * show or watch a receive address.
 */
export function legacyOnChainDerivationPath(network: Network): string {
  const coin = network === 'mainnet' ? '0' : '1';
  return `m/${LEGACY_PURPOSE}/${coin}'/${LEGACY_ACCOUNT_NUMBER}'/1/0`;
}

/**
 * The fixed-prefix, nonce-specific text a keyholder signs -- both to
 * prove key ownership and to derive the decryption key. There is
 * nothing here to memorize: the nonce is read straight off the on-chain
 * transaction (it's published in plain sight, right before the
 * ciphertext), never composed or recalled by a person.
 */
export function legacyOnChainNonceMessage(nonce: Uint8Array): string {
  return `DynastyTrust Legacy Recovery v2\nnonce: ${bytesToHex(nonce)}`;
}

/**
 * Derives the identity PUBLIC key at legacyOnChainDerivationPath from an
 * account-level xpub, with no seed or mnemonic at all. The account level
 * (m/84'/coin'/900000') is hardened, but the remaining /1/0 levels are
 * plain unhardened BIP32 child derivation -- so any xpub exported AT
 * that exact account (a hardware wallet's ordinary "export xpub for a
 * custom path" feature, the same kind of export this app already uses
 * to import a vault-signing key -- see keystore.ts's importXpub) extends
 * to the identical child pubkey a hardware wallet's "Sign Message"
 * feature signs against internally. This is deliberately a SEPARATE
 * export from the vault's own signing xpub: the vault key's xpub lives
 * at the vault's own hardened path (e.g. m/48'/coin'/0'/2'), and hardened
 * derivation can't jump from there to m/84'/coin'/900000' without the
 * seed -- so a hardware-only keyholder (private key never leaves the
 * device, never mind this browser) needs to export this one specific
 * account separately, once, to seal a Legacy Recovery share at all.
 */
export function legacyOnChainIdentityFromXpub(
  accountXpub: string,
  network: Network,
): { publicKey: Uint8Array } {
  // Accepts any SLIP-132-prefixed form (zpub, Zpub, ypub, ...), not just
  // plain xpub/tpub -- a hardware wallet's export screen commonly labels
  // the script type in the prefix (confirmed live against a real
  // SeedSigner "Zpub" export, 2026-08-22, which HDKey.fromExtendedKey
  // otherwise rejects outright as a version mismatch).
  const hd = HDKey.fromExtendedKey(normalizeXpub(accountXpub, network), networkVersions(network));
  const child = hd.deriveChild(1).deriveChild(0);
  if (!child.publicKey) {
    throw new Error('Could not derive a public key from that xpub -- check it is a real extended public key for the right network.');
  }
  return { publicKey: child.publicKey };
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
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed, networkVersions(network));
  const child = root.derive(legacyOnChainDerivationPath(network));
  if (!child.privateKey || !child.publicKey) {
    throw new Error('legacy on-chain identity derivation produced no keypair (hardened path requires the seed, not an xpub)');
  }
  return { privateKey: child.privateKey, publicKey: child.publicKey };
}

/**
 * Signs legacyOnChainNonceMessage(nonce) with the hardened identity key,
 * using deterministic ECDSA (RFC 6979 -- @noble/curves' default, no
 * random nonce) over the classic Bitcoin-signed-message digest.
 * Determinism is the whole point: the same key signing the same message
 * always produces the same signature, so the signature itself can serve
 * as a reproducible unlock value. A real hardware wallet's "Sign Message"
 * feature reproduces the identical signature later from only its own
 * held key -- this function exists so a software-held key can do the
 * same thing without one.
 */
export function signLegacyOnChainNonce(
  mnemonic: string,
  network: Network,
  nonce: Uint8Array,
): Uint8Array {
  const { privateKey } = legacyOnChainIdentity(mnemonic, network);
  const digest = bitcoinMessageDigest(legacyOnChainNonceMessage(nonce));
  return secp256k1.sign(digest, privateKey).toCompactRawBytes();
}

/**
 * Verifies a signature -- however it was produced, software key or real
 * hardware wallet -- actually matches the identity pubkey it claims to,
 * over the exact legacyOnChainNonceMessage digest for this nonce.
 * Callers should check this BEFORE attempting to decrypt, so a wrong or
 * garbled signature fails with a clear "that signature doesn't match
 * this key" instead of a confusing AEAD failure three steps later.
 */
export function verifyLegacyOnChainNonceSignature(
  signature: Uint8Array,
  identityPubkey: Uint8Array,
  nonce: Uint8Array,
): boolean {
  const digest = bitcoinMessageDigest(legacyOnChainNonceMessage(nonce));
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
 * some other secret. The signature is already unique per seal (it's over
 * a fresh random nonce each time), so no further per-vault domain
 * separation is needed here -- the fixed tag exists only so this
 * specific derived value can never collide with some other, unrelated
 * use of the same signature.
 */
export function deriveLegacyOnChainKey(signature: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode(LEGACY_ONCHAIN_KEY_TAG);
  const input = new Uint8Array(signature.length + tag.length);
  input.set(signature, 0);
  input.set(tag, signature.length);
  return sha256(input);
}

/**
 * Seals a bundle for this mechanism: pick a fresh random nonce FIRST,
 * sign that nonce with this keyholder's deterministic identity key, use
 * the resulting signature directly as the AES-256-GCM key, then encrypt
 * with that exact key and nonce. The order matters -- the nonce has to
 * exist before the key does, and the key has to exist before the
 * ciphertext does, which is exactly why the nonce (not the ciphertext,
 * not the whole eventual OP_RETURN) is the thing that gets signed.
 * Returns the sealed bundle and the identity pubkey (safe to publish --
 * it's what the on-chain address is derived from, and never reveals the
 * private key or the signature).
 */
export async function sealBundleOnChain(
  bundleText: string,
  mnemonic: string,
  network: Network,
): Promise<{ sealed: SealedBundle; identityPubkey: Uint8Array }> {
  const { publicKey } = legacyOnChainIdentity(mnemonic, network);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const signature = signLegacyOnChainNonce(mnemonic, network, nonce);
  const key = deriveLegacyOnChainKey(signature);
  const sealed = await sealBundle(bundleText, key, nonce);
  return { sealed, identityPubkey: publicKey };
}

/**
 * Seals a bundle using a signature produced OUTSIDE this browser -- a
 * hardware wallet's own "Sign Message" feature, signing
 * legacyOnChainNonceMessage(nonce) at legacyOnChainDerivationPath.
 * Symmetric to sealBundleOnChain, but takes the nonce and signature as
 * plain inputs instead of a mnemonic, so the private key never has to
 * exist in this browser at all -- the caller already generated the
 * nonce (to build the message the hardware wallet signed) and should
 * already have checked verifyLegacyOnChainNonceSignature against the
 * claimed identity pubkey before calling this; this function does not
 * re-check that, it only derives the key and encrypts.
 */
export async function sealBundleOnChainExternal(
  bundleText: string,
  nonce: Uint8Array,
  signature: Uint8Array,
): Promise<SealedBundle> {
  const key = deriveLegacyOnChainKey(signature);
  return sealBundle(bundleText, key, nonce);
}

/**
 * Recovers a sealed bundle given the keyholder's signature over that
 * SAME sealed bundle's own nonce (however the signature was produced)
 * and the sealed bundle found on-chain. Callers should call
 * verifyLegacyOnChainNonceSignature first, against sealed's nonce, for a
 * clear error on a wrong signature rather than a confusing AEAD failure
 * here.
 */
export async function recoverViaOnChainPath(
  signature: Uint8Array,
  sealed: SealedBundle,
): Promise<string> {
  const key = deriveLegacyOnChainKey(signature);
  return unsealBundle(sealed, key);
}

// ── On-chain payload framing -- what actually gets published in the
// OP_RETURN output: the nonce (a fixed 12 bytes -- AES-GCM's own nonce
// length, a property of the cipher itself, not something this app
// invented), immediately followed by the ciphertext. Nothing else --
// deliberately no magic bytes and no version number. An earlier version
// of this framing led with a 4-byte magic tag and a version byte so a
// scanner could cheaply recognize "this might be ours" before attempting
// a decrypt; operator, working through what has to be gotten right by
// hand 20 years from now: "I just feel like the first half of the blob
// is too complex to get right ... not take three parts flour and two
// parts flubber and mix it for 88 mph." Correct call -- AES-GCM's own
// authentication tag already answers "is this ours" exactly as reliably
// as a magic-number check would (a decrypt that doesn't authenticate
// fails cleanly, the same way a wrong password fails; see
// extractOnChainCandidates' comment for how that plays out when a
// scanner finds unrelated junk at a now-public address), and a version
// byte that will say "1" forever added a byte-offset to get right for
// zero real benefit. Twenty years from now the whole recipe is: the
// first 12 bytes are what to sign, everything after is what decrypts --
// no format spec, no header to check, just counting to twelve.
const ONCHAIN_NONCE_LENGTH = 12;

/** Packs a sealed bundle into the exact bytes published on-chain: the nonce, then the ciphertext. */
export function encodeOnChainPayload(sealed: SealedBundle): Uint8Array {
  const nonce = unb64(sealed.nonceB64);
  const ciphertext = unb64(sealed.ciphertextB64);
  if (nonce.length !== ONCHAIN_NONCE_LENGTH) {
    throw new Error(`encodeOnChainPayload: expected a ${ONCHAIN_NONCE_LENGTH}-byte nonce, got ${nonce.length}`);
  }
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

/**
 * Inverse of encodeOnChainPayload: the first 12 bytes are the nonce,
 * everything after is the ciphertext. Returns null -- never throws --
 * for anything too short to even hold a bare nonce, so a scanner can
 * cleanly skip an obviously-unrelated OP_RETURN output. With no magic
 * bytes to check, this will happily parse OTHER junk sent to a now-public
 * address as a structurally-valid-looking candidate too -- that is
 * expected and harmless, not a gap: attempting to actually recover it
 * derives the wrong key and AES-GCM's own authentication tag rejects it
 * during decrypt (recoverViaOnChainPath throws), exactly the same
 * "wrong signature, or not ours" failure a real wrong candidate already
 * produces today. The tag is the check; this function is just framing.
 */
export function decodeOnChainPayload(bytes: Uint8Array): SealedBundle | null {
  if (bytes.length <= ONCHAIN_NONCE_LENGTH) return null;
  const nonce = bytes.slice(0, ONCHAIN_NONCE_LENGTH);
  const ciphertext = bytes.slice(ONCHAIN_NONCE_LENGTH);
  return { version: 1, nonceB64: b64(nonce), ciphertextB64: b64(ciphertext) };
}
