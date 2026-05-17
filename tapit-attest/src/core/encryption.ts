/**
 * Client-side wallet encryption.
 *
 * Attestations -- and the private keys that sign them -- are
 * encrypted on the client BEFORE they ever reach a sync backend.
 * The backend stores ciphertext only; it never sees plaintext or
 * the password.
 *
 * AES-256-GCM with a key stretched from the password by PBKDF2-
 * SHA256. The 210,000-round count matches DynastyTrust's "secure
 * mode" keystore so the security margin is identical.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { fromHex, fromUtf8, randomBytes, toHex, utf8 } from '../internal/hex.js';

export const PBKDF2_ROUNDS = 210_000;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;

export interface EncryptedBlob {
  readonly v: 1;
  readonly alg: 'aes-256-gcm';
  readonly kdf: 'pbkdf2-sha256';
  readonly rounds: number;
  readonly salt: string;
  readonly nonce: string;
  /** Ciphertext including the GCM auth tag, hex. */
  readonly ciphertext: string;
}

function deriveKey(password: string, salt: Uint8Array, rounds: number): Uint8Array {
  if (!password) throw new Error('password is required');
  return pbkdf2(sha256, utf8(password), salt, { c: rounds, dkLen: KEY_LEN });
}

/** Encrypt bytes or a string under a password. */
export function encrypt(
  plaintext: string | Uint8Array,
  password: string,
): EncryptedBlob {
  const data = typeof plaintext === 'string' ? utf8(plaintext) : plaintext;
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = deriveKey(password, salt, PBKDF2_ROUNDS);
  const ciphertext = gcm(key, nonce).encrypt(data);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    rounds: PBKDF2_ROUNDS,
    salt: toHex(salt),
    nonce: toHex(nonce),
    ciphertext: toHex(ciphertext),
  };
}

/** Decrypt a blob back to raw bytes. Throws on a wrong password. */
export function decrypt(blob: EncryptedBlob, password: string): Uint8Array {
  if (blob.alg !== 'aes-256-gcm' || blob.kdf !== 'pbkdf2-sha256') {
    throw new Error('unsupported encryption blob');
  }
  const key = deriveKey(password, fromHex(blob.salt), blob.rounds);
  try {
    return gcm(key, fromHex(blob.nonce)).decrypt(fromHex(blob.ciphertext));
  } catch {
    throw new Error('decryption failed: wrong password or corrupt blob');
  }
}

/** Decrypt a blob that was encrypted from a UTF-8 string. */
export function decryptToString(blob: EncryptedBlob, password: string): string {
  return fromUtf8(decrypt(blob, password));
}
