/**
 * legacy-seal.ts -- orchestrates legacy-recovery.ts's crypto primitives
 * against api.ts's storage endpoint. Kept separate from legacy-recovery.ts
 * so that file stays a pure crypto core (no network calls, easy to reason
 * about and test in isolation) and this file stays a thin, obvious
 * wiring layer.
 */

import {
  generateLegacySecret,
  sealBundle,
  splitLegacySecretHybrid,
  deriveLegacyLockBytes,
  deriveLegacyLockBytesFromSignature,
  signLegacyUnlockMessage,
  legacyIdentityPubkeyFromMnemonic,
  lockShare,
  b64,
} from './legacy-recovery';
import type { Network } from './keystore';
import { api } from './api';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface RoleKeyMnemonic {
  /** Stable role id, e.g. "founder_1", "heir_2", "backup_1". */
  keyRole: string;
  mnemonic: string;
  /**
   * This key's account-level BIP32 path (LocalKey.derivationPath), e.g.
   * "m/86'/1'/0'". Used to derive the signature-locked share's identity
   * child (see legacy-recovery.ts's LEGACY_IDENTITY_PATH) -- the same
   * path a hardware wallet would need to reproduce the identical
   * signature later. Optional so callers without a real xpub-bearing key
   * (e.g. a bare in-memory test key) can still seal the mnemonic-only
   * lock; such a share simply gets no signature-based unlock option.
   */
  derivationPath?: string;
}

/**
 * Seals (or reseals) a vault's Legacy Recovery data: encrypts bundleText
 * with a fresh secret, splits that secret into a fast XOR path and a
 * Shamir fallback path across roleKeys, locks every keyholder share to
 * its own role's key, and uploads everything (never anything unlocked
 * except the on-chain share, whose whole purpose is being safe to
 * publish) via api.legacy.seal.
 *
 * Callers are responsible for gathering each role's mnemonic first (see
 * keystore.ts's revealMnemonic) -- this function never touches
 * localStorage or prompts for a password itself.
 *
 * Returns the fresh onchain_share_b64 so the caller can show the "publish
 * on-chain" step immediately, without a second round trip to fetch what
 * was just uploaded. Every seal (first time or reseal) mints a brand new
 * random secret, so any share/txid from a PRIOR seal is now stale -- the
 * caller should also clear any previously-displayed publication txid,
 * since the backend clears it too (see vault-legacy.js's POST handler).
 */
export async function sealVaultLegacyRecovery(opts: {
  vaultId: string;
  network: Network;
  bundleText: string;
  roleKeys: RoleKeyMnemonic[];
}): Promise<{ onchainShareB64: string }> {
  if (opts.roleKeys.length === 0) {
    throw new Error('sealVaultLegacyRecovery: at least one role key is required');
  }

  const secret = generateLegacySecret();
  const sealed = await sealBundle(opts.bundleText, secret);
  const { onChainShare, fastPathShare, fallbackShares } =
    await splitLegacySecretHybrid(secret, opts.roleKeys.length);

  const shares = opts.roleKeys.map((rk, i) => {
    const lockBytes = deriveLegacyLockBytes(rk.mnemonic, opts.network, opts.vaultId, rk.keyRole);
    const base = {
      key_role: rk.keyRole,
      locked_fast_share_b64: b64(lockShare(fastPathShare, lockBytes)),
      locked_fallback_share_b64: b64(lockShare(fallbackShares[i], lockBytes)),
    };
    // Additionally lock the SAME fast-path share with a value derived
    // from a deterministic signature instead of a raw key derivation --
    // the hardware-wallet-compatible unlock path (see legacy-recovery.ts's
    // signLegacyUnlockMessage). Only possible when this key carries a
    // real account-level derivationPath; skip it rather than fail the
    // whole seal for a key that doesn't have one.
    if (!rk.derivationPath) return base;
    const identityPubkeyHex = toHex(legacyIdentityPubkeyFromMnemonic(rk.mnemonic, opts.network, rk.derivationPath));
    const signature = signLegacyUnlockMessage(rk.mnemonic, opts.network, rk.derivationPath, opts.vaultId, rk.keyRole);
    const sigLockBytes = deriveLegacyLockBytesFromSignature(signature, opts.vaultId, rk.keyRole);
    return {
      ...base,
      identity_pubkey_hex: identityPubkeyHex,
      locked_fast_share_sig_b64: b64(lockShare(fastPathShare, sigLockBytes)),
    };
  });

  const onchainShareB64 = b64(onChainShare);
  await api.legacy.seal({
    vault_id: opts.vaultId,
    sealed_bundle: { nonce_b64: sealed.nonceB64, ciphertext_b64: sealed.ciphertextB64 },
    onchain_share_b64: onchainShareB64,
    shares,
  });
  return { onchainShareB64 };
}

/** Maps a Vault's network field ('bitcoin'|'testnet'|'signet') to keystore.ts's Network type ('mainnet'|'testnet'|'signet'). */
export function vaultNetworkToKeystoreNetwork(network: 'testnet' | 'signet' | 'bitcoin'): Network {
  return network === 'bitcoin' ? 'mainnet' : network;
}
