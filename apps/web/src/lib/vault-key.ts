/**
 * vault-key.ts -- the per-vault scrambling key (zero-knowledge storage,
 * docs/zero-knowledge-storage-plan.md, Z1 slice 1).
 *
 * Each vault gets a random 32-byte key, made in the owner's browser. Fields
 * the server never needs to read are sealed with it before they are sent
 * (ChaCha20-Poly1305), so the database holds only ciphertext for them.
 *
 * Members receive the key exactly the way they already receive a message key:
 * lib/messaging.ts encryptMessage wraps it to their X25519 messaging pubkey
 * (ECDH + HKDF + ChaCha20-Poly1305). One wrap row per member per key version.
 * The owner also publishes a CHECK value (HMAC of the key) on the vault, so a
 * member only ever accepts a wrap that opens to the owner's real key -- a
 * member cannot slip another member a different key.
 *
 * Trust anchor, stated plainly: wraps go to the messaging pubkey the server
 * stores for each member. A member whose key changed since it was pinned
 * (messaging-safety.ts peerKeyStatus === 'changed') is NOT given the key.
 *
 * Sealed value format:  zk1:<version>:<base64(nonce(12) || ciphertext)>
 * The AEAD's associated data binds vault id, field name and version, so a
 * sealed value cannot be moved to another vault, field or row.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';
import { encryptMessage, decryptMessage, type EncryptedMessage } from './messaging';

export const SEAL_PREFIX = 'zk1:';

const enc = new TextEncoder();
const dec = new TextDecoder();

function toHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}
function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function aad(vaultId: string, field: string, version: number): Uint8Array {
  return enc.encode(`dynastytrust-zk-v1|${vaultId}|${field}|${version}`);
}

export function newVaultKey(): Uint8Array {
  return randomBytes(32);
}

/** Public check value for a key version: lets members reject a wrong key. */
export function vaultKeyCheck(key: Uint8Array, vaultId: string, version: number): string {
  return toHex(hmac(sha256, key, enc.encode(`dynastytrust-zk-check-v1|${vaultId}|${version}`))).slice(0, 32);
}

export function isSealed(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(SEAL_PREFIX);
}

export function sealField(key: Uint8Array, version: number, vaultId: string, field: string, plaintext: string): string {
  const nonce = randomBytes(12);
  const ct = chacha20poly1305(key, nonce, aad(vaultId, field, version)).encrypt(enc.encode(plaintext));
  const both = new Uint8Array(nonce.length + ct.length);
  both.set(nonce, 0);
  both.set(ct, nonce.length);
  return `${SEAL_PREFIX}${version}:${b64(both)}`;
}

/** Open a sealed value with whichever key version it was sealed under.
 *  Null when the version is unknown to this member or the value was tampered. */
export function openField(keys: ReadonlyMap<number, Uint8Array>, vaultId: string, field: string, sealed: string): string | null {
  if (!isSealed(sealed)) return null;
  const rest = sealed.slice(SEAL_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 1) return null;
  const version = Number(rest.slice(0, colon));
  const key = keys.get(version);
  if (!key) return null;
  try {
    const both = unb64(rest.slice(colon + 1));
    const pt = chacha20poly1305(key, both.slice(0, 12), aad(vaultId, field, version)).decrypt(both.slice(12));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// --- key distribution -------------------------------------------------------

export interface VaultKeyWrapRow {
  version: number;
  wrap: EncryptedMessage;
}

/** Wrap one key version to each recipient's messaging pubkey (one wrap each). */
export function wrapVaultKey(
  key: Uint8Array,
  vaultId: string,
  version: number,
  recipients: { user_id: string; pubkey: string }[],
): { recipient_user_id: string; wrap: EncryptedMessage }[] {
  const body = JSON.stringify({ v: 1, vault_id: vaultId, version, key: toHex(key) });
  return recipients
    .filter(r => r.pubkey && r.pubkey.length === 64)
    .map(r => ({ recipient_user_id: r.user_id, wrap: encryptMessage(body, [r]) }));
}

/** Unwrap every key version this member holds, keeping only keys that match
 *  the owner's published check value for that version. */
export function unwrapVaultKeys(
  rows: VaultKeyWrapRow[],
  vaultId: string,
  myUserId: string,
  checks: Readonly<Record<string, string>>,
): Map<number, Uint8Array> {
  const keys = new Map<number, Uint8Array>();
  for (const row of rows) {
    const plain = decryptMessage(row.wrap, myUserId);
    if (!plain) continue;
    let parsed: { v?: number; vault_id?: string; version?: number; key?: string };
    try {
      parsed = JSON.parse(plain);
    } catch {
      continue;
    }
    if (parsed.v !== 1 || parsed.vault_id !== vaultId || parsed.version !== row.version) continue;
    if (typeof parsed.key !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.key)) continue;
    const key = fromHex(parsed.key);
    if (checks[String(row.version)] !== vaultKeyCheck(key, vaultId, row.version)) continue;
    keys.set(row.version, key);
  }
  return keys;
}

// --- what to do on open (pure, so it is tested without a browser) -----------

export interface VaultKeyServerState {
  version: number;                 // current key version; 0 = none yet
  owner_user_id: string;
  current_holders: { user_id: string; pubkey: string | null }[]; // wraps of the current version, and the messaging key each was made to
  members: { user_id: string; messaging_pubkey: string | null }[]; // active members
}

export type VaultKeyPlan =
  | { kind: 'none' }
  | { kind: 'wait' }                                   // no key for me yet; another member must share it
  | { kind: 'create'; version: number; recipients: { user_id: string; pubkey: string }[] }
  | { kind: 'rotate'; version: number; recipients: { user_id: string; pubkey: string }[]; removed: string[] }
  | { kind: 'share'; version: number; recipients: { user_id: string; pubkey: string }[] };

export function planVaultKeySync(
  s: VaultKeyServerState,
  myUserId: string,
  haveCurrentKey: boolean,
  trustedKey: (userId: string, pubkey: string) => boolean,
): VaultKeyPlan {
  const isOwner = s.owner_user_id === myUserId;
  const eligible = s.members
    .filter(m => m.messaging_pubkey && m.messaging_pubkey.length === 64)
    .filter(m => m.user_id === myUserId || trustedKey(m.user_id, m.messaging_pubkey!))
    .map(m => ({ user_id: m.user_id, pubkey: m.messaging_pubkey! }));
  if (s.version === 0) {
    return isOwner && eligible.some(r => r.user_id === myUserId)
      ? { kind: 'create', version: 1, recipients: eligible }
      : { kind: 'wait' };
  }
  if (!haveCurrentKey) return { kind: 'wait' };
  const active = new Set(s.members.map(m => m.user_id));
  const removed = [...new Set(s.current_holders.map(h => h.user_id))].filter(u => !active.has(u));
  if (removed.length > 0 && isOwner) {
    return { kind: 'rotate', version: s.version + 1, recipients: eligible, removed };
  }
  // Keyed by member AND messaging key: a member on a new device (new key)
  // does not hold the current vault key until it is wrapped to that key.
  const holders = new Set(s.current_holders.map(h => `${h.user_id}|${h.pubkey}`));
  const missing = eligible.filter(r => !holders.has(`${r.user_id}|${r.pubkey}`));
  return missing.length > 0 ? { kind: 'share', version: s.version, recipients: missing } : { kind: 'none' };
}
