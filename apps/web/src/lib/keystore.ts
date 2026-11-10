/**
 * keystore.ts — Browser-side software key manager
 *
 * Two modes:
 *
 * TEST MODE (default for testing):
 *   - No password required
 *   - Mnemonic stored in plaintext in localStorage
 *   - Instant generation — no backup flow needed
 *   - Keys marked with testMnemonic field and backedUp: false
 *   - Easy to view/copy mnemonic at any time
 *
 * SECURE MODE (for real funds):
 *   - AES-256-GCM encrypted mnemonic via PBKDF2 (210k rounds)
 *   - Mandatory backup verify flow
 *   - Private material never in plaintext after generation
 *
 * Production upgrade: swap localStorage for WebAuthn PRF or Secure Enclave.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { base58check } from '@scure/base';
import { webauthnPrf, type PrfProvider } from './passkey';

const STORE_KEY = 'dynastytrust:keyring:v1';

//

// Bitcoin Core treats signet and testnet as the same coin_type (1)
// with identical xpub/xprv version bytes. Only the chain genesis
// and peer network differ. For addresses + keys they're equivalent
// on our side; the signet/testnet distinction is only meaningful
// when talking to mempool.space or broadcasting.
export type Network   = 'testnet' | 'signet' | 'mainnet';
export type KeyOrigin = 'software' | 'imported_xpub' | 'tapit';
export type KeyStatus = 'active' | 'archived' | 'compromised';

export interface EncryptedBlob {
  version: 1;
  saltB64: string;
  nonceB64: string;
  ciphertextB64: string;
}

export interface PasskeyBlob {
  version: 1;
  credentialIdB64: string;
  prfSaltB64: string;
  nonceB64: string;
  ciphertextB64: string;
}

export interface LocalKey {
  keyId: string;
  label: string;
  persona: string;
  origin: KeyOrigin;
  network: Network;
  fingerprint: string;
  derivationPath: string;
  xpub: string;
  pubkey: string;
  status: KeyStatus;
  createdAt: string;
  /** Secure mode: AES-256-GCM encrypted mnemonic */
  encryptedMnemonic?: EncryptedBlob;
  /** Test mode: plaintext mnemonic — never use for real funds */
  testMnemonic?: string;
  /** Passkey mode: mnemonic encrypted under a secret only this device's
   *  passkey can produce (WebAuthn PRF). Replaces the password. */
  passkeyMnemonic?: PasskeyBlob;
  /** Master key fingerprint (root BIP32 key, first 4 bytes) — used in descriptors */
  masterFingerprint?: string;
  /** Whether backup verify has been completed */
  backedUp: boolean;
  /**
   * origin: 'tapit' only. The real BIP340 x-only pubkey (32 bytes, 64
   * hex chars) as Tapit Wallet reported it -- kept verbatim for display
   * and for matching a future signed PSBT back to this key. `pubkey`
   * above stores the LIFTED compressed form ('02' + this value) so the
   * rest of this file's/the compiler's 66-char-hex assumptions keep
   * working unmodified; see importTapitPubkey's doc comment for why
   * that lift is standard, not a hack.
   */
  tapitXOnlyPubkey?: string;
}

export interface KeyCreateResult {
  key: LocalKey;
  mnemonic: string;
}

//

export const DEFAULT_PERSONAS = [
  'Founder 1', 'Founder 2', 'Founder 3',
  'Heir 1', 'Heir 2', 'Trustee',
];

//

function loadAll(): LocalKey[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as LocalKey[]) : [];
  } catch { return []; }
}

function saveAll(keys: LocalKey[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(keys));
}

//

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' },
    raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function b64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

export async function encryptText(text: string, password: string): Promise<EncryptedBlob> {
  const salt  = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key   = await deriveKey(password, salt);
  const ct    = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(text),
  );
  return { version: 1, saltB64: b64(salt), nonceB64: b64(nonce), ciphertextB64: b64(new Uint8Array(ct)) };
}

export async function decryptBlob(blob: EncryptedBlob, password: string): Promise<string> {
  const key   = await deriveKey(password, unb64(blob.saltB64));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.nonceB64) }, key, unb64(blob.ciphertextB64),
  );
  return new TextDecoder().decode(plain);
}

// -- Passkey-wrapped mnemonics -------------------------------------------
//
// The 32-byte PRF secret is stretched with HKDF-SHA256 (fixed info
// string, so the secret is never used as an AES key directly and a
// future second use of the same passkey can pick a different info) into
// an AES-256-GCM key. No password, no PBKDF2: the entropy is the
// authenticator's, not a human's.

const PASSKEY_INFO = new TextEncoder().encode('dynastytrust-passkey-mnemonic-v1');

async function keyFromPrfSecret(secret: Uint8Array): Promise<CryptoKey> {
  if (secret.length !== 32) throw new Error('Passkey secret must be 32 bytes');
  const raw = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: PASSKEY_INFO },
    raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function encryptWithPrfSecret(
  text: string, secret: Uint8Array, credentialIdB64: string, prfSaltB64: string,
): Promise<PasskeyBlob> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromPrfSecret(secret);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(text));
  return { version: 1, credentialIdB64, prfSaltB64, nonceB64: b64(nonce), ciphertextB64: b64(new Uint8Array(ct)) };
}

