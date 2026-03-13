import { randomUUID } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { encryptPrivateHex } from './encryption.js';
export class InMemoryKeyStore {
    keys = new Map();
    audit = new Map();
    async createKey(key) { const list = this.keys.get(key.userId) ?? []; list.push(key); this.keys.set(key.userId, list); }
    async listKeys(userId) { return [...(this.keys.get(userId) ?? [])]; }
    async updateStatus(userId, keyId, status) { const list = this.keys.get(userId) ?? []; const idx = list.findIndex((k) => k.keyId === keyId); if (idx < 0)
        return null; list[idx] = { ...list[idx], status }; this.keys.set(userId, list); return list[idx]; }
    async logAudit(entry) { const list = this.audit.get(entry.userId) ?? []; list.push(entry); this.audit.set(entry.userId, list); }
}
function coinType(network) { return network === 'mainnet' ? '0' : '1'; }
function fingerprint(publicKey) { return Buffer.from(publicKey).subarray(0, 4).toString('hex'); }
export async function createSoftwareKey(store, input) {
    const mnemonic = generateMnemonic(wordlist, 128);
    const seed = mnemonicToSeedSync(mnemonic);
    const versions = input.network === 'mainnet' ? { private: 0x0488ade4, public: 0x0488b21e } : { private: 0x04358394, public: 0x043587cf };
    const root = HDKey.fromMasterSeed(seed, versions);
    const path = `m/48'/${coinType(input.network)}'/0'/2'`;
    const account = root.derive(path);
    if (!account.privateKey || !account.publicKey || !account.publicExtendedKey)
        throw new Error('Failed to derive account key material');
    const pubkey = secp256k1.getPublicKey(account.privateKey, true);
    const encryptedPrivateBlob = encryptPrivateHex(Buffer.from(account.privateKey).toString('hex'));
    const key = { keyId: randomUUID(), userId: input.userId, label: input.label, origin: 'software', network: input.network, curve: 'secp256k1', fingerprint: fingerprint(account.publicKey), derivationPath: path, xpub: account.publicExtendedKey, pubkey: Buffer.from(pubkey).toString('hex'), encryptedPrivateBlob, status: 'active', createdAt: new Date().toISOString(), canBackendSign: true };
    await store.createKey(key);
    await store.logAudit({ keyId: key.keyId, userId: input.userId, action: 'created', metadata: { label: input.label, network: input.network }, createdAt: new Date().toISOString() });
    return key;
}
