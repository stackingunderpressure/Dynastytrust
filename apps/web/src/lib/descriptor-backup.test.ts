import { describe, it, expect } from 'vitest';
import { vaultBackupText, type VaultBackupLike } from './descriptor-backup';

const vault: VaultBackupLike = {
  name: 'Family Vault',
  network: 'testnet',
  address: 'tb1pexampleaddress',
  descriptor: 'tr(KEY,{and_v(...)})#checksum',
  miniscript_policy: 'thresh(2,pk(A),pk(B))',
  address_type: 'tr_multileaf',
  founder_quorum: 2,
  heir_quorum: 1,
  recovery_after: 26280,
  inheritance_after: 105120,
  founder_keys: ['xpubFOUNDER1', 'xpubFOUNDER2'],
  heir_keys: ['xpubHEIR1'],
};

describe('vaultBackupText', () => {
  it('emits the load-bearing public fields a restorer needs', () => {
    const text = vaultBackupText(vault);
    expect(text).toContain('Family Vault');
    expect(text).toContain('tb1pexampleaddress');
    expect(text).toContain('tr(KEY,{and_v(...)})#checksum');
    expect(text).toContain('thresh(2,pk(A),pk(B))');
    for (const k of [...vault.founder_keys, ...vault.heir_keys]) {
      expect(text).toContain(k);
    }
    expect(text).toMatch(/Founders:\s+2 of 2/);
    expect(text).toMatch(/Heirs:\s+1 of 1/);
  });

  it('formats the absolute timelock heights with thousands separators', () => {
    const text = vaultBackupText(vault);
    expect(text).toContain('Recovery after: 26,280 blocks');
    expect(text).toContain('Inheritance after: 105,120 blocks');
  });

  it('never emits private key material (descriptor + xpubs only)', () => {
    const text = vaultBackupText(vault);
    // No extended private keys and no tprv/yprv/zprv variants. (The recovery
    // instructions legitimately mention "seed phrase" as guidance, so that
    // phrase is expected; what must never appear is actual key material.)
    expect(text).not.toMatch(/[xtyz]prv/);
  });

  it('shows a not-compiled placeholder before compile', () => {
    const text = vaultBackupText({
      ...vault,
      address: null,
      descriptor: null,
      miniscript_policy: null,
    });
    expect(text).toContain('(not compiled yet)');
  });
});