export async function decryptWithPrfSecret(blob: PasskeyBlob, secret: Uint8Array): Promise<string> {
  const key = await keyFromPrfSecret(secret);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.nonceB64) as BufferSource }, key, unb64(blob.ciphertextB64) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** Does signing with this key need a typed password? (Test keys and
 *  passkey keys do not; the passkey prompt is the device's own.) */
export function keyNeedsPassword(key: LocalKey): boolean {
  return key.origin === 'software' && !key.testMnemonic && !key.passkeyMnemonic && !!key.encryptedMnemonic;
}

//

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function multisigPath(network: Network): string {
  const coin = network === 'mainnet' ? '0' : '1';
  return `m/48'/${coin}'/0'/2'`;
}

// BIP32 fingerprint = first 4 bytes of HASH160(pubkey). Nunchuk and
// every hardware wallet use this exact definition; matching them is
// required for the key-origin form `[fingerprint/path]xpub/0/*` to
// route signing requests to the right device.
function bip32Fingerprint(pub: Uint8Array): string {
  return toHex(ripemd160(sha256(pub)).subarray(0, 4));
}

export function networkVersions(network: Network) {
  return network === 'mainnet'
    ? { private: 0x0488_ade4, public: 0x0488_b21e }
    : { private: 0x0435_8394, public: 0x0435_87cf };
}

// SLIP-132 (https://github.com/satoshilabs/slips/blob/master/slip-0132.md)
// extended-public-key version-byte prefixes. A hardware wallet's "export
// xpub" screen often labels the script type in the prefix (zpub for a
// BIP84 single-sig account, Zpub for the P2WSH multisig equivalent, and
// so on) instead of the plain BIP32 default (xpub/tpub) -- the encoded
// key data underneath (depth, parent fingerprint, child number, chain
// code, public key) is byte-identical across every prefix; only these 4
// leading version bytes differ. HDKey.fromExtendedKey validates the
// encoded version bytes strictly against whatever is passed in, so an
// alternate-prefixed string throws a version-mismatch error there unless
// normalized to the plain xpub/tpub bytes first -- confirmed live against
// a real SeedSigner "Zpub" export (2026-08-22).
const SLIP132_PUBLIC_VERSIONS = new Set([
  0x0488_b21e, // xpub -- mainnet, BIP32 default / BIP44
  0x049d_7cb2, // ypub -- mainnet, BIP49 P2SH-P2WPKH single-sig
  0x0295_b43f, // Ypub -- mainnet, P2WSH-P2SH multisig
  0x04b2_4746, // zpub -- mainnet, BIP84 P2WPKH single-sig
  0x02aa_7ed3, // Zpub -- mainnet, P2WSH multisig
  0x0435_87cf, // tpub -- testnet/signet, BIP32 default / BIP44
  0x044a_5262, // upub -- testnet/signet, BIP49 P2SH-P2WPKH single-sig
  0x0242_89ef, // Upub -- testnet/signet, P2WSH-P2SH multisig
  0x045f_1cf6, // vpub -- testnet/signet, BIP84 P2WPKH single-sig
  0x0257_5483, // Vpub -- testnet/signet, P2WSH multisig
]);

const xpubBase58check = base58check(sha256);

/**
 * Re-encodes any SLIP-132-prefixed extended public key (zpub, Zpub,
 * ypub, Ypub, vpub, Vpub, upub, Upub -- whatever a hardware wallet's
 * export screen labeled the script type as) to the plain xpub/tpub form
 * HDKey.fromExtendedKey expects for the given network. Purely notational
 * -- the underlying key data never changes, only the 4 leading version
 * bytes. Already-standard xpub/tpub input round-trips unchanged. Throws
 * a clear error on anything that isn't a recognized extended PUBLIC key
 * (wrong length, or an xprv/tprv private key pasted here by mistake --
 * those use a disjoint set of version bytes, never mistaken for public
 * ones).
 */
export function normalizeXpub(extendedKey: string, network: Network): string {
  const trimmed = extendedKey.trim();
  const raw = xpubBase58check.decode(trimmed);
  if (raw.length !== 78) {
    throw new Error(`That doesn't look like a valid extended key (expected 78 bytes, got ${raw.length}).`);
  }
  const version = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
  if (!SLIP132_PUBLIC_VERSIONS.has(version)) {
    throw new Error('That extended key isn\'t a recognized public key (xpub/ypub/zpub/tpub/upub/vpub, or their multisig capital-letter forms) -- check it isn\'t a private key (xprv/...) pasted by mistake.');
  }
  const targetVersion = networkVersions(network).public;
  const normalized = Uint8Array.from(raw);
  normalized[0] = (targetVersion >>> 24) & 0xff;
  normalized[1] = (targetVersion >>> 16) & 0xff;
  normalized[2] = (targetVersion >>> 8) & 0xff;
  normalized[3] = targetVersion & 0xff;
  return xpubBase58check.encode(normalized);
}

function deriveAccount(mnemonic: string, network: Network) {
  const seed    = mnemonicToSeedSync(mnemonic);
  const root    = HDKey.fromMasterSeed(seed, networkVersions(network));
  const path    = multisigPath(network);
  const account = root.derive(path);
  // First receive-chain child: xpub/0/0. This is the pubkey that
  // appears in the miniscript leaf at index 0, so the compiler's
  // address and the upgraded `[fp/path]xpub/0/*` descriptor's first
  // address coincide. Without this, Nunchuk import would show an
  // empty balance at the address our app just funded.
  // NB: HDKey.derive() requires an absolute path (m/...); relative
  // descent goes through deriveChild().
  const child00 = account.deriveChild(0).deriveChild(0);
  if (
    !account.privateKey ||
    !account.publicKey ||
    !account.publicExtendedKey ||
    !child00.publicKey ||
    !root.publicKey
  ) {
    throw new Error('Key derivation failed');
  }
  // Standard BIP32 fingerprint over the root pubkey.
  const masterFingerprint = bip32Fingerprint(root.publicKey);
  return { account, child00, path, masterFingerprint };
}

//

export function listKeys(persona?: string): LocalKey[] {
  const all = loadAll();
  return persona ? all.filter(k => k.persona === persona) : all;
}

export function getKey(keyId: string): LocalKey | null {
  return loadAll().find(k => k.keyId === keyId) ?? null;
}

/**
 * QUICK TEST KEY — no password, mnemonic stored in plaintext.
 * Instant generation. Good for testing multisig flows.
 * NOT for real funds.
 */
/**
 * Test-mode keys keep their mnemonic in PLAIN TEXT in localStorage: any
 * script that can read this origin's storage holds the seed outright.
 * That is acceptable on signet/testnet, where the coins are worthless,
 * and never on mainnet. This is the one rule, stated once; the three
 * places a plaintext mainnet seed could come to exist or be used
 * (generateTestKey, removeKeyPassword, revealMnemonic) all call it.
 * Secure-mode keys (password-encrypted) and hardware keys are unaffected.
 */
export function testModeBlockedReason(network: Network): string | null {
  return network === 'mainnet'
    ? 'Test-mode keys (no password, mnemonic stored in plain text) are not allowed on mainnet. Use a password-protected key or a hardware wallet.'
    : null;
}

/** Why this key may not sign right now, or null if it may. Used by the
 *  signer pickers so a blocked key is explained, not silently missing. */
export function keySigningBlockedReason(key: LocalKey): string | null {
  if (key.origin === 'software' && key.testMnemonic && key.network === 'mainnet') {
    return 'This key holds its mnemonic in plain text and may not sign on mainnet. Open Keys and add a password to it first.';
  }
  return null;
}

export function generateTestKey(opts: {
  label: string;
  network: Network;
  persona: string;
}): KeyCreateResult {
  const blocked = testModeBlockedReason(opts.network);
  if (blocked) throw new Error(blocked);
  const mnemonic = generateMnemonic(wordlist, 256);
  const { account, child00, path, masterFingerprint } = deriveAccount(mnemonic, opts.network);

  const key: LocalKey = {
    keyId:             crypto.randomUUID(),
    label:             opts.label,
    persona:           opts.persona,
    origin:            'software',
    network:           opts.network,
    fingerprint:       bip32Fingerprint(account.publicKey!),
    masterFingerprint,
    derivationPath:    path,
    xpub:              account.publicExtendedKey,
    pubkey:            toHex(child00.publicKey!),
    status:            'active',
    createdAt:         new Date().toISOString(),
    testMnemonic:      mnemonic,
    backedUp:          false,
  };

  const all = loadAll();
  all.push(key);
  saveAll(all);
  return { key, mnemonic };
}

/**
 * SECURE KEY — AES-256-GCM encrypted mnemonic, password required.
 * Use for real funds. Requires backup verify to mark backedUp: true.
 */
export async function generateSoftwareKey(opts: {
  label: string;
  network: Network;
  password: string;
  persona: string;
}): Promise<KeyCreateResult> {
  const mnemonic = generateMnemonic(wordlist, 256);
  const { account, child00, path, masterFingerprint } = deriveAccount(mnemonic, opts.network);
  const encryptedMnemonic = await encryptText(mnemonic, opts.password);

  const key: LocalKey = {
    keyId:             crypto.randomUUID(),
    label:             opts.label,
    persona:           opts.persona,
    origin:            'software',
    network:           opts.network,
    fingerprint:       bip32Fingerprint(account.publicKey!),
    masterFingerprint,
    derivationPath:    path,
    xpub:              account.publicExtendedKey,
    pubkey:            toHex(child00.publicKey!),
    status:            'active',
    createdAt:         new Date().toISOString(),
    encryptedMnemonic,
    backedUp:          false,
  };

  const all = loadAll();
  all.push(key);
  saveAll(all);
  return { key, mnemonic };
}

/**
 * Import an xpub from a hardware wallet.
 *
 * `masterFingerprint`, when the caller has one (from scanning or pasting
 * a real `[fingerprint/path]xpub...` key-origin string -- see
 * parseXpubText), is the ONLY trustworthy source of the master fingerprint
 * a hardware wallet needs to recognize its own key (buildKeyOrigins /
 * buildPsbtKeyOrigins prefer it over `fingerprint` below). A bare xpub
 * carries no information about its own ancestors, so there is no way to
 * derive the true master fingerprint from the xpub alone -- 2026-08-11
 * fix: this function used to try anyway (computing the fingerprint of the
 * xpub's OWN key, an account-level value, not the master's) and silently
 * mislabel it as correct. When the caller has no real fingerprint, this
 * key simply won't get hardware-wallet key-origin metadata attached at
 * spend time, same graceful degradation buildPsbtKeyOrigins already
 * applies to any key missing derivation data.
 */
export function importXpub(opts: {
  label: string;
  network: Network;
  xpub: string;
  derivationPath?: string;
  persona: string;
  masterFingerprint?: string;
}): LocalKey {
  // A hardware wallet's "export xpub" screen often prefixes the result
  // with a SLIP-132 script-type hint (zpub, Zpub, ypub, ...) instead of
  // the plain BIP32 default -- normalizeXpub converts any of those to
  // plain xpub/tpub (same key data, only the 4 version bytes change)
  // before anything downstream ever sees it. Previously this function's
  // own prefix check only accepted xpub/tpub/Xpub/Ypub -- rejecting a
  // real zpub/Zpub/etc. outright -- and even a prefix that slipped past
  // that check would then fail HDKey.fromExtendedKey's stricter version
  // check below, silently landing on an empty pubkey that breaks vault
  // compilation later. Stores the NORMALIZED xpub, not the as-typed
  // string -- an output descriptor's script type is already carried by
  // its outer function (wpkh(...)/wsh(...)), never by the xpub prefix,
  // so standard xpub/tpub notation is the conventional, unambiguous form
  // to persist.
  const normalized = normalizeXpub(opts.xpub, opts.network);

  let fp = '00000000';
  let pubkey = '';
  const hd = HDKey.fromExtendedKey(normalized, networkVersions(opts.network));
  // For descriptor compilation, we need the pubkey that appears in
  // the miniscript leaf at receive index 0: xpub/0/0. `fp` here is
  // this xpub's OWN fingerprint (an account-level value) -- a real,
  // deterministic display value, but NOT the master fingerprint (see
  // this function's doc comment); use opts.masterFingerprint for that.
  const child00 = hd.deriveChild(0).deriveChild(0);
  if (hd.publicKey) fp = bip32Fingerprint(hd.publicKey);
  if (child00.publicKey) pubkey = toHex(child00.publicKey);

  const coin = opts.network === 'mainnet' ? '0' : '1';
  const key: LocalKey = {
    keyId:          crypto.randomUUID(),
    label:          opts.label,
    persona:        opts.persona,
    origin:         'imported_xpub',
    network:        opts.network,
    fingerprint:    fp,
    ...(opts.masterFingerprint ? { masterFingerprint: opts.masterFingerprint.toLowerCase() } : {}),
    derivationPath: opts.derivationPath ?? `m/48'/${coin}'/0'/2'`,
    xpub:           normalized,
    pubkey,
    status:         'active',
    createdAt:      new Date().toISOString(),
    backedUp:       true, // xpubs don't need backup
  };

  const all = loadAll();
  all.push(key);
  saveAll(all);
  return key;
}

/**
 * Import a public key handed over by Tapit Wallet -- see
 * docs/integration-phase2-vault-key-bridge.md for the full design.
 *
 * Tapit's identity key has no BIP32 derivation at all (a flat
 * secp256k1/Schnorr keypair, no chain code, no xpub -- see
 * tapit-attest/src/core/wallet.ts). It reports a 32-byte BIP340
 * x-only pubkey (64 hex chars), not the 33-byte compressed form
 * (66 hex chars) this file's `pubkey` field and the Rust compiler's
 * `PublicKey::from_str` both expect.
 *
 * The fix is not a hack: BIP340 always generates keys with an even Y
 * coordinate (its own pubkey_gen negates the private key when needed
 * to guarantee this), so prefixing '02' onto an x-only key IS its
 * correct, standard compressed form under secp256k1 point encoding --
 * the same lift `XOnlyPublicKey::public_key(Parity::Even)` performs in
 * rust-bitcoin. Once compiled into a Taproot leaf, the script only
 * ever stores the x-only key back out again, so the on-chain key is
 * byte-identical to what Tapit reported either way -- this is purely
 * satisfying this file's/the compiler's compressed-pubkey type, not a
 * different key.
 *
 * No xpub, fingerprint, or derivationPath -- left empty (not
 * invented). `buildKeyOrigins()`/`buildPsbtKeyOrigins()` in
 * descriptor-keys.ts already gracefully skip any key missing those
 * fields, so a Tapit key's leaf simply carries a bare pubkey in the
 * compiled descriptor instead of a `[fp/path]xpub/0/0` key-origin
 * expression -- honest, since it isn't a hardware wallet.
 */
export function importTapitPubkey(opts: {
  label: string;
  network: Network;
  xOnlyPubkey: string;
  persona: string;
}): LocalKey {
  const clean = opts.xOnlyPubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('Invalid Tapit public key — expected 64 hex characters (32 bytes, x-only).');
  }

  const key: LocalKey = {
    keyId:            crypto.randomUUID(),
    label:            opts.label,
    persona:          opts.persona,
    origin:           'tapit',
    network:          opts.network,
    fingerprint:      displayTag(clean),
    derivationPath:   '',
    xpub:             '',
    pubkey:           '02' + clean,
    tapitXOnlyPubkey: clean,
    status:           'active',
    createdAt:        new Date().toISOString(),
    backedUp:         true, // the key lives in Tapit; nothing to back up here
  };

  const all = loadAll();
  all.push(key);
  saveAll(all);
  return key;
}

