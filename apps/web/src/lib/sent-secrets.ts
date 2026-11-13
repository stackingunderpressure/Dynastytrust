/**
 * sent-secrets.ts -- wrap/unwrap for the "secrets I've sent" recall
 * feature (032_sent_secrets.sql). Reuses keystore.ts's encryptText /
 * decryptBlob verbatim -- same AES-256-GCM + PBKDF2 (210,000 rounds)
 * posture already used for "secure mode" Bitcoin keys and the
 * messaging-key backup, just applied to a JSON object of secret
 * fields instead of a mnemonic or a raw private key. The password
 * and the decrypted fields never leave the caller's browser.
 */

import { encryptText, decryptBlobAnyRounds, type EncryptedBlob } from './keystore';
import { serverSecretPasswordProblem } from './password-rules';

/** Encrypt an arbitrary set of secret fields (e.g. { normalPhrase,
 *  duressPhrase }) under a password the owner sets. The server only
 *  ever receives the returned blob.
 *
 *  Threat model item I: the blob sits on the server, so a database leak
 *  lets anyone guess its password offline, at their own speed. The
 *  password is therefore held to the real-bitcoin rule whatever the
 *  vault's network -- the duress phrase inside is real-world safety, not
 *  test coins. An older blob under a weaker password still opens. */
export async function wrapSentSecret(
  fields: Record<string, string>,
  password: string,
): Promise<EncryptedBlob> {
  const weak = serverSecretPasswordProblem(password);
  if (weak) throw new Error(weak);
  return encryptText(JSON.stringify(fields), password);
}

/** Decrypt a stored blob with the password that produced it. Throws
 *  (wrong password / corrupt blob) -- AES-GCM's tag check fails
 *  closed, same as everywhere else this pattern is used. */
export async function unwrapSentSecret(
  blob: EncryptedBlob,
  password: string,
): Promise<Record<string, string>> {
  const json = await decryptBlobAnyRounds(blob, password);
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') throw new Error('Corrupt secret record');
  return parsed as Record<string, string>;
}
