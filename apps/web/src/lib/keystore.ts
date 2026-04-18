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

export type Network   = 'testnet' | 'mainnet';
export type KeyOrigin = 'software' | 'imported_xpub';
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

async function encryptText(text: string, password: string): Promise<EncryptedBlob> {
  const salt  = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key   = await deriveKey(password, salt);
  const ct    = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(text),
  );
  return { version: 1, saltB64: b64(salt), nonceB64: b64(nonce), ciphertextB64: b64(new Uint8Array(ct)) };
}

async function decryptBlob(blob: EncryptedBlob, password: string): Promise<string> {
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
  const child00 = account.derive('0/0');
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
 */
export function importXpub(opts: {
  label: string;
  network: Network;
  xpub: string;
  derivationPath?: string;
  persona: string;
}): LocalKey {
  if (!opts.xpub.match(/^[xt]pub|^[XY]pub/)) {
    throw new Error('Invalid xpub — expected xpub…, tpub…, Xpub…');
  }

  let fp = '00000000';
  let pubkey = '';
  try {
    const hd = HDKey.fromExtendedKey(opts.xpub);
    // For descriptor compilation, we need the pubkey that appears in
    // the miniscript leaf at receive index 0: xpub/0/0. The xpub's
    // own fingerprint also needs to be the BIP32 standard so
    // hardware-wallet compat works.
    const child00 = hd.derive('0/0');
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
      const child00 = hd.derive('0/0');
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
    if (!k.keyId || !k.xpub || existingIds.has(k.keyId)) continue;
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
