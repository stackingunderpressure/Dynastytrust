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
  lockShare,
  b64,
} from './legacy-recovery';
import type { Network } from './keystore';
import { api } from './api';

export interface RoleKeyMnemonic {
  /** Stable role id, e.g. "founder_1", "heir_2", "backup_1". */
  keyRole: string;
  mnemonic: string;
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
 */
export async function sealVaultLegacyRecovery(opts: {
  vaultId: string;
  network: Network;
  bundleText: string;
  roleKeys: RoleKeyMnemonic[];
}): Promise<void> {
  if (opts.roleKeys.length === 0) {
    throw new Error('sealVaultLegacyRecovery: at least one role key is required');
  }

  const secret = generateLegacySecret();
  const sealed = await sealBundle(opts.bundleText, secret);
  const { onChainShare, fastPathShare, fallbackShares } =
    await splitLegacySecretHybrid(secret, opts.roleKeys.length);

  const shares = opts.roleKeys.map((rk, i) => {
    const lockBytes = deriveLegacyLockBytes(rk.mnemonic, opts.network, opts.vaultId, rk.keyRole);
    return {
      key_role: rk.keyRole,
      locked_fast_share_b64: b64(lockShare(fastPathShare, lockBytes)),
      locked_fallback_share_b64: b64(lockShare(fallbackShares[i], lockBytes)),
    };
  });

  await api.legacy.seal({
    vault_id: opts.vaultId,
    sealed_bundle: { nonce_b64: sealed.nonceB64, ciphertext_b64: sealed.ciphertextB64 },
    onchain_share_b64: b64(onChainShare),
    shares,
  });
}

/** Maps a Vault's network field ('bitcoin'|'testnet'|'signet') to keystore.ts's Network type ('mainnet'|'testnet'|'signet'). */
export function vaultNetworkToKeystoreNetwork(network: 'testnet' | 'signet' | 'bitcoin'): Network {
  return network === 'bitcoin' ? 'mainnet' : network;
}
