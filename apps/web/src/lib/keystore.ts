/**
 * keystore.ts — Browser-side software key manager
 *
 * Security model (suitable for testing; notes on production hardening inline):
 *   - BIP39 24-word mnemonic generated in-browser via Web Crypto CSPRNG
 *   - HD key derived at m/48'/coin'/0'/2'  (standard multisig path, BIP48)
 *   - Mnemonic encrypted with AES-256-GCM; key derived via PBKDF2-SHA256 (210k rounds)
 *   - Ciphertext stored in localStorage — private material NEVER leaves the browser
 *   - Only xpub + fingerprint are shared with the server / vault policy
 *
 * Multi-persona testing:
 *   Keys are stored with a `personaId` tag. When you generate keys under
 *   different personas (Founder-A, Heir-1, etc.) they all live in the same
 *   localStorage but are grouped and labeled, so one browser can simulate
 *   an entire multisig quorum without needing multiple devices.
 *
 * Production upgrade path:
 *   Swap the localStorage read/write functions below for WebAuthn PRF or
 *   Secure Enclave calls — the rest of the API stays identical.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';

const STORE_KEY = 'dynastytrust:keyring:v1';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Network  = 'testnet' | 'mainnet';
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
  /** Persona label — used to simulate multiple signers from one browser */
  persona: string;
  origin: KeyOrigin;
  network: Network;
  fingerprint: string;
  derivationPath: string;
  xpub: string;
  pubkey: string;
  status: KeyStatus;
  createdAt: string;
  encryptedMnemonic?: EncryptedBlob;
}

export interface KeyCreateResult {
  key: LocalKey;
  /** Shown once for backup — never stored in plaintext */
  mnemonic: string;
}

// ── Personas ──────────────────────────────────────────────────────────────────
// Built-in test personas so one browser can act as a full quorum

export const DEFAULT_PERSONAS = [
  'Founder 1',
  'Founder 2',
  'Founder 3',
  'Heir 1',
  'Heir 2',
  'Trustee',
];

// ── Storage ───────────────────────────────────────────────────────────────────

function loadAll(): LocalKey[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as LocalKey[]) : [];
  } catch {
    return [];
  }
}

function saveAll(keys: LocalKey[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(keys));
}

// ── Web Crypto helpers ────────────────────────────────────────────────────────

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
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

// Browser-safe hex encoder — no Buffer needed
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── HD key helpers ─────────────────────────────────────────────────────────────

function multisigPath(network: Network): string {
  const coin = network === 'mainnet' ? '0' : '1';
  return `m/48'/${coin}'/0'/2'`;
}

function networkVersions(network: Network) {
  return network === 'mainnet'
    ? { private: 0x0488_ade4, public: 0x0488_b21e }
    : { private: 0x0435_8394, public: 0x0435_87cf };
}

function fingerprint(pub: Uint8Array): string {
  return toHex(pub.subarray(0, 4));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function listKeys(persona?: string): LocalKey[] {
  const all = loadAll();
  return persona ? all.filter(k => k.persona === persona) : all;
}

export function listPersonas(): string[] {
  const all = loadAll();
  const set = new Set(all.map(k => k.persona));
  return Array.from(set);
}

export function getKey(keyId: string): LocalKey | null {
  return loadAll().find(k => k.keyId === keyId) ?? null;
}

/**
 * Generate a new 24-word BIP39 software key.
 * The mnemonic is encrypted and stored; plaintext is returned once for backup.
 */
export async function generateSoftwareKey(opts: {
  label: string;
  network: Network;
  password: string;
  persona: string;
}): Promise<KeyCreateResult> {
  const mnemonic = generateMnemonic(wordlist, 256);
  const seed     = mnemonicToSeedSync(mnemonic);
  const root     = HDKey.fromMasterSeed(seed, networkVersions(opts.network));
  const path     = multisigPath(opts.network);
  const account  = root.derive(path);

  if (!account.privateKey || !account.publicKey || !account.publicExtendedKey) {
    throw new Error('Key derivation failed');
  }

  const encryptedMnemonic = await encryptText(mnemonic, opts.password);

  const key: LocalKey = {
    keyId:            crypto.randomUUID(),
    label:            opts.label,
    persona:          opts.persona,
    origin:           'software',
    network:          opts.network,
    fingerprint:      fingerprint(account.publicKey),
    derivationPath:   path,
    xpub:             account.publicExtendedKey,
    pubkey:           toHex(account.publicKey),
    status:           'active',
    createdAt:        new Date().toISOString(),
    encryptedMnemonic,
  };

  const all = loadAll();
  all.push(key);
  saveAll(all);

  return { key, mnemonic };
}

/**
 * Import an xpub (hardware wallet or air-gapped device).
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
    if (hd.publicKey) {
      fp     = fingerprint(hd.publicKey);
      pubkey = toHex(hd.publicKey);
    }
  } catch { /* non-standard version bytes — ok */ }

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
  };

  const all = loadAll();
  all.push(key);
  saveAll(all);
  return key;
}

/**
 * Decrypt and return the mnemonic. Throws on wrong password.
 */
export async function revealMnemonic(keyId: string, password: string): Promise<string> {
  const key = getKey(keyId);
  if (!key)                      throw new Error('Key not found');
  if (key.origin !== 'software') throw new Error('Hardware key — no mnemonic stored here');
  if (!key.encryptedMnemonic)    throw new Error('No encrypted mnemonic found');
  try {
    const m = await decryptBlob(key.encryptedMnemonic, password);
    if (!validateMnemonic(m, wordlist)) throw new Error('Decrypted data is not a valid mnemonic');
    return m;
  } catch (err) {
    if (err instanceof Error && err.message.includes('mnemonic')) throw err;
    throw new Error('Wrong password or corrupted backup');
  }
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

/** Export all public key data as JSON (no private material) */
export function exportKeyring(): string {
  const keys = loadAll().map(({ encryptedMnemonic: _, ...pub }) => pub);
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), keys }, null, 2);
}

export function checkMnemonic(words: string): boolean {
  return validateMnemonic(words.trim().toLowerCase(), wordlist);
}
