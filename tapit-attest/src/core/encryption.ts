import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '../internal.js';

const DEFAULT_ITERATIONS = 210_000; // OWASP 2023 floor for PBKDF2-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Self-describing ciphertext. Carries the KDF parameters so a blob can be
 * decrypted with only the password — nothing else need be remembered.
 */
export interface EncryptedBlob {
  v: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  /** hex */
  salt: string;
  /** hex */
  iv: string;
  /** hex, AES-256-GCM ciphertext (the GCM auth tag is appended by the cipher). */
  ciphertext: string;
}

function deriveKey(password: string, salt: Uint8Array, iterations: number): Uint8Array {
  return pbkdf2(sha256, utf8ToBytes(password), salt, { c: iterations, dkLen: KEY_BYTES });
}

/**
 * Encrypt the wallet client-side before it ever reaches a host. The host
 * (Supabase in v1) stores only this blob and cannot read it — dumb
 * storage, never a trusted party (ATTESTATION_PRIMITIVE_SPEC §4).
 */
export function encrypt(
  plaintext: string | Uint8Array,
  password: string,
  options: { iterations?: number } = {},
): EncryptedBlob {
  if (password.length === 0) throw new Error('password must not be empty');
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(password, salt, iterations);
  const data = typeof plaintext === 'string' ? utf8ToBytes(plaintext) : plaintext;
  const ciphertext = gcm(key, iv).encrypt(data);
  return {
    v: 1,
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(ciphertext),
  };
}

/** Decrypt a blob to raw bytes. Throws if the password is wrong or the blob is corrupt. */
export function decrypt(blob: EncryptedBlob, password: string): Uint8Array {
  if (blob.v !== 1 || blob.kdf !== 'pbkdf2-sha256') {
    throw new Error('unsupported encrypted-blob format');
  }
  const key = deriveKey(password, hexToBytes(blob.salt), blob.iterations);
  try {
    return gcm(key, hexToBytes(blob.iv)).decrypt(hexToBytes(blob.ciphertext));
  } catch {
    throw new Error('decryption failed — wrong password or corrupt blob');
  }
}

/** Decrypt a blob and decode the bytes as a UTF-8 string. */
export function decryptToString(blob: EncryptedBlob, password: string): string {
  return new TextDecoder().decode(decrypt(blob, password));
}

// ----- 5e-iii-b — recoverable backup format (v2) ------------------
//
// v1 derives the AES-GCM key directly from the passphrase. That
// means recovery requires the passphrase, full stop — there is no
// way for the operator to ever get back into the wallet without it.
//
// v2 separates the data-encryption key (K_data, a freshly random
// 256-bit AES key) from the passphrase. K_data encrypts the
// wallet snapshot. K_data is then WRAPPED two independent ways:
//
//   1. Passphrase wrap — AES-GCM(PBKDF2(passphrase, salt), K_data)
//      stored inside the blob. Legacy-style unlock still works
//      against just the blob + the operator's passphrase.
//
//   2. Shamir cascade — K_data is returned to the caller so it can
//      be split via the shamir.ts primitives and distributed to
//      cohort peers (Phase 5e-iii-b wallet-side cut). Each peer
//      holds a share that is meaningless alone; M peers cooperating
//      reconstruct K_data, which decrypts the data directly via
//      decryptRecoverableWithKData — no passphrase needed.
//
// D-03 stays loud: the SIGNING keypair is never split. Only the
// symmetric data-encryption key. M-of-N collusion at worst
// decrypts one backup snapshot; signing authority transfers only
// through peer-witnessed succession.

/**
 * Recoverable-backup blob shape. Two independent paths to K_data:
 * the passphrase wrap (legacy-style unlock) and the Shamir
 * distribution carried by cohort peers (out-of-band from the
 * blob). The blob is self-describing for the passphrase path; the
 * recovery path is gated on the operator holding M shares from
 * peers, not on anything stored here.
 */
export interface RecoverableEncryptedBlob {
  v: 2;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  /** Salt for the passphrase KDF. hex. */
  salt: string;
  /** IV for the AES-GCM passphrase-wrap of K_data. hex. */
  wrapIv: string;
  /** AES-GCM ciphertext of K_data, key = PBKDF2(passphrase, salt). hex. */
  wrapCiphertext: string;
  /** IV for the AES-GCM encryption of the data with K_data. hex. */
  dataIv: string;
  /** AES-GCM ciphertext of the data, key = K_data. hex. */
  dataCiphertext: string;
}

