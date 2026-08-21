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
    `#   If this vault's owner sealed Legacy Recovery for your key, you`,
    `#   have a locked copy of this exact descriptor tied to your own`,
    `#   key -- no separate secret to protect, and it works even if`,
    `#   DynastyTrust is unreachable. Recover it with the standalone`,
    `#   tool at /dynastytrust-legacy-recovery-tool.html (save a copy`,
    `#   of that page itself -- it runs fully offline, in any browser,`,
    `#   with nothing else installed).`,
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
 * Human-readable .txt recovery package for ONE keyholder's sealed Legacy
 * Recovery share (see legacy-recovery.ts's header for the underlying
 * mechanism). Operator, 2026-08-19, on why this needs to exist: "I just
 * feel like it's all too much to put on the user still... I want it
 * handed to them with explicit instructions on how to safely backup the
 * descriptor." Sealing (LegacyRecoverySetup.tsx) only ever POSTs this
 * data to Supabase -- nothing was ever handed to the keyholder directly,
 * so recovering later meant depending on DynastyTrust's own database
 * remembering it, exactly the dependency this feature exists to avoid.
 * This function turns what's already sealed into a self-contained
 * takeaway file: everything needed to recover, EXCEPT the keyholder's own
 * seed phrase (never written to a file -- they already have that in
 * their own separate cold storage, and typing it into the standalone
 * tool at recovery time is the one manual step that has to stay manual).
 */
export interface LegacyRecoveryPackageLike {
  vaultId: string;
  vaultName: string;
  network: 'testnet' | 'signet' | 'bitcoin';
  keyRole: string;
  roleLabel: string;
  lockedFastShareB64: string;
  lockedFallbackShareB64: string;
  identityPubkeyHex: string | null;
  lockedFastShareSigB64: string | null;
  bundle: { nonceB64: string; ciphertextB64: string };
  onchain: { onchainShareB64: string; txid: string | null } | null;
  /**
   * descriptorFingerprint(descriptor) (legacy-recovery.ts) AT THE MOMENT
   * this package was sealed, plus when. Null/null for a package sealed
   * before this field existed (2026-08-20). Purely a label -- if this
   * vault is ever recompiled (new keys, same shape) after sealing, this
   * package still recovers the OLD descriptor correctly; the fingerprint
   * just lets whoever opens this file, possibly decades from now with no
   * DynastyTrust left to ask, see which version of the vault they're
   * holding a key to before assuming it still matches anything live.
   */
  descriptorFingerprint: string | null;
  sealedAt: string | null;
}

export function legacyRecoveryPackageText(p: LegacyRecoveryPackageLike): string {
  const lines = [
    `# DynastyTrust Legacy Recovery package`,
    `# Vault: ${p.vaultName}`,
    `# This key's role: ${p.roleLabel}`,
    `# Network: ${p.network}`,
    `# Generated: ${new Date().toISOString()}`,
    `# Descriptor version this package was sealed for: ${p.descriptorFingerprint ?? '(unknown -- sealed before this label existed)'}`,
    `# Sealed on: ${p.sealedAt ?? '(unknown)'}`,
    ``,
    `# IMPORTANT -- if this vault is ever recompiled after this package was`,
    `# sealed (a key rotation, a new leaf -- anything that changes the`,
    `# vault's descriptor), THIS package still correctly recovers the`,
    `# descriptor version stamped above, never a wrong one -- but it may no`,
    `# longer be the vault's CURRENT descriptor. If DynastyTrust is still`,
    `# reachable, compare the version stamp above against this vault's`,
    `# Legacy Recovery page before trusting a recovered descriptor to`,
    `# reflect where funds actually are today. If it isn't reachable, treat`,
    `# a recovered descriptor as "definitely valid for this version, not`,
    `# guaranteed to be the vault's most recent one."`,
    ``,
    `# WHAT THIS IS`,
    `# A sealed, permanent copy of this vault's descriptor, locked so`,
    `# only THIS key can ever open it -- no DynastyTrust account, no`,
    `# vault ID to remember, no database lookup required. This file`,
    `# plus your own seed phrase (never written here -- keep that in`,
    `# your existing separate cold storage) is everything this key`,
    `# needs to recover the full descriptor, decades from now, even if`,
    `# DynastyTrust itself no longer exists.`,
    ``,
    `# HOW TO RECOVER -- three things, combined`,
    `# 1. Your seed phrase (yours already, type it in at recovery time,`,
    `#    never paste it anywhere it could be saved or transmitted).`,
    `# 2. The locked share below -- useless without your seed phrase,`,
    `#    safe to keep alongside this file.`,
    `# 3. The on-chain share below -- published permanently to the`,
    `#    Bitcoin blockchain, so it survives independent of any single`,
    `#    copy of this file.`,
    `# Open /dynastytrust-legacy-recovery-tool.html (save your own copy`,
    `# now -- it runs fully offline, in any browser, with nothing else`,
    `# installed) and paste the fields below into its Fast Path tab.`,
    ``,
    `# ---------------------------------------------------------------`,
    `# FIELDS FOR THE STANDALONE TOOL'S "FAST PATH" TAB`,
    `# ---------------------------------------------------------------`,
    `Vault ID:      ${p.vaultId}`,
    `Key role:      ${p.keyRole}`,
    `Network:       ${p.network === 'bitcoin' ? 'mainnet' : p.network}`,
    `Locked share:  ${p.lockedFastShareB64}`,
    p.onchain
      ? `On-chain share: ${p.onchain.onchainShareB64}`
      : `On-chain share: (not published yet -- ask the vault owner to publish it, or use the fallback path below with a second keyholder's own package)`,
    `Nonce:         ${p.bundle.nonceB64}`,
    `Ciphertext:    ${p.bundle.ciphertextB64}`,
    ...(p.onchain?.txid
      ? [`On-chain publish transaction: ${p.onchain.txid}`]
      : []),
    ``,
    `# ---------------------------------------------------------------`,
    `# FALLBACK PATH -- if the on-chain share is ever unavailable`,
    `# ---------------------------------------------------------------`,
    `# Any TWO keyholders' own packages, combined via the standalone`,
    `# tool's "Fallback Path" tab, recover the same descriptor without`,
    `# needing the on-chain share at all -- real (2, N) Shamir math,`,
    `# not a shortcut. This role's fallback share:`,
    `Fallback share: ${p.lockedFallbackShareB64}`,
    ``,
    ...(p.identityPubkeyHex && p.lockedFastShareSigB64
      ? [
          `# ---------------------------------------------------------------`,
          `# SIGNATURE-BASED UNLOCK -- for a key that only ever lives on a`,
          `# hardware wallet, no seed phrase typed into anything, ever`,
          `# ---------------------------------------------------------------`,
          `# Works fully offline too, in the standalone tool's "Fast Path`,
          `# (signature)" tab: sign the message it shows you (the CLASSIC`,
          `# message-signing method, not BIP-322 or Taproot-address`,
          `# signing) with your hardware wallet's own "Sign Message"`,
          `# feature, against derivation path <your account>/1/0, paste`,
          `# the signature plus the fields below, and recover.`,
          `#`,
          `# Or, if DynastyTrust is still running: paste your account xpub`,
          `# into its "Retrieve a descriptor" page and it finds this exact`,
          `# share automatically -- same signature, no fields to copy by`,
          `# hand. This identity pubkey confirms the match either way:`,
          `Identity pubkey: ${p.identityPubkeyHex}`,
          `Signature-locked share: ${p.lockedFastShareSigB64}`,
          ``,
        ]
      : []),
    `# ---------------------------------------------------------------`,
    `# This file alone never exposes the descriptor -- it's still`,
    `# locked to your key. Losing it only matters if it falls into the`,
    `# hands of someone who ALSO has your seed phrase, the same as any`,
    `# other backup of yours.`,
    `# ---------------------------------------------------------------`,
    ``,
  ];
  return lines.join('\n');
}

