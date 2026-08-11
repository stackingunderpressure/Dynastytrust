/**
 * messaging.ts — browser-side E2E message crypto for vault
 * threads.
 *
 * Scheme:
 *   - Each member holds a long-term X25519 keypair. The private
 *     key lives in localStorage (browser-only); the public key is
 *     published to the vault via vault_members.messaging_pubkey.
 *   - Each message generates a fresh 32-byte symmetric key K and
 *     encrypts the plaintext with ChaCha20-Poly1305 under K (one
 *     ciphertext per message -- all recipients share it).
 *   - For each recipient R, we compute shared = X25519(sender_sk,
 *     R.pk), run HKDF-SHA256 with a context string to derive a
 *     32-byte wrap key, then encrypt K with ChaCha20-Poly1305
 *     under that wrap key. The wrapped key goes in the recipients
 *     array keyed by recipient user_id.
 *   - Decrypt: find your entry, run the same ECDH + HKDF against
 *     the stored sender_pubkey, unwrap K, decrypt the message.
 *
 * The server only stores ciphertext + wrapped keys. It cannot
 * read any message. It also cannot forge one: altering the
 * ciphertext invalidates the AEAD tag, altering sender_pubkey or
 * a wrapped_key invalidates the HKDF-derived wrap key.
 *
 * NB: this gives confidentiality + recipient-side integrity, not
 * full signal-style forward secrecy. Key compromise reveals the
 * whole history. A future slice can add ephemeral prekeys.
 */

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils';
import { encryptText, decryptBlob, type EncryptedBlob } from './keystore';

const MSG_KEY_STORE = 'dynastytrust:messaging:v1';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function b64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface LocalMessagingKey {
  priv: string;  // hex
  pub: string;   // hex
  createdAt: string;
}

/**
 * Ensure a long-term messaging keypair exists in localStorage.
 * Returns { priv, pub } as hex. Idempotent; safe to call every
 * time the app opens.
 */