// A short, stable, non-BIP32 tag derived from the pubkey itself, used
// only so a Tapit key's KeyPicker chip has something better than a
// blank field to show next to its persona/network -- never fed into
// buildKeyOrigins (which requires xpub + derivationPath too, both
// deliberately empty on a Tapit key) so it can never be mistaken for
// a real BIP32 fingerprint by the compile path.
function displayTag(hex: string): string {
  return toHex(sha256(new TextEncoder().encode(hex))).slice(0, 8);
}

/**
 * Split a BIP-380 key-origin descriptor fragment -- [<8-hex fingerprint>/
 * <hardened path>]<xpub>, e.g. [c8fe8d4e/48'/1'/0'/2']tpub... -- into its
 * xpub and derivation-path parts. This is the format that carries BOTH
 * the key AND the exact BIP32 path a signer used to derive it in one
 * string; Sparrow, SeedSigner, and Coldcard's descriptor-style exports
 * all use it. It matters because a BARE xpub carries no path info at
 * all -- if a caller then falls back to a guessed default path instead
 * of the signer's real one, that signer won't be able to re-derive the
 * matching private key when it's actually time to sign. This is the
 * same failure class already documented in this repo's known-issues
 * history (a hardware-wallet spend silently failing because
 * derivation_path was an account-level guess, not the full real path).
 * Returns null for a plain bare xpub (no brackets) -- callers should
 * fall back to treating the whole string as the xpub with no path info
 * in that case, same as before this existed.
 */
