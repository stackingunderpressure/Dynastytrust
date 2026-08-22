/**
 * descriptor-backup.ts -- write a human-readable .txt backup of a
 * compiled vault's descriptor + parameters.
 *
 * The descriptor alone is enough to reconstruct addresses and monitor
 * a vault from any Bitcoin wallet that supports miniscript (Sparrow,
 * Nunchuk, Bitcoin Core). Combined with one party's mnemonic + the
 * policy parameters, it's enough to spend. So every member should
 * have this file on paper / in cold storage / on a USB.
 *
 * 2026-08-13 addition (operator: "make sure everything's labeled
 * really good... this is the main vault, this is the trenches" --
 * followed by "let's build the tranche backup export"): Tranche
 * distribution wallets had NO backup export at all -- a family who
 * only ever downloaded the main vault's backup and never realized a
 * Tranche wallet is a separate thing with its own addresses would
 * have had no paper trail for real funds sitting in those tranches.
 * distributionWalletBackupText / downloadDistributionWalletBackup
 * below close that gap, following the same pattern as the vault
 * backup above -- labeled, self-contained, instructions included --
 * but explicitly stamped as a CHILD of the parent vault, since a
 * family holding several of these files needs to tell them apart.
 */

import type { Vault, DistributionWallet } from './api';

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
  /** Optional fourth/fifth leaves -- absent on plain founders/heirs
   *  vaults and on older backups' worth of data, so every field here is
   *  optional and defaulted at read time rather than widening the
   *  required shape every caller has to satisfy. */
  consent_keys?: string[];
  consent_quorum?: number | null;
  backup_keys?: string[];
  backup_quorum?: number | null;
  second_heir_keys?: string[];
  second_heir_quorum?: number | null;
  second_inheritance_after?: number | null;
}

