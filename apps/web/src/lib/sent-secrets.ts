/**
 * sent-secrets.ts -- wrap/unwrap for the "secrets I've sent" recall
 * feature (032_sent_secrets.sql). Reuses keystore.ts's encryptText /
 * decryptBlob verbatim -- same AES-256-GCM + PBKDF2 (210,000 rounds)
 * posture already used for "secure mode" Bitcoin keys and the
 * messaging-key backup, just applied to a JSON object of secret
 * fields instead of a mnemonic or a raw private key. The password
 * and the decrypted fields never leave the caller's browser.
 */

import { encryptText, decryptBlob, type EncryptedBlob } from './keystore';

/** Encrypt an arbitrary set of secret fields (e.g. { normalPhrase,
 *  duressPhrase }) under a password the owner sets. The server only
 *  ever receives the returned blob. */
export async function wrapSentSecret(
  fields: Record<string, string>,
  password: string,
): Promise<EncryptedBlob> {
  return encryptText(JSON.stringify(fields), password);
}

/** Decrypt a stored blob with the password that produced it. Throws
 *  (wrong password / corrupt blob) -- AES-GCM's tag check fails
 *  closed, same as everywhere else this pattern is used. */
export async function unwrapSentSecret(
  blob: EncryptedBlob,
  password: string,
): Promise<Record<string, string>> {
  const json = await decryptBlob(blob, password);
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') throw new Error('Corrupt secret record');
  return parsed as Record<string, string>;
}
