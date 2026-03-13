import { randomUUID } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { encryptPrivateHex, type EncryptedPrivateKeyBlob } from './encryption.js';
import type { AuditRecord, KeyRecord, Network } from './types.js';

export interface KeyStore { createKey(key: KeyRecord): Promise<void>; listKeys(userId: string): Promise<KeyRecord[]>; updateStatus(userId: string, keyId: string, status: KeyRecord['status']): Promise<KeyRecord | null>; logAudit(entry: AuditRecord): Promise<void>; }
export class InMemoryKeyStore implements KeyStore {
  private keys = new Map<string, KeyRecord[]>();
  private audit = new Map<string, AuditRecord[]>();
  async createKey(key: KeyRecord) { const list = this.keys.get(key.userId) ?? []; list.push(key); this.keys.set(key.userId, list); }
  async listKeys(userId: string) { return [...(this.keys.get(userId) ?? [])]; }
  async updateStatus(userId: string, keyId: string, status: KeyRecord['status']) { const list = this.keys.get(userId) ?? []; const idx = list.findIndex((k) => k.keyId === keyId); if (idx < 0) return null; list[idx] = { ...list[idx], status }; this.keys.set(userId, list); return list[idx]; }
  async logAudit(entry: AuditRecord) { const list = this.audit.get(entry.userId) ?? []; list.push(entry); this.audit.set(entry.userId, list); }
}
function coinType(network: Network) { return network === 'mainnet' ? '0' : '1'; }
function fingerprint(publicKey: Uint8Array): string { return Buffer.from(publicKey).subarray(0, 4).toString('hex'); }
export async function createSoftwareKey(store: KeyStore, input: { userId: string; label: string; network: Network; }): Promise<KeyRecord> {
  const mnemonic = generateMnemonic(wordlist, 128);
  const seed = mnemonicToSeedSync(mnemonic);
  const versions = input.network === 'mainnet' ? { private: 0x0488ade4, public: 0x0488b21e } : { private: 0x04358394, public: 0x043587cf };
  const root = HDKey.fromMasterSeed(seed, versions);
  const path = `m/48'/${coinType(input.network)}'/0'/2'`;
  const account = root.derive(path);
  if (!account.privateKey || !account.publicKey || !account.publicExtendedKey) throw new Error('Failed to derive account key material');
  const pubkey = secp256k1.getPublicKey(account.privateKey, true);
  const encryptedPrivateBlob: EncryptedPrivateKeyBlob = encryptPrivateHex(Buffer.from(account.privateKey).toString('hex'));
  const key: KeyRecord = { keyId: randomUUID(), userId: input.userId, label: input.label, origin: 'software', network: input.network, curve: 'secp256k1', fingerprint: fingerprint(account.publicKey), derivationPath: path, xpub: account.publicExtendedKey, pubkey: Buffer.from(pubkey).toString('hex'), encryptedPrivateBlob, status: 'active', createdAt: new Date().toISOString(), canBackendSign: true };
  await store.createKey(key);
  await store.logAudit({ keyId: key.keyId, userId: input.userId, action: 'created', metadata: { label: input.label, network: input.network }, createdAt: new Date().toISOString() });
  return key;
}
