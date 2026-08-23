/**
 * legacy-recovery-progress.ts -- durable, per-vault-per-role UI state for
 * the Legacy Recovery seal/publish flow (LegacyRecoverySetup.tsx).
 *
 * Every field in LegacyOnChainV2Card used to be plain useState, wiped the
 * instant the page unmounted -- navigate away, refresh, close the tab.
 * Operator: "it seems like it just disappears and then acts like you need
 * to do it again." None of the crypto MECHANISM itself needs a database
 * (see legacy-onchain-recovery.ts's header -- "the chain IS the storage"),
 * but the UI's own progress -- which key, which address, the already-
 * sealed payload, a built-but-not-yet-broadcast transaction -- has no
 * reason to vanish on every reload. This module persists that progress to
 * localStorage, scoped per vault + per role slot, so coming back to the
 * page later shows exactly where things were left off, until explicitly
 * cleared.
 *
 * Deliberately NEVER persists secret material: no password, no revealed
 * mnemonic (revealMnemonic already reads from keystore.ts's own durable,
 * encrypted store -- this module never touches that), and no pasted
 * hardware signature. A signature is the exact input
 * deriveLegacyOnChainKey turns into the AES decryption key -- keeping one
 * around next to its already-persisted nonce and ciphertext would let
 * anyone with browser storage access decrypt the sealed payload without
 * ever needing the real key again, which defeats the whole "recovery
 * needs the actual seed" property this mechanism is built on. Once a seal
 * succeeds, the signature that produced it is dropped -- payloadHex is
 * the artifact that matters from then on, and it's already meant to be
 * published publicly anyway.
 */

import type { BuiltPublishTx } from './onchain-publish';

export interface LegacyRecoveryProgress {
  mode: 'software' | 'hardware';
  keyId?: string;
  hwXpub?: string;
  address?: string;
  hwNonceB64?: string;
  payloadHex?: string;
  billboardKeyId?: string;
  billboardAmount?: string;
  utxoTxid?: string;
  utxoVout?: string;
  utxoValue?: string;
  feeRate?: string;
  builtTx?: BuiltPublishTx;
  broadcastTxid?: string;
  updatedAt: string;
}

function storageKey(vaultId: string, role: string): string {
  return `dynastytrust:legacy-recovery:${vaultId}:${role}`;
}

export function loadLegacyRecoveryProgress(vaultId: string, role: string): LegacyRecoveryProgress | null {
  try {
    const raw = localStorage.getItem(storageKey(vaultId, role));
    return raw ? (JSON.parse(raw) as LegacyRecoveryProgress) : null;
  } catch {
    return null;
  }
}

export function saveLegacyRecoveryProgress(
  vaultId: string,
  role: string,
  progress: Omit<LegacyRecoveryProgress, 'updatedAt'>,
): void {
  try {
    localStorage.setItem(
      storageKey(vaultId, role),
      JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // localStorage can throw (private browsing, quota exceeded) -- the
    // flow still works for the rest of this session, it just won't
    // survive a reload. Not worth surfacing as an error for what is
    // purely a convenience/durability feature, not the recovery
    // mechanism itself.
  }
}

export function clearLegacyRecoveryProgress(vaultId: string, role: string): void {
  try {
    localStorage.removeItem(storageKey(vaultId, role));
  } catch {
    // same as above
  }
}