export function vaultBackupText(v: VaultBackupLike): string {
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
    ...(hasSecondInheritance
      ? [`Second inheritance: ${v.second_heir_quorum} of ${secondHeirKeys.length} -- after ${v.second_inheritance_after!.toLocaleString()} blocks (independent heir group)`]
      : []),
    ``,
    `# Founder xpubs`,
    ...v.founder_keys,
    ``,
    `# Heir xpubs`,
    ...v.heir_keys,
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
    `#   raw descriptors, and DynastyTrust does not export BSMS`,
    `#   directly. Import the descriptor above into Sparrow first`,
    `#   (File > Import Wallet > paste descriptor), then use Sparrow's`,
    `#   own File > Export Wallet > BSMS to hand off to Nunchuk.`,
    `#`,
    `# TIMELOCKED PATHS:`,
    `#   Recovery and inheritance paths require tx.lock_time to be`,
    `#   >= the absolute block heights above. Sparrow sets this`,
    `#   automatically when you choose the corresponding leaf.`,
    `#`,
    `# LEGACY RECOVERY (long-horizon descriptor recovery):`,
    `#   If a keyholder here published a Legacy Recovery share for their`,
    `#   key, an encrypted copy of this exact descriptor already lives`,
    `#   permanently on the Bitcoin blockchain, tied to their own key --`,
    `#   no separate secret to protect, and it works even if DynastyTrust`,
    `#   is unreachable. Recover it with the standalone tool at`,
    `#   /dynastytrust-legacy-recovery-tool.html (save a copy of that`,
    `#   page itself -- it runs fully offline, in any browser, with`,
    `#   nothing else installed).`,
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

/**
 * Legacy Recovery's downloadable takeaway note (see
 * legacy-onchain-recovery.ts's header for the mechanism). There is no
 * secret in this file at all -- the address and derivation path are
 * both public, safe-to-publish values by design. That's the whole point
 * of the hardened derivation path: nobody who only has this note, this
 * vault's xpubs, or its descriptor can compute or watch for this
 * address; only the actual seed can. There is deliberately no "message
 * to sign" or vault index printed here -- the exact bytes to sign are
 * read straight off the on-chain transaction at recovery time (see the
 * instructions below), not memorized or transcribed ahead of time, and
 * this key's on-chain address is the same single one for every vault
 * this seed ever publishes Legacy Recovery for, so there is no index to
 * write down or get wrong either.
 */
export interface LegacyOnChainRecoveryNoteLike {
  vaultName: string;
  network: 'testnet' | 'signet' | 'bitcoin';
  roleLabel: string;
  address: string;
  derivationPath: string;
  txid: string | null;
}

export function legacyOnChainRecoveryNoteText(n: LegacyOnChainRecoveryNoteLike): string {
  const lines = [
    `# DynastyTrust Legacy Recovery -- on-chain recovery note`,
    `# Vault: ${n.vaultName}`,
    `# This key's role: ${n.roleLabel}`,
    `# Network: ${n.network}`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
    `# WHAT THIS IS`,
    `# Nothing below is secret. This note just says where to look --`,
    `# the encrypted descriptor itself already lives permanently on the`,
    `# Bitcoin blockchain. Combined with your own seed phrase (never`,
    `# written here -- keep that in your existing separate cold`,
    `# storage, or use a hardware wallet's own "Sign Message" feature`,
    `# so the seed never has to be typed into anything), this is`,
    `# everything needed to recover the full descriptor, decades from`,
    `# now, with no other key, no share to combine with anyone else's,`,
    `# and no DynastyTrust account required.`,
    ``,
    `# HOW TO RECOVER`,
    `# 1. Go to DynastyTrust's "Retrieve a descriptor" page (or the`,
    `#    standalone offline recovery tool -- save a copy of it now,`,
    `#    it runs fully offline).`,
    `# 2. Enter the address below and check the chain -- it finds the`,
    `#    on-chain transaction and shows you the EXACT bytes to sign.`,
    `#    There is nothing to remember or transcribe: the tool reads`,
    `#    it straight off the transaction it just found.`,
    `# 3. Sign what it shows you with this same key, at derivation`,
    `#    path ${n.derivationPath} -- the CLASSIC message-signing method`,
    `#    (plain ECDSA), not BIP-322 or a Taproot-address signature. Most`,
    `#    hardware wallets' "Sign Message" feature does this natively.`,
    `# 4. Paste the signature. That's it -- no combining, no second key,`,
    `#    no number to remember.`,
    ``,
    `Address:          ${n.address}`,
    `Derivation path:  ${n.derivationPath}`,
    ...(n.txid ? [``, `On-chain publish transaction: ${n.txid}`] : []),
    ``,
    `# This note alone recovers nothing -- it only works together with`,
    `# the one key that can actually sign at the path above.`,
    ``,
  ];
  return lines.join('\n');
}

export function downloadLegacyOnChainRecoveryNote(n: LegacyOnChainRecoveryNoteLike): void {
  const safeVault = n.vaultName.replace(/[^a-z0-9\-_]+/gi, '_').toLowerCase() || 'vault';
  const safeRole = n.roleLabel.replace(/[^a-z0-9\-_]+/gi, '_').toLowerCase() || 'key';
  const blob = new Blob([legacyOnChainRecoveryNoteText(n)], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `dynastytrust-${safeVault}-${safeRole}-legacy-recovery.txt`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Human-readable .txt backup for one Tranche distribution wallet.
 * Every tranche has its OWN address and descriptor (a separate
 * Taproot output per unlock date -- see build_tranche in
 * protocol/src/policy_compiler.rs), so unlike the single-descriptor
 * vault backup above, this has to enumerate every tranche in full.
 */
export function distributionWalletBackupText(
  w: DistributionWallet,
  parentVaultName: string,
): string {
  const lines = [
    `# DynastyTrust TRANCHE DISTRIBUTION WALLET backup`,
    `# This is a CHILD wallet of the vault "${parentVaultName}" -- it is`,
    `# NOT the main vault. It holds its own separate funds across`,
    `# ${w.tranches.length} independent Bitcoin outputs, one per scheduled unlock date.`,
    `#`,
    `# Distribution wallet name: ${w.name}`,
    ...(w.beneficiary_name ? [`# Beneficiary: ${w.beneficiary_name}`] : []),
    `# Network: ${w.network}`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
    `# Beneficiary key (spends each tranche ALONE, but only after that`,
    `# tranche's own unlock block -- see the per-tranche list below)`,
    `Beneficiary xpub:    ${w.beneficiary_xpub}`,
    `Beneficiary pubkey:  ${w.beneficiary_pubkey}`,
    ``,
    `# Trustee escape hatch (spends ANY tranche at ANY time, before or`,
    `# after its unlock block -- for correcting mistakes or handling an`,
    `# emergency, not routine use)`,
    `Trustee quorum: ${w.trustee_quorum} of ${w.trustee_keys.length}`,
    ...w.trustee_keys,
    ``,
    ...(w.key_origins.length > 0
      ? [
          `# Key origins (fingerprint + derivation path, for hardware`,
          `# wallets to recognize their own key on a leaf)`,
          ...w.key_origins.map(o => `${o.pubkey}  fp=${o.fingerprint}  path=${o.derivation_path}`),
          ``,
        ]
      : []),
    `# ---------------------------------------------------------------`,
    `# TRANCHES (${w.tranches.length} total, ${(
      w.tranches.reduce((n, t) => n + t.amount_sats, 0) / 1e8
    ).toFixed(8)} BTC combined)`,
    `# ---------------------------------------------------------------`,
    ``,
    ...w.tranches.flatMap(t => [
      `## Tranche #${t.index + 1}${t.label ? ` -- ${t.label}` : ''}`,
      `Unlocks at block: ${t.unlock_block.toLocaleString()}`,
      `Amount:            ${(t.amount_sats / 1e8).toFixed(8)} BTC (${t.amount_sats} sats)`,
      `Address:           ${t.address}`,
      `Descriptor:        ${t.descriptor}`,
      `Funded:            ${t.funded_txid ?? '(not yet funded)'}`,
      `Claimed:           ${t.claimed_txid ?? '(not yet claimed)'}`,
      ``,
    ]),
    `# ---------------------------------------------------------------`,
    `# RECOVERY INSTRUCTIONS (if DynastyTrust ever goes offline)`,
    `# ---------------------------------------------------------------`,
    `# Each tranche above is its OWN independent Bitcoin output with`,
    `# its own descriptor -- import each one separately into Sparrow`,
    `# (or another miniscript-aware wallet) the same way you would the`,
    `# main vault's descriptor: File > Import Wallet > paste the`,
    `# descriptor for that specific tranche.`,
    `#`,
    `# Two ways to spend a given tranche:`,
    `#   1. BENEFICIARY (routine): the beneficiary's own key alone can`,
    `#      spend that tranche, once the chain tip reaches its`,
    `#      "Unlocks at block" height above -- not before.`,
    `#   2. TRUSTEES (escape hatch): ${w.trustee_quorum} of the ${w.trustee_keys.length} trustee keys`,
    `#      can spend that tranche at ANY time, unlock date or not --`,
    `#      meant for correcting a mistake or handling an emergency,`,
    `#      not for routine distributions.`,
    `#`,
    `# This file does not include anyone's seed phrase. You need the`,
    `# beneficiary's OR enough trustees' seed phrases (metal backup),`,
    `# stored separately, combined with the descriptor for the specific`,
    `# tranche above, to actually recover and spend those funds.`,
    `# ---------------------------------------------------------------`,
    ``,
  ];
  return lines.join('\n');
}

export function downloadDistributionWalletBackup(
  w: DistributionWallet,
  parentVaultName: string,
): void {
  const safeVaultName = parentVaultName.replace(/[^a-z0-9\-_]+/gi, '_').toLowerCase() || 'vault';
  const safeWalletName = w.name.replace(/[^a-z0-9\-_]+/gi, '_').toLowerCase() || 'tranche-wallet';
  const blob = new Blob([distributionWalletBackupText(w, parentVaultName)], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `dynastytrust-${safeVaultName}-${safeWalletName}-${w.network}-backup.txt`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}