export function ensureMessagingKey(): LocalMessagingKey {
  try {
    const raw = localStorage.getItem(MSG_KEY_STORE);
    if (raw) {
      const parsed = JSON.parse(raw) as LocalMessagingKey;
      if (parsed.priv && parsed.pub && parsed.priv.length === 64 && parsed.pub.length === 64) {
        return parsed;
      }
    }
  } catch { /* fall through to regenerate */ }

  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  const entry: LocalMessagingKey = {
    priv: toHex(priv),
    pub: toHex(pub),
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(MSG_KEY_STORE, JSON.stringify(entry));
  return entry;
}

export function getMessagingPubkey(): string {
  return ensureMessagingKey().pub;
}

/** True when a messaging keypair already exists in this browser's
 *  localStorage, without generating one if it doesn't. Used to tell
 *  apart "first time ever, nothing to restore" from "this browser is
 *  missing a key a server backup could restore." */
export function hasLocalMessagingKey(): boolean {
  try {
    const raw = localStorage.getItem(MSG_KEY_STORE);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as LocalMessagingKey;
    return !!(parsed.priv && parsed.pub && parsed.priv.length === 64 && parsed.pub.length === 64);
  } catch {
    return false;
  }
}

/** Overwrite this browser's local messaging keypair with an existing
 *  one (hex priv/pub) -- used after a successful passphrase-based
 *  restore from a server backup. Unlike ensureMessagingKey(), this
 *  never generates; it only installs what the caller already has. */
export function installMessagingKey(priv: string, pub: string): void {
  const entry: LocalMessagingKey = { priv, pub, createdAt: new Date().toISOString() };
  localStorage.setItem(MSG_KEY_STORE, JSON.stringify(entry));
}

/**
 * Wrap this browser's current messaging private key under a
 * passphrase for durable server-side backup (messaging-key-backup.js
 * / db/migrations/030_messaging_key_backup.sql). Reuses keystore.ts's
 * encryptText -- same AES-256-GCM + PBKDF2 (210,000 rounds) posture
 * already used for "secure mode" Bitcoin keys, just applied to the
 * messaging private key's hex encoding instead of a mnemonic. The
 * server only ever receives the returned ciphertext -- the passphrase
 * and the raw private key never leave this function.
 */
export async function wrapMessagingKeyForBackup(
  passphrase: string,
): Promise<{ pubkey: string; blob: EncryptedBlob }> {
  const { priv, pub } = ensureMessagingKey();
  const blob = await encryptText(priv, passphrase);
  return { pubkey: pub, blob };
}

/**
 * Unwrap a server-stored backup blob with the passphrase that
 * produced it. Returns the recovered { priv, pub } hex pair, or
 * throws (wrong passphrase / corrupt blob -- decryptBlob's AES-GCM
 * tag check fails closed, same as everywhere else this pattern is
 * used in the app).
 */
export async function unwrapMessagingKeyFromBackup(
  blob: EncryptedBlob,
  passphrase: string,
): Promise<{ priv: string; pub: string }> {
  const priv = await decryptBlob(blob, passphrase);
  const pub = toHex(x25519.getPublicKey(fromHex(priv)));
  return { priv, pub };
}

function deriveWrapKey(
  senderPub: Uint8Array,
  recipientPub: Uint8Array,
  shared: Uint8Array,
): Uint8Array {
  // HKDF with a context that commits to BOTH pubkeys so the wrap
  // key is bound to the pair, not just the shared secret.
  const info = new Uint8Array(senderPub.length + recipientPub.length + 24);
  const tag = new TextEncoder().encode('dynastytrust-msg-v1');
  info.set(tag, 0);
  info.set(senderPub, tag.length);
  info.set(recipientPub, tag.length + senderPub.length);
  return hkdf(sha256, shared, new Uint8Array(), info, 32);
}

export interface EncryptedRecipientEntry {
  user_id: string;
  pubkey: string;        // recipient pubkey hex
  wrap_nonce: string;    // base64
  wrapped_key: string;   // base64
}

export interface EncryptedMessage {
  sender_pubkey: string;
  nonce: string;
  ciphertext: string;
  recipients: EncryptedRecipientEntry[];
}

/**
 * Encrypt `plaintext` to the given list of recipients. Each
 * recipient must have a messaging_pubkey; entries without one are
 * skipped (the caller typically only passes members who do).
 */
export function encryptMessage(
  plaintext: string,
  recipients: { user_id: string; pubkey: string }[],
): EncryptedMessage {
  const { priv, pub } = ensureMessagingKey();
  const senderPriv = fromHex(priv);
  const senderPub = fromHex(pub);

  // 1. Random symmetric message key + nonce.
  const messageKey = randomBytes(32);
  const messageNonce = randomBytes(12);
  const plainBytes = new TextEncoder().encode(plaintext);
  const ct = chacha20poly1305(messageKey, messageNonce).encrypt(plainBytes);

  // 2. Wrap messageKey for each recipient.
  const wrapped: EncryptedRecipientEntry[] = [];
  for (const r of recipients) {
    if (!r.pubkey || r.pubkey.length !== 64) continue;
    const rPub = fromHex(r.pubkey);
    const shared = x25519.getSharedSecret(senderPriv, rPub);
    const wrapKey = deriveWrapKey(senderPub, rPub, shared);
    const wrapNonce = randomBytes(12);
    const wrappedKey = chacha20poly1305(wrapKey, wrapNonce).encrypt(messageKey);
    wrapped.push({
      user_id: r.user_id,
      pubkey: r.pubkey,
      wrap_nonce: b64Encode(wrapNonce),
      wrapped_key: b64Encode(wrappedKey),
    });
  }

  return {
    sender_pubkey: pub,
    nonce: b64Encode(messageNonce),
    ciphertext: b64Encode(ct),
    recipients: wrapped,
  };
}

/**
 * Decrypt an incoming EncryptedMessage. Returns the plaintext
 * string, or null if this browser isn't in the recipients list or
 * the local key can't unwrap the message (e.g., localStorage was
 * cleared after the message was sent).
 */
export function decryptMessage(
  msg: EncryptedMessage,
  myUserId: string,
): string | null {
  const { priv } = ensureMessagingKey();
  const myPriv = fromHex(priv);

  const entry = msg.recipients.find(r => r.user_id === myUserId);
  if (!entry) return null;

  try {
    const senderPub = fromHex(msg.sender_pubkey);
    const myPub = x25519.getPublicKey(myPriv);
    const shared = x25519.getSharedSecret(myPriv, senderPub);
    const wrapKey = deriveWrapKey(senderPub, myPub, shared);
    const messageKey = chacha20poly1305(wrapKey, b64Decode(entry.wrap_nonce))
      .decrypt(b64Decode(entry.wrapped_key));
    const plain = chacha20poly1305(messageKey, b64Decode(msg.nonce))
      .decrypt(b64Decode(msg.ciphertext));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
