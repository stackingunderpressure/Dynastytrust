/**
 * keystore.test.ts — guards the "keys never leave the browser unencrypted"
 * rule. These exercise the real AES-256-GCM + PBKDF2 path (Node provides
 * crypto.subtle); localStorage is shimmed in-memory since the keystore
 * persists there.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateTestKey,
  generateSoftwareKey,
  revealMnemonic,
  secureTestKey,
  exportKeyring,
  checkMnemonic,
} from './keystore';

beforeEach(() => {
  const store = new Map<string, string>();
  const ls: Storage = {
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    get length() {
      return store.size;
    },
  };
  globalThis.localStorage = ls;
});

describe('keystore secure-mode encryption', () => {
  it('round-trips an encrypted mnemonic with the correct password', async () => {
    const { key, mnemonic } = await generateSoftwareKey({
      label: 'F1',
      network: 'testnet',
      password: 'correct horse battery staple',
      persona: 'Founder 1',
    });
    expect(key.encryptedMnemonic).toBeTruthy();
    expect(key.testMnemonic).toBeUndefined();
    const revealed = await revealMnemonic(key.keyId, 'correct horse battery staple');
    expect(revealed).toBe(mnemonic);
  });

  it('rejects the wrong password — decryption actually gates on it', async () => {
    const { key } = await generateSoftwareKey({
      label: 'F1',
      network: 'testnet',
      password: 'the-right-password',
      persona: 'Founder 1',
    });
    await expect(revealMnemonic(key.keyId, 'the-wrong-password')).rejects.toThrow(
      /wrong password|corrupted/i,
    );
  });

  it('never persists a secure key mnemonic in plaintext', async () => {
    const { mnemonic } = await generateSoftwareKey({
      label: 'F1',
      network: 'testnet',
      password: 'pw',
      persona: 'Founder 1',
    });
    const raw = globalThis.localStorage.getItem('dynastytrust:keyring:v1');
    expect(raw).toBeTruthy();
    expect(raw as string).not.toContain(mnemonic);
    const words = mnemonic.split(' ');
    // even a two-word fragment must not be sitting in storage
    expect(raw as string).not.toContain(`${words[0]} ${words[1]}`);
  });

  it('upgrades a test key to encrypted and still reveals with the password', async () => {
    const { key, mnemonic } = generateTestKey({
      label: 'T',
      network: 'testnet',
      persona: 'Founder 1',
    });
    expect(key.testMnemonic).toBe(mnemonic);
    const upgraded = await secureTestKey(key.keyId, 'pw');
    expect(upgraded.testMnemonic).toBeUndefined();
    expect(upgraded.encryptedMnemonic).toBeTruthy();
    const revealed = await revealMnemonic(key.keyId, 'pw');
    expect(revealed).toBe(mnemonic);
  });

  it('exportKeyring strips all secret material', async () => {
    generateTestKey({ label: 'T', network: 'testnet', persona: 'Founder 1' });
    await generateSoftwareKey({
      label: 'S',
      network: 'testnet',
      password: 'pw',
      persona: 'Founder 2',
    });
    const json = exportKeyring();
    expect(json).not.toContain('testMnemonic');
    expect(json).not.toContain('encryptedMnemonic');
    const parsed = JSON.parse(json) as { keys: Array<Record<string, unknown>> };
    for (const k of parsed.keys) {
      expect(k.testMnemonic).toBeUndefined();
      expect(k.encryptedMnemonic).toBeUndefined();
    }
  });

  it('generates valid 24-word BIP39 mnemonics', () => {
    const { mnemonic } = generateTestKey({ label: 'T', network: 'testnet', persona: 'Founder 1' });
    expect(checkMnemonic(mnemonic)).toBe(true);
    expect(mnemonic.trim().split(/\s+/).length).toBe(24);
  });
});