export interface RecoverableEncryptionResult {
  blob: RecoverableEncryptedBlob;
  /**
   * The randomly-generated data-encryption key. The caller is
   * expected to either (a) Shamir-split this across cohort peers
   * via shamir.splitSecret and distribute the shares, or (b)
   * discard it — the blob is still decryptable with the passphrase.
   * Once distributed it must not be retained on the producing
   * device; the security of the recovery cascade relies on the
   * device that minted K_data forgetting it after distribution.
   */
  kData: Uint8Array;
}

/**
 * Encrypt the data with a freshly random K_data, then wrap K_data
 * with the passphrase. Returns the v2 blob plus K_data so the
 * caller can Shamir-split + distribute as the recovery cohort
 * needs.
 */
export function encryptRecoverable(
  plaintext: string | Uint8Array,
  passphrase: string,
  options: { iterations?: number } = {},
): RecoverableEncryptionResult {
  if (passphrase.length === 0) throw new Error('passphrase must not be empty');
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salt = randomBytes(SALT_BYTES);
  const kData = randomBytes(KEY_BYTES);
  const dataIv = randomBytes(IV_BYTES);
  const data = typeof plaintext === 'string' ? utf8ToBytes(plaintext) : plaintext;
  const dataCiphertext = gcm(kData, dataIv).encrypt(data);
  const wrapKey = deriveKey(passphrase, salt, iterations);
  const wrapIv = randomBytes(IV_BYTES);
  const wrapCiphertext = gcm(wrapKey, wrapIv).encrypt(kData);
  return {
    blob: {
      v: 2,
      kdf: 'pbkdf2-sha256',
      iterations,
      salt: bytesToHex(salt),
      wrapIv: bytesToHex(wrapIv),
      wrapCiphertext: bytesToHex(wrapCiphertext),
      dataIv: bytesToHex(dataIv),
      dataCiphertext: bytesToHex(dataCiphertext),
    },
    kData,
  };
}

function assertV2(blob: RecoverableEncryptedBlob): void {
  if (blob.v !== 2 || blob.kdf !== 'pbkdf2-sha256') {
    throw new Error('unsupported recoverable-blob format');
  }
}

/** Unwrap K_data with the passphrase, then decrypt the data. */
export function decryptRecoverableWithPassphrase(
  blob: RecoverableEncryptedBlob,
  passphrase: string,
): Uint8Array {
  assertV2(blob);
  const wrapKey = deriveKey(passphrase, hexToBytes(blob.salt), blob.iterations);
  let kData: Uint8Array;
  try {
    kData = gcm(wrapKey, hexToBytes(blob.wrapIv)).decrypt(
      hexToBytes(blob.wrapCiphertext),
    );
  } catch {
    throw new Error('decryption failed — wrong passphrase or corrupt blob');
  }
  try {
    return gcm(kData, hexToBytes(blob.dataIv)).decrypt(
      hexToBytes(blob.dataCiphertext),
    );
  } catch {
    throw new Error('data decryption failed — corrupt blob');
  }
}

/**
 * Decrypt the data directly with a recovered K_data. Used by the
 * Phase 5e recovery ceremony after M cohort peers have returned
 * their shares and the new device has combined them. The blob's
 * passphrase wrap is ignored on this path — recovery does not need
 * the operator's passphrase to land their attestation history back.
 */
export function decryptRecoverableWithKData(
  blob: RecoverableEncryptedBlob,
  kData: Uint8Array,
): Uint8Array {
  assertV2(blob);
  if (kData.length !== KEY_BYTES) {
    throw new Error(`K_data must be ${KEY_BYTES} bytes`);
  }
  try {
    return gcm(kData, hexToBytes(blob.dataIv)).decrypt(
      hexToBytes(blob.dataCiphertext),
    );
  } catch {
    throw new Error('decryption failed — wrong K_data or corrupt blob');
  }
}