export function downloadLegacyRecoveryPackage(p: LegacyRecoveryPackageLike): void {
  const safeVault = p.vaultName.replace(/[^a-z0-9\-_]+/gi, '_').toLowerCase() || 'vault';
  const safeRole = p.keyRole.replace(/[^a-z0-9\-_]+/gi, '_').toLowerCase() || 'key';
  const blob = new Blob([legacyRecoveryPackageText(p)], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `dynastytrust-${safeVault}-${safeRole}-legacy-recovery.txt`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Legacy Recovery v2's downloadable takeaway note (see
 * legacy-onchain-recovery.ts's header for the mechanism). Unlike
 * LegacyRecoveryPackageLike above, there is no secret in this file at
 * all -- the address, derivation path, and vault index are all public,
 * safe-to-publish values by design. That's the whole point of the fully
 * hardened derivation path: nobody who only has this note, this vault's
 * xpubs, or its descriptor can compute or watch for this address; only
 * the actual seed can. This note exists purely so a keyholder has
 * something durable to keep alongside their seed phrase, rather than
 * having to remember an arbitrary vault index and re-derive everything
 * from scratch decades later.
 */
export interface LegacyOnChainRecoveryNoteLike {
  vaultName: string;
  network: 'testnet' | 'signet' | 'bitcoin';
  roleLabel: string;
  vaultIndex: number;
  address: string;
  derivationPath: string;
  unlockMessage: string;
  txid: string | null;
}

export function legacyOnChainRecoveryNoteText(n: LegacyOnChainRecoveryNoteLike): string {
  const lines = [
    `# DynastyTrust Legacy Recovery v2 -- on-chain recovery note`,
    `# Vault: ${n.vaultName}`,
    `# This key's role: ${n.roleLabel}`,
    `# Network: ${n.network}`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
    `# WHAT THIS IS`,
    `# Nothing below is secret. This note just says where to look and`,
    `# what to sign -- the encrypted descriptor itself already lives`,
    `# permanently on the Bitcoin blockchain. Combined with your own`,
    `# seed phrase (never written here -- keep that in your existing`,
    `# separate cold storage, or use a hardware wallet's own "Sign`,
    `# Message" feature so the seed never has to be typed into anything),`,
    `# this is everything needed to recover the full descriptor, decades`,
    `# from now, with no other key, no share to combine with anyone`,
    `# else's, and no DynastyTrust account required.`,
    ``,
    `# HOW TO RECOVER`,
    `# 1. Go to DynastyTrust's "Retrieve a descriptor" page and open the`,
    `#    "Sign to recover" section (or the standalone offline recovery`,
    `#    tool, once it supports this path).`,
    `# 2. Enter the address and vault index below.`,
    `# 3. Sign the exact message below with this same key, at derivation`,
    `#    path ${n.derivationPath} -- the CLASSIC message-signing method`,
    `#    (plain ECDSA), not BIP-322 or a Taproot-address signature. Most`,
    `#    hardware wallets' "Sign Message" feature does this natively,`,
    `#    against a custom derivation path.`,
    `# 4. Paste the signature. That's it -- no combining, no second key.`,
    ``,
    `Vault index:      ${n.vaultIndex}`,
    `Address:          ${n.address}`,
    `Derivation path:  ${n.derivationPath}`,
    `Message to sign:`,
    n.unlockMessage,
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
    download: `dynastytrust-${safeVault}-${safeRole}-legacy-recovery-v2.txt`,
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
