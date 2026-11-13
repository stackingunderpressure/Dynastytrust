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
import { encryptText, decryptBlob, encryptWithPrfSecret, decryptWithPrfSecret, provenPasskeySecret, type EncryptedBlob, type PasskeyBlob } from './keystore';
import { webauthnPrf, type PrfProvider } from './passkey';

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

/** How the key is stored. Plain: the private key in the clear (the
 *  shape since 2026-06). Locked: the private key encrypted under this
 *  device's Face ID passkey (keystore.provenPasskeySecret), the public
 *  key left readable so the app can register it and show it without a
 *  prompt. Operator, 2026-11-13: "Make browser keys Face ID for
 *  everything important." */
type StoredMessagingKey =
  | { priv: string; pub: string; createdAt: string; locked?: undefined }
  | { pub: string; createdAt: string; locked: PasskeyBlob; priv?: undefined };

// The unlocked private key of a LOCKED stored key, held in memory only
// for this visit (until the page reloads). Never written anywhere.
let unlockedPriv: string | null = null;

const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

function readStored(): StoredMessagingKey | null {
  try {
    const raw = localStorage.getItem(MSG_KEY_STORE);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!isHex64(v.pub)) return null;
    const createdAt = typeof v.createdAt === 'string' ? v.createdAt : '';
    if (v.locked && typeof v.locked === 'object') return { pub: v.pub, createdAt, locked: v.locked as PasskeyBlob };
    if (isHex64(v.priv)) return { priv: v.priv, pub: v.pub, createdAt };
    return null;
  } catch {
    return null;
  }
}

/** Read the stored key, or make one ONLY when nothing is stored. A
 *  locked key is never mistaken for a missing one -- regenerating it
 *  would silently lose every past message. */
function storedOrNew(): StoredMessagingKey {
  const have = readStored();
  if (have) return have;
  // Unreadable junk is replaced, as it always was -- except anything that
  // says it is a Face ID lock: overwriting that would lose the real key,
  // so refuse instead.
  if ((localStorage.getItem(MSG_KEY_STORE) ?? '').includes('"locked"')) {
    throw new Error('This browser\'s Face ID messaging key could not be read. Restore it from your backup or regenerate it on the Messages tab.');
  }
  const priv = x25519.utils.randomPrivateKey();
  const entry = { priv: toHex(priv), pub: toHex(x25519.getPublicKey(priv)), createdAt: new Date().toISOString() };
  localStorage.setItem(MSG_KEY_STORE, JSON.stringify(entry));
  return entry;
}

/** True while the key is locked with Face ID and not yet opened this visit. */
export function messagingKeyLocked(): boolean {
  const s = readStored();
  return !!s?.locked && unlockedPriv === null;
}

/** True when the stored key is locked with Face ID (opened or not). */
export function messagingKeyUsesFaceId(): boolean {
  return !!readStored()?.locked;
}

/**
 * The keypair, private half included. Makes one the very first time.
 * Throws when the key is locked with Face ID and not opened this visit
 * -- call unlockMessagingKey() first.
 */
export function ensureMessagingKey(): LocalMessagingKey {
  const s = storedOrNew();
  if (!s.locked) return { priv: s.priv, pub: s.pub, createdAt: s.createdAt };
  if (unlockedPriv === null) throw new Error('Your messages are locked with Face ID. Unlock them first.');
  return { priv: unlockedPriv, pub: s.pub, createdAt: s.createdAt };
}

/** The public key -- never needs Face ID. Makes a key the very first time. */
export function getMessagingPubkey(): string {
  return storedOrNew().pub;
}

/** True when a messaging keypair already exists in this browser's
 *  localStorage (plain or locked), without generating one if it
 *  doesn't. Used to tell apart "first time ever, nothing to restore"
 *  from "this browser is missing a key a server backup could restore." */
export function hasLocalMessagingKey(): boolean {
  return readStored() !== null;
}

/** Overwrite this browser's local messaging keypair with an existing
 *  one (hex priv/pub) -- used after a successful passphrase-based
 *  restore from a server backup. Unlike ensureMessagingKey(), this
 *  never generates; it only installs what the caller already has.
 *  The installed key is plain; it can be locked with Face ID again. */
export function installMessagingKey(priv: string, pub: string): void {
  const entry: LocalMessagingKey = { priv, pub, createdAt: new Date().toISOString() };
  localStorage.setItem(MSG_KEY_STORE, JSON.stringify(entry));
  unlockedPriv = null;
}

/** Throw away this browser's key and make a new one (the Messages tab's
 *  "Regenerate key"). Past messages become unreadable here. */
export function regenerateMessagingKey(): string {
  localStorage.removeItem(MSG_KEY_STORE);
  unlockedPriv = null;
  return storedOrNew().pub;
}

const privMatchesPub = (priv: string, pub: string) => toHex(x25519.getPublicKey(fromHex(priv))) === pub;

/**
 * Lock the messaging key with this device's Face ID passkey. Proven
 * before it is saved: the passkey must answer the same twice, and the
 * locked copy must open back to a private key that matches the public
 * key. Any failure leaves the key exactly as it was. Stays open for the
 * rest of this visit.
 */
export async function lockMessagingKey(prf: PrfProvider = webauthnPrf): Promise<void> {
  const s = storedOrNew();
  if (s.locked) throw new Error('Your messages are already locked with Face ID.');
  if (!privMatchesPub(s.priv, s.pub)) throw new Error('This browser\'s messaging key does not match itself. Nothing was changed.');
  const { credentialIdB64, prfSaltB64, secret } = await provenPasskeySecret(prf);
  const locked = await encryptWithPrfSecret(s.priv, secret, credentialIdB64, prfSaltB64);
  const back = await decryptWithPrfSecret(locked, secret);
  if (back !== s.priv) throw new Error('Face ID protection failed its own check. Nothing was changed.');
  localStorage.setItem(MSG_KEY_STORE, JSON.stringify({ pub: s.pub, createdAt: s.createdAt, locked }));
  unlockedPriv = s.priv;
}

/** Open a locked key for this visit (one Face ID prompt). */
export async function unlockMessagingKey(prf: PrfProvider = webauthnPrf): Promise<void> {
  const s = readStored();
  if (!s?.locked || unlockedPriv !== null) return;
  const secret = await prf.evaluate(s.locked.credentialIdB64, s.locked.prfSaltB64);
  let priv: string;
  try {
    priv = await decryptWithPrfSecret(s.locked, secret);
  } catch {
    throw new Error('Face ID could not open your messages. Use the passkey they were locked with, or restore your messaging key from its backup.');
  }
  if (!isHex64(priv) || !privMatchesPub(priv, s.pub)) throw new Error('The messaging key opened by Face ID does not match. Nothing was changed.');
  unlockedPriv = priv;
}

/** Go back to no Face ID for messages: open it once, store it plain. */
export async function unlockMessagingKeyForGood(prf: PrfProvider = webauthnPrf): Promise<void> {
  const s = readStored();
  if (!s?.locked) return;
  await unlockMessagingKey(prf);
  const priv = unlockedPriv!;
  localStorage.setItem(MSG_KEY_STORE, JSON.stringify({ priv, pub: s.pub, createdAt: s.createdAt }));
  unlockedPriv = null;
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
  prf: PrfProvider = webauthnPrf,
): Promise<{ pubkey: string; blob: EncryptedBlob }> {
  if (messagingKeyLocked()) await unlockMessagingKey(prf);
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
  if (messagingKeyLocked()) return null;
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