export function splitKeyOrigin(raw: string): { xpub: string; path: string; fingerprint: string } | null {
  const m = raw.trim().match(/^\[([0-9a-fA-F]{8})((?:\/[0-9]+['hH]?)+)\]([a-zA-Z][a-zA-Z0-9]{80,})/);
  if (!m) return null;
  const [, fingerprint, rawPath, xpub] = m;
  return { xpub, path: 'm' + rawPath.replace(/[hH]/g, "'"), fingerprint: fingerprint.toLowerCase() };
}

/**
 * Pull an {xpub, path} pair out of a hardware wallet's exported wallet
 * JSON, so a signer's export file can fill the same two fields manual
 * paste does -- typing a 100+ character xpub and a derivation path on
 * a phone keyboard is exactly the friction this exists to skip.
 *
 * Hardware wallets vary in export shape. Handles, in order:
 *   1. A flat single-purpose export: { xpub, deriv|path|bip32_path }.
 *   2. Coldcard's "Generic JSON" multi-account export, which nests one
 *      object per script type (bip48_2, bip48_1, bip84, bip49, bip44).
 *      bip48_2 (native segwit multisig) is tried first since it matches
 *      this app's own default derivation path.
 *   3. Fallback: scan every top-level value for anything shaped like
 *      #1, so an export format this wasn't specifically written for
 *      still has a chance of working.
 * Deliberately lenient on the xpub string itself (just "looks like a
 * key," not a strict prefix check) -- importXpub() already validates
 * the prefix and throws its own clear error, so this only needs to
 * get the two strings into the form; it doesn't need to duplicate
 * that gate.
 */
export function parseHardwareWalletExport(
  json: unknown,
): { xpub: string; path: string; fingerprint: string | null } | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;

  function readPair(o: unknown): { xpub: string; path: string; fingerprint: string | null } | null {
    if (!o || typeof o !== 'object') return null;
    const r = o as Record<string, unknown>;
    const xpub = r.xpub ?? r.Xpub ?? r.zpub ?? r.Zpub ?? r.ypub ?? r.Ypub;
    // Some exports put the full [fingerprint/path]xpub key-origin form
    // directly in the xpub field, with no separate deriv/path field at
    // all -- split it out first so that path isn't silently lost.
    if (typeof xpub === 'string') {
      const split = splitKeyOrigin(xpub);
      if (split) return { xpub: split.xpub, path: split.path, fingerprint: split.fingerprint };
    }
    const path = r.deriv ?? r.path ?? r.bip32_path ?? r.derivation;
    const fp = r.xfp ?? r.fingerprint ?? r.master_fingerprint;
    if (typeof xpub === 'string' && xpub.length > 50 && typeof path === 'string' && path.length > 0) {
      return { xpub, path, fingerprint: typeof fp === 'string' ? fp.toLowerCase() : null };
    }
    return null;
  }

  const flat = readPair(obj);
  if (flat) return flat;

  for (const key of ['bip48_2', 'bip48_1', 'bip84', 'bip49', 'bip44']) {
    const found = readPair(obj[key]);
    if (found) return found;
  }

  for (const value of Object.values(obj)) {
    const found = readPair(value);
    if (found) return found;
  }

  return null;
}

/**
 * Given arbitrary text -- a QR scan result, or the contents of a
 * pasted/imported file -- extract an {xpub, path} pair, trying every
 * shape this app knows how to read, in order: a BIP-380 key-origin
 * string ([fp/path]xpub...) which carries a real path; a bare xpub
 * with no path info at all; or JSON matching parseHardwareWalletExport's
 * shape. Returns null if none match.
 *
 * path is null ONLY for the bare-xpub case, where there genuinely is no
 * path information to report. Every other match either supplies a real
 * path or fails outright -- this never guesses one, since a wrong
 * derivation path means a signer can't re-derive the matching private
 * key later (the exact failure this repo's known-issues history already
 * documents once).
 *
 * fingerprint is null whenever the source didn't carry one (bare xpub,
 * or a JSON export shape with no xfp/fingerprint field) -- 2026-08-11
 * fix: this used to be silently dropped even when splitKeyOrigin (or a
 * JSON export's xfp field) DID have a real one, because importXpub()
 * had no parameter to receive it and instead tried to recompute a
 * fingerprint from the bare xpub alone -- which is mathematically
 * impossible to get right (an xpub carries no information about its
 * own ancestors, only the master seed does), and produced either the
 * wrong value (an account-level fingerprint mislabeled as the master
 * one hardware-wallet matching needs) or, for any non-mainnet network,
 * literally "00000000" because the recompute itself silently failed
 * (see importXpub's own fix). Callers should now thread this straight
 * through into importXpub's masterFingerprint parameter instead of
 * letting it recompute a guess.
 */
export function parseXpubText(
  raw: string,
): { xpub: string; path: string | null; fingerprint: string | null } | null {
  const trimmed = raw.trim();
  const origin = splitKeyOrigin(trimmed);
  if (origin) return { xpub: origin.xpub, path: origin.path, fingerprint: origin.fingerprint };
  if (/^[a-zA-Z]pub[a-zA-Z0-9]{80,}$/.test(trimmed)) return { xpub: trimmed, path: null, fingerprint: null };
  try {
    const parsed = parseHardwareWalletExport(JSON.parse(trimmed));
    if (parsed) return parsed;
  } catch { /* not JSON */ }
  return null;
}

/**
 * Get mnemonic — works for both test keys (no password) and secure keys (needs password).
 */
export async function revealMnemonic(keyId: string, password?: string, prf: PrfProvider = webauthnPrf): Promise<string> {
  const key = getKey(keyId);
  if (!key)                      throw new Error('Key not found');
  if (key.origin !== 'software') throw new Error('Hardware key — no mnemonic stored');

  // Test key — no password needed, and never on mainnet (a plaintext
  // mainnet seed must not be usable even if it was created before this
  // rule or imported from a keyring file; secureTestKey still works on
  // it because it reads the field directly, so the upgrade path stays
  // open while the signing path is closed).
  if (key.testMnemonic) {
    const blocked = keySigningBlockedReason(key);
    if (blocked) throw new Error(blocked);
    return key.testMnemonic;
  }

  // Passkey key — the device's own prompt replaces the password
  if (key.passkeyMnemonic) {
    const secret = await prf.evaluate(key.passkeyMnemonic.credentialIdB64, key.passkeyMnemonic.prfSaltB64);
    let m: string;
    try {
      m = await decryptWithPrfSecret(key.passkeyMnemonic, secret);
    } catch {
      throw new Error('This passkey could not unlock the key. Use the passkey it was protected with, or restore the key from its written recovery phrase.');
    }
    if (!validateMnemonic(m, wordlist)) throw new Error('Decrypted data is not a valid mnemonic');
    return m;
  }

  // Secure key — password required
  if (!key.encryptedMnemonic) throw new Error('No mnemonic found on this key');
  if (!password)              throw new Error('Password required for secure key');

  try {
    const m = await decryptBlob(key.encryptedMnemonic, password);
    if (!validateMnemonic(m, wordlist)) throw new Error('Decrypted data is not a valid mnemonic');
    return m;
  } catch (err) {
    if (err instanceof Error && err.message.includes('mnemonic')) throw err;
    throw new Error('Wrong password or corrupted backup');
  }
}

/**
 * Upgrade a test key to a secure encrypted key (sets password, removes plaintext mnemonic).
 */
export async function secureTestKey(keyId: string, password: string): Promise<LocalKey> {
  const key = getKey(keyId);
  if (!key)               throw new Error('Key not found');
  if (!key.testMnemonic)  throw new Error('Not a test key');

  const encryptedMnemonic = await encryptText(key.testMnemonic, password);
  const all = loadAll();
  const idx = all.findIndex(k => k.keyId === keyId);
  all[idx] = { ...all[idx], encryptedMnemonic, testMnemonic: undefined };
  saveAll(all);
  return all[idx];
}

/**
 * Downgrade a secure encrypted key back to a plaintext test key (drops the
 * password requirement). Takes the already-decrypted mnemonic rather than a
 * password -- the caller must have just proven possession of it via a
 * successful revealMnemonic() call, so this never re-derives or re-checks
 * anything on its own.
 */
export function removeKeyPassword(keyId: string, mnemonic: string): LocalKey {
  const key = getKey(keyId);
  if (!key)                     throw new Error('Key not found');
  if (!key.encryptedMnemonic)   throw new Error('Not a password-protected key');
  const blocked = testModeBlockedReason(key.network);
  if (blocked)                  throw new Error(blocked);

  const all = loadAll();
  const idx = all.findIndex(k => k.keyId === keyId);
  all[idx] = { ...all[idx], testMnemonic: mnemonic, encryptedMnemonic: undefined };
  saveAll(all);
  return all[idx];
}

/**
 * Replace a key's password with a passkey.
 *
 * This is the one operation in this file that could strand a seed if
 * the device's passkey misbehaved, so it is built to refuse rather than
 * hope:
 *   - the key must have completed its written-backup verification
 *     (`backedUp`) -- that phrase is the way back if the passkey is ever
 *     lost, and it must exist BEFORE the password goes away;
 *   - the passkey is asked for its secret TWICE and the two answers must
 *     match (a passkey that is not deterministic cannot be a key);
 *   - the mnemonic is encrypted, then decrypted again from the stored
 *     form and compared, before anything is saved;
 *   - only then is the password blob dropped, in the same write.
 * A failure at any step leaves the key exactly as it was.
 */
export async function protectKeyWithPasskey(
  keyId: string,
  opts: { password?: string; prf?: PrfProvider } = {},
): Promise<LocalKey> {
  const prf = opts.prf ?? webauthnPrf;
  const key = getKey(keyId);
  if (!key)                      throw new Error('Key not found');
  if (key.origin !== 'software') throw new Error('Only keys held in this browser can be protected with a passkey');
  if (key.passkeyMnemonic)       throw new Error('This key is already protected with a passkey');
  if (!key.backedUp) {
    throw new Error('Back up and verify this key\'s recovery phrase first. Once the password is gone, that written phrase is the only way back if the passkey is ever lost.');
  }

  // Read the seed with the key's CURRENT protection. A plaintext test
  // key is read directly (same as secureTestKey) so a mainnet test key
  // can still be upgraded.
  const mnemonic = key.testMnemonic ?? await revealMnemonic(keyId, opts.password, prf);
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('Stored recovery phrase is not valid');

  const { credentialIdB64 } = await prf.create(key.label);
  const prfSaltB64 = b64(crypto.getRandomValues(new Uint8Array(32)));
  const secretA = await prf.evaluate(credentialIdB64, prfSaltB64);
  const secretB = await prf.evaluate(credentialIdB64, prfSaltB64);
  if (secretA.length !== 32 || toHex(secretA) !== toHex(secretB)) {
    throw new Error('This passkey did not give the same answer twice, so it cannot protect a key. The key keeps its current protection.');
  }

  const blob = await encryptWithPrfSecret(mnemonic, secretA, credentialIdB64, prfSaltB64);
  if ((await decryptWithPrfSecret(blob, secretB)) !== mnemonic) {
    throw new Error('Passkey protection failed its own check. The key keeps its current protection.');
  }

  const all = loadAll();
  const idx = all.findIndex(k => k.keyId === keyId);
  if (idx < 0) throw new Error('Key not found');
  all[idx] = { ...all[idx], passkeyMnemonic: blob, encryptedMnemonic: undefined, testMnemonic: undefined };
  saveAll(all);
  return all[idx];
}

/**
 * Go back from a passkey to a password: unlock with the passkey,
 * re-encrypt under the new password, drop the passkey blob.
 */
export async function passkeyToPassword(keyId: string, newPassword: string, prf: PrfProvider = webauthnPrf): Promise<LocalKey> {
  const key = getKey(keyId);
  if (!key)                 throw new Error('Key not found');
  if (!key.passkeyMnemonic) throw new Error('Not a passkey-protected key');
  if (!newPassword)         throw new Error('A new password is required');
  const mnemonic = await revealMnemonic(keyId, undefined, prf);
  const encryptedMnemonic = await encryptText(mnemonic, newPassword);
  const all = loadAll();
  const idx = all.findIndex(k => k.keyId === keyId);
  all[idx] = { ...all[idx], encryptedMnemonic, passkeyMnemonic: undefined };
  saveAll(all);
  return all[idx];
}

/**
 * Change a secure key's password: decrypt with the current password,
 * re-encrypt the same mnemonic with the new one. Verifies the current
 * password itself (via decryptBlob) rather than trusting the caller --
 * an easy vector to leave open on money-touching key material otherwise.
 */
export async function changeKeyPassword(keyId: string, currentPassword: string, newPassword: string): Promise<LocalKey> {
  const key = getKey(keyId);
  if (!key)                   throw new Error('Key not found');
  if (!key.encryptedMnemonic) throw new Error('Not a password-protected key');

  const mnemonic = await decryptBlob(key.encryptedMnemonic, currentPassword);
  const encryptedMnemonic = await encryptText(mnemonic, newPassword);
  const all = loadAll();
  const idx = all.findIndex(k => k.keyId === keyId);
  all[idx] = { ...all[idx], encryptedMnemonic };
  saveAll(all);
  return all[idx];
}

/** Mark a key as backed up after completing verify flow */
export function markBackedUp(keyId: string): void {
  const all = loadAll();
  const idx = all.findIndex(k => k.keyId === keyId);
  if (idx >= 0) { all[idx] = { ...all[idx], backedUp: true }; saveAll(all); }
}

export function updateKeyStatus(keyId: string, status: KeyStatus): LocalKey {
  const all = loadAll();
  const idx = all.findIndex(k => k.keyId === keyId);
  if (idx < 0) throw new Error('Key not found');
  all[idx] = { ...all[idx], status };
  saveAll(all);
  return all[idx];
}

export function deleteKey(keyId: string): void {
  saveAll(loadAll().filter(k => k.keyId !== keyId));
}

/**
 * Delete a key only after its holder proves they can unlock it.
 *
 * Deleting used to take one Confirm tap and no proof at all -- a wrong
 * tap, or anyone holding the unlocked phone, could destroy a mainnet
 * key whose phrase was never written down. A key protected by a
 * password or a passkey now has to be UNLOCKED to be deleted (a wrong
 * password throws and nothing is removed). Keys with nothing to unlock
 * -- plaintext test keys, imported xpubs, Tapit keys, which hold no
 * secret here or none that is protected -- are deleted directly; the
 * caller's typed-name confirmation is their guard.
 */
export async function deleteKeyVerified(
  keyId: string,
  opts: { password?: string; prf?: PrfProvider } = {},
): Promise<void> {
  const key = getKey(keyId) ?? loadAll().find(k => k.keyId === keyId) ?? null;
  if (!key) throw new Error('Key not found');
  if (key.origin === 'software' && (key.passkeyMnemonic || key.encryptedMnemonic)) {
    await revealMnemonic(keyId, opts.password, opts.prf ?? webauthnPrf);
  }
  deleteKey(keyId);
}

export function exportKeyring(): string {
  // Strip plaintext mnemonics from export
  const keys = loadAll().map(({ testMnemonic: _, encryptedMnemonic: __, ...pub }) => pub);
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), keys }, null, 2);
}

export function checkMnemonic(words: string): boolean {
  return validateMnemonic(words.trim().toLowerCase(), wordlist);
}

/**
 * Normalize stored pubkeys + fingerprints to the Nunchuk-compatible
 * convention.
 *
 * Older versions of this file stored:
 *   - pubkey = compressed pubkey at the ACCOUNT level
 *     (m/48'/coin'/0'/2')
 *   - fingerprint = first 4 bytes of the raw account pubkey
 * Both were wrong for descriptor compilation + hardware wallet
 * interop. Correct values:
 *   - pubkey = compressed pubkey at xpub/0/0 (the first receive-
 *     chain child, which is the key that actually appears in the
 *     miniscript leaf at address index 0)
 *   - fingerprint = BIP32 standard: HASH160(pub)[0..4]
 *
 * This runs on boot (RequireAuth) and quietly re-derives both
 * values from the stored xpub. Safe to re-run.
 */
export function repairPubkeys(): number {
  const all = loadAll();
  let fixed = 0;
  const repaired = all.map(key => {
    if (key.origin !== 'software' && key.origin !== 'imported_xpub') return key;
    try {
      const hd = HDKey.fromExtendedKey(key.xpub);
      const child00 = hd.deriveChild(0).deriveChild(0);
      if (!hd.publicKey || !child00.publicKey) return key;
      const correctPubkey = toHex(child00.publicKey);
      const correctFingerprint = bip32Fingerprint(hd.publicKey);
      if (key.pubkey === correctPubkey && key.fingerprint === correctFingerprint) {
        return key;
      }
      fixed++;
      return { ...key, pubkey: correctPubkey, fingerprint: correctFingerprint };
    } catch {
      return key;
    }
  });
  if (fixed > 0) saveAll(repaired);
  return fixed;
}

/** Rename / relabel a key */
export function renameKey(keyId: string, label: string, persona?: string): LocalKey {
  const all = loadAll();
  const idx = all.findIndex(k => k.keyId === keyId);
  if (idx < 0) throw new Error('Key not found');
  all[idx] = { ...all[idx], label, ...(persona ? { persona } : {}) };
  saveAll(all);
  return all[idx];
}

/** Import a full keyring JSON (public data only — no mnemonics) */
export function importKeyringJson(json: string): number {
  let data: { keys?: unknown[] };
  try { data = JSON.parse(json); }
  catch { throw new Error('Invalid JSON'); }
  if (!Array.isArray(data.keys)) throw new Error('No keys array found');
  const existing = loadAll();
  const existingIds = new Set(existing.map(k => k.keyId));
  let added = 0;
  for (const k of data.keys as LocalKey[]) {
    // A Tapit-sourced key has no xpub (see importTapitPubkey) -- its
    // pubkey is the only identifying public data it carries, same as
    // every other key exports right now (no mnemonics either way).
    // Requiring xpub unconditionally here would silently drop a Tapit
    // key on every export/re-import round trip.
    const hasIdentifyingData = k.origin === 'tapit' ? !!k.pubkey : !!k.xpub;
    if (!k.keyId || !hasIdentifyingData || existingIds.has(k.keyId)) continue;
    existing.push({ ...k, status: 'active', backedUp: true });
    added++;
  }
  saveAll(existing);
  return added;
}

/** Get all keys including archived for a full export */
export function listAllKeys(): LocalKey[] {
  return loadAll();
}