/**
 * Unwrap K_data from a v2 blob using the passphrase. Useful when the
 * caller needs K_data itself (to Shamir-split for the cohort) rather
 * than the decrypted plaintext.
 */
export function unwrapKData(
  blob: RecoverableEncryptedBlob,
  passphrase: string,
): Uint8Array {
  assertV2(blob);
  const wrapKey = deriveKey(passphrase, hexToBytes(blob.salt), blob.iterations);
  try {
    return gcm(wrapKey, hexToBytes(blob.wrapIv)).decrypt(
      hexToBytes(blob.wrapCiphertext),
    );
  } catch {
    throw new Error('decryption failed — wrong passphrase or corrupt blob');
  }
}

/**
 * Re-encrypt fresh plaintext under the SAME K_data already wrapped in
 * an existing v2 blob. Load-bearing for the Phase 5e cascade once
 * shares have been distributed: subsequent wallet saves MUST keep
 * K_data stable so the cohort's held shares remain valid against
 * future blobs. Without this, every save would rotate K_data and
 * silently invalidate every previously-distributed share.
 *
 * Returns a fresh blob with the same passphrase-wrap (salt, wrapIv,
 * wrapCiphertext, iterations) and a fresh dataIv + dataCiphertext.
 */
export function reencryptRecoverableReuseKData(
  oldBlob: RecoverableEncryptedBlob,
  newPlaintext: string | Uint8Array,
  passphrase: string,
): RecoverableEncryptedBlob {
  const kData = unwrapKData(oldBlob, passphrase);
  const data = typeof newPlaintext === 'string' ? utf8ToBytes(newPlaintext) : newPlaintext;
  const dataIv = randomBytes(IV_BYTES);
  const dataCiphertext = gcm(kData, dataIv).encrypt(data);
  return {
    v: 2,
    kdf: 'pbkdf2-sha256',
    iterations: oldBlob.iterations,
    salt: oldBlob.salt,
    wrapIv: oldBlob.wrapIv,
    wrapCiphertext: oldBlob.wrapCiphertext,
    dataIv: bytesToHex(dataIv),
    dataCiphertext: bytesToHex(dataCiphertext),
  };
}

/**
 * Encrypt fresh plaintext using a CALLER-supplied K_data and wrap that
 * same K_data under a fresh passphrase. The Phase 5e recovery seam:
 * the new device has reconstructed K_data from M cohort shares,
 * restored the wallet via decryptRecoverableWithKData, and now needs
 * to save under a brand-new passphrase chosen on the new device.
 *
 * Neither encryptRecoverable nor reencryptRecoverableReuseKData fits
 * this seam. encryptRecoverable mints fresh K_data, which would
 * invalidate every share the cohort holds.
 * reencryptRecoverableReuseKData unwraps K_data from the OLD blob
 * via the OLD passphrase — which the recovering operator does not
 * have, by hypothesis.
 *
 * Validates K_data length (32 bytes) and the passphrase being
 * non-empty. Does NOT verify the supplied K_data matches any prior
 * blob — that is the recovery ceremony's responsibility before
 * calling this.
 */
export function encryptRecoverableWithKData(
  plaintext: string | Uint8Array,
  kData: Uint8Array,
  passphrase: string,
  options: { iterations?: number } = {},
): RecoverableEncryptedBlob {
  if (passphrase.length === 0) throw new Error('passphrase must not be empty');
  if (kData.length !== KEY_BYTES) {
    throw new Error(`K_data must be ${KEY_BYTES} bytes`);
  }
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salt = randomBytes(SALT_BYTES);
  const dataIv = randomBytes(IV_BYTES);
  const data = typeof plaintext === 'string' ? utf8ToBytes(plaintext) : plaintext;
  const dataCiphertext = gcm(kData, dataIv).encrypt(data);
  const wrapKey = deriveKey(passphrase, salt, iterations);
  const wrapIv = randomBytes(IV_BYTES);
  const wrapCiphertext = gcm(wrapKey, wrapIv).encrypt(kData);
  return {
    v: 2,
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: bytesToHex(salt),
    wrapIv: bytesToHex(wrapIv),
    wrapCiphertext: bytesToHex(wrapCiphertext),
    dataIv: bytesToHex(dataIv),
    dataCiphertext: bytesToHex(dataCiphertext),
  };
}
