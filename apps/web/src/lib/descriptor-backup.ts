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
  network: 'testnet' | 'signet' | 'bitcoin';
  address: string | null;
  descriptor: string | null;
  miniscript_policy: string | null;
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
    v.address ?? '(not compiled yet)',
    ``,
    `# Output descriptor (Sparrow import -- primary recovery path)`,
    v.descriptor ?? '(not compiled yet)',
    ``,
    `# Miniscript policy`,
    v.miniscript_policy ?? '(not compiled yet)',
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
    `# ---------------------------------------------------------------`,
    `# RECOVERY INSTRUCTIONS (if DynastyTrust ever goes offline)`,
    `# ---------------------------------------------------------------`,
    `# The coins in this vault are independent of DynastyTrust. You`,
    `# can monitor and spend from this vault with only:`,
    `#   1. The output descriptor above`,
    `#   2. At least one signer's seed phrase (metal backup)`,
    `#`,
    `# SPARROW (recommended for Taproot multileaf):`,
    `#   File > Import Wallet > Paste or scan the descriptor above.`,
    `#   Sparrow reconstructs every address the vault can receive`,
    `#   on. To spend: File > New Transaction, sign with your seed,`,
    `#   export a partial PSBT. Collect PSBTs from co-signers via`,
    `#   any channel (Signal, USB, QR, email -- the PSBT is safe`,
    `#   to share publicly). Merge + finalize + broadcast from any`,
    `#   Sparrow instance.`,
    `#`,
    `# NUNCHUK:`,
    `#   Nunchuk imports BSMS (Bitcoin Secure Multisig Setup), not`,
    `#   raw descriptors. Use the BSMS export on the Policy Builder`,
    `#   page when setting up the vault. If you lost that file,`,
    `#   rebuild it from the descriptor via Sparrow's BSMS export.`,
    `#`,
    `# TIMELOCKED PATHS:`,
    `#   Recovery and inheritance paths require tx.lock_time to be`,
    `#   >= the absolute block heights above. Sparrow sets this`,
    `#   automatically when you choose the corresponding leaf.`,
    `# ---------------------------------------------------------------`,
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
