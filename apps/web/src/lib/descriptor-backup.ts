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
  /** Optional fourth/fifth/sixth leaves -- absent on plain founders/heirs
   *  vaults and on older backups' worth of data, so every field here is
   *  optional and defaulted at read time rather than widening the
   *  required shape every caller has to satisfy. */
  protector_keys?: string[];
  protector_quorum?: number | null;
  protector_after?: number | null;
  consent_keys?: string[];
  consent_quorum?: number | null;
  backup_keys?: string[];
  backup_quorum?: number | null;
  second_heir_keys?: string[];
  second_heir_quorum?: number | null;
  second_inheritance_after?: number | null;
}

export function vaultBackupText(v: VaultBackupLike): string {
  const protectorKeys = v.protector_keys ?? [];
  const hasProtector = protectorKeys.length > 0 && v.protector_quorum != null && v.protector_after != null;
  const consentKeys = v.consent_keys ?? [];
  const hasConsent = consentKeys.length > 0 && v.consent_quorum != null;
  const backupKeys = v.backup_keys ?? [];
  const hasBackup = backupKeys.length > 0 && v.backup_quorum != null;
  const secondHeirKeys = v.second_heir_keys ?? [];
  const hasSecondInheritance =
    secondHeirKeys.length > 0 && v.second_heir_quorum != null && v.second_inheritance_after != null;

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
    `Founders:       ${v.founder_quorum} of ${v.founder_keys.length} -- no waiting`,
    ...(hasConsent ? [`  + beneficiary consent: ${v.consent_quorum} of ${consentKeys.length} (required on every founders spend)`] : []),
    ...(hasBackup
      ? [`Backup:         ${v.backup_quorum} of ${backupKeys.length} -- separate key set, no waiting`]
      : [`Recovery after: ${v.recovery_after.toLocaleString()} blocks -- same founder keys as above`]),
    `Heirs:          ${v.heir_quorum} of ${v.heir_keys.length}`,
    `Inheritance after: ${v.inheritance_after.toLocaleString()} blocks`,
    ...(hasProtector ? [`Protector:      ${v.protector_quorum} of ${protectorKeys.length} -- after ${v.protector_after!.toLocaleString()} blocks`] : []),
    ...(hasSecondInheritance
      ? [`Second inheritance: ${v.second_heir_quorum} of ${secondHeirKeys.length} -- after ${v.second_inheritance_after!.toLocaleString()} blocks (independent heir group)`]
      : []),
    ``,
    `# Founder xpubs`,
    ...v.founder_keys,
    ``,
    `# Heir xpubs`,
    ...v.heir_keys,
    ...(hasProtector ? [``, `# Protector xpubs`, ...protectorKeys] : []),
    ...(hasConsent ? [``, `# Beneficiary-consent xpubs`, ...consentKeys] : []),
    ...(hasBackup ? [``, `# Backup xpubs (separate from founders -- keep these apart)`, ...backupKeys] : []),
    ...(hasSecondInheritance ? [``, `# Second inheritance xpubs (independent heir group)`, ...secondHeirKeys] : []),
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
