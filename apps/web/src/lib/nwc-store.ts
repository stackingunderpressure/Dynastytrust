/**
 * nwc-store.ts -- the purse wallet's connection, kept on this phone only,
 * encrypted with the treasurer's password the same way secure keys are
 * (lib/keystore.ts encryptText: PBKDF2 + AES-256-GCM). Never synced,
 * never sent to the server, never logged.
 */
import { decryptBlob, encryptText, type EncryptedBlob } from './keystore';

const KEY = (vaultId: string) => `dt.purse.nwc.${vaultId}`;

export function hasPurseWallet(vaultId: string): boolean {
  try {
    return Boolean(localStorage.getItem(KEY(vaultId)));
  } catch {
    return false;
  }
}

export async function savePurseWallet(vaultId: string, uri: string, password: string): Promise<void> {
  if (password.length < 8) throw new Error('Use a password of at least 8 characters.');
  const blob = await encryptText(uri.trim(), password);
  localStorage.setItem(KEY(vaultId), JSON.stringify(blob));
}

export async function openPurseWallet(vaultId: string, password: string): Promise<string> {
  const raw = localStorage.getItem(KEY(vaultId));
  if (!raw) throw new Error('No purse wallet is connected on this phone.');
  try {
    return await decryptBlob(JSON.parse(raw) as EncryptedBlob, password);
  } catch {
    throw new Error('That password did not unlock the purse wallet.');
  }
}

export function forgetPurseWallet(vaultId: string): void {
  try {
    localStorage.removeItem(KEY(vaultId));
  } catch {
    /* nothing stored */
  }
}
