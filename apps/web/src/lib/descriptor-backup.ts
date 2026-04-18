/**
 * descriptor-backup.ts -- write a human-readable .txt backup of a
 * compiled vault's descriptor + parameters.
 *
 * The descriptor alone is enough to reconstruct addresses and monitor
 * a vault from any Bitcoin wallet that supports miniscript (Sparrow,
 * Nunchuk, Bitcoin Core). Combined with one party's mnemonic + the
 * policy parameters, it's enough to spend. So every member should
 * have this file on paper / in cold storage / on a USB.
 */

import type { Vault } from './api';

export interface VaultBackupLike {
  name: string;
  network: 'testnet' | 'bitcoin';
  address: string;
  descriptor: string;
  miniscript_policy: string;
  address_type: string;
  founder_quorum: number;
  heir_quorum: number;
  recovery_after: number;
  inheritance_after: number;
  founder_keys: string[];
  heir_keys: string[];
}

export function vaultBackupText(v: VaultBackupLike): string {
  const lines = [
    `# DynastyTrust vault backup`,
    `# Name: ${v.name}`,
    `# Network: ${v.network}`,
    `# Address type: ${v.address_type}`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
    `# Receive address`,
    v.address,
    ``,
    `# Output descriptor (Nunchuk / Sparrow / Coldcard import)`,
    v.descriptor,
    ``,
    `# Miniscript policy`,
    v.miniscript_policy,
    ``,
    `# Spending rules`,
    `Founders:       ${v.founder_quorum} of ${v.founder_keys.length}`,
    `Heirs:          ${v.heir_quorum} of ${v.heir_keys.length}`,
    `Recovery after: ${v.recovery_after.toLocaleString()} blocks`,
    `Inheritance after: ${v.inheritance_after.toLocaleString()} blocks`,
    ``,
    `# Founder xpubs`,
    ...v.founder_keys,
    ``,
    `# Heir xpubs`,
    ...v.heir_keys,
    ``,
  ];
  return lines.join('\n');
}

export function downloadVaultBackup(v: VaultBackupLike): void {
  const safeName = v.name.replace(/[^a-z0-9\-_]+/gi, '_').toLowerCase() || 'vault';
  const blob = new Blob([vaultBackupText(v)], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `dynastytrust-${safeName}-${v.network}-backup.txt`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// Type-safe wrapper for the full Vault type.
export function downloadVault(v: Vault): void {
  downloadVaultBackup(v);
}
