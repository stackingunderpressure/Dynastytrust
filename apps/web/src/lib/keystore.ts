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

function networkVersions(network: Network) {
  return network === 'mainnet'
    ? { private: 0x0488_ade4, public: 0x0488_b21e }
    : { private: 0x0435_8394, public: 0x0435_87cf };
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
export function generateTestKey(opts: {
  label: string;
  network: Network;
  persona: string;
}): KeyCreateResult {
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
  if (!opts.xpub.match(/^[xt]pub|^[XY]pub/)) {
    throw new Error('Invalid xpub — expected xpub…, tpub…, Xpub…');
  }

  let fp = '00000000';
  let pubkey = '';
  try {
    // 2026-08-11 fix: this omitted the network's version bytes, so
    // HDKey.fromExtendedKey defaulted to MAINNET-only validation --
    // any testnet/signet "tpub..." failed that check and threw,
    // silently landing on the '00000000' fallback below AND leaving
    // `pubkey` empty (which breaks vault compilation for this key
    // entirely -- toPubkeyHex throws "missing its pubkey"). Passing
    // the real network versions fixes both for every network, not
    // just mainnet.
    const hd = HDKey.fromExtendedKey(opts.xpub, networkVersions(opts.network));
    // For descriptor compilation, we need the pubkey that appears in
    // the miniscript leaf at receive index 0: xpub/0/0. `fp` here is
    // this xpub's OWN fingerprint (an account-level value) -- a real,
    // deterministic display value, but NOT the master fingerprint (see
    // this function's doc comment); use opts.masterFingerprint for that.
    const child00 = hd.deriveChild(0).deriveChild(0);
    if (hd.publicKey) fp = bip32Fingerprint(hd.publicKey);
    if (child00.publicKey) pubkey = toHex(child00.publicKey);
  } catch { /* non-standard version bytes */ }

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
    xpub:           opts.xpub,
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
export async function revealMnemonic(keyId: string, password?: string): Promise<string> {
  const key = getKey(keyId);
  if (!key)                      throw new Error('Key not found');
  if (key.origin !== 'software') throw new Error('Hardware key — no mnemonic stored');

  // Test key — no password needed
  if (key.testMnemonic) return key.testMnemonic;

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
