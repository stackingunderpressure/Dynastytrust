/**
 * vault-spending-paths.ts -- the ONE place that turns a vault row (either
 * shape) into "here are the real spending paths, their keys, and their
 * quorums." Every other computation of this -- Dashboard's card summary,
 * VaultDetail's phase/role text, the Send tab's path picker, ProposalDetail's
 * signer discovery, invite lookups, reminder banners, the governance/audit
 * Netlify functions -- either already calls this or should be migrated to.
 *
 * WHY THIS EXISTS (2026-08-25): a leaf-list vault never populates the
 * named-field columns (founder_keys, founder_quorum, heir_keys, heir_quorum,
 * recovery_after, inheritance_after, backup_keys, backup_quorum,
 * second_heir_keys, second_heir_quorum, second_inheritance_after) -- they
 * sit at their bare DB defaults. Reading those columns directly, without
 * first checking `Array.isArray(vault.leaves) && vault.leaves.length > 0`,
 * produces bogus output for a leaf-list vault: "2 of 0 signatures required,"
 * a recovery countdown from a block height nobody configured, a Send-tab
 * path the compiler has never heard of, a governance endpoint reporting
 * "all paths unlocked" for a vault that's still fully timelocked. This bug
 * class was independently reintroduced in eight-plus separate files across
 * this session because each one re-derived "what are this vault's spending
 * paths" from scratch instead of calling one shared, tested function. This
 * module -- and its byte-for-byte-bound Netlify-functions twin,
 * netlify/functions/_vault-shape.js (see scripts/test-vault-spending-paths.mjs,
 * which asserts the two never drift) -- is the fix for the RECURRING pattern,
 * not just the latest instance of it.
 *
 * A Bloc vault (vault.bloc_policy != null) has its own, structurally
 * different four-path shape (parents_now / coparent_kids / parent_solo /
 * kids_decay) and is deliberately OUT OF SCOPE here -- see
 * VaultDetail.tsx's BlocOverviewTab and psbt-binary-bloc.js, which already
 * isolate Bloc into its own code path for exactly this reason (a shared
 * founders/heirs-shaped reader renders nonsense against Bloc's fields).
 * Call sites should check `vault.bloc_policy != null` FIRST and route to
 * their own Bloc-specific logic before ever reaching this module.
 */

export type SpendingPathUnlockType = 'immediate' | 'after' | 'older';

export interface SpendingPathSummary {
  /** The vault's own leaf id for a leaf-list vault; one of
   *  "founders_now" | "recovery" | "inheritance" | "backup" |
   *  "second_inheritance" for the named-field shape -- this is exactly
   *  the string every path/proposal.path column already uses. */
  id: string;
  label: string;
  quorum: number;
  keyCount: number;
  /** Pubkey-hex or xpub strings, whichever the vault actually stores. */
  keys: string[];
  unlockType: SpendingPathUnlockType;
  /** Absolute CLTV block height for 'after'; a relative CSV duration for
   *  'older'; 0 for 'immediate' (never spendable-by-height, always now). */
  unlockBlocks: number;
}

/** Structural subset of Vault (see api.ts) this module actually reads --
 *  duck-typed so callers can pass either a full Vault or a narrower
 *  Supabase row selecting only these columns. */
export interface VaultShapeLike {
  leaves?: {
    id: string;
    label: string;
    keys: string[];
    quorum: number;
    unlock: { type: 'immediate' } | { type: 'after'; blocks: number } | { type: 'older'; blocks: number };
  }[] | null;
  founder_keys?: string[] | null;
  founder_quorum?: number | null;
  heir_keys?: string[] | null;
  heir_quorum?: number | null;
  recovery_after?: number | null;
  recovery_quorum?: number | null;
  inheritance_after?: number | null;
  backup_keys?: string[] | null;
  backup_quorum?: number | null;
  second_heir_keys?: string[] | null;
  second_heir_quorum?: number | null;
  second_inheritance_after?: number | null;
}

export function isLeafListVault(vault: VaultShapeLike): boolean {
  return Array.isArray(vault.leaves) && vault.leaves.length > 0;
}

/**
 * The real spending paths for a founders/heirs-shaped OR leaf-list vault.
 * Never call this for a Bloc vault (vault.bloc_policy != null) -- check
 * that first and use Bloc's own path logic instead.
 *
 * For the named-field shape, mirrors the exact presence rules SendTab
 * already established (hasRecovery/hasInheritance/hasBackup/
 * hasSecondInheritance): founders_now is always present; the other four
 * only appear once their leaf is actually configured, so a vault that
 * never set up a backup or second-inheritance leaf doesn't get a phantom
 * entry for it.
 */
export function getSpendingPaths(vault: VaultShapeLike): SpendingPathSummary[] {
  if (isLeafListVault(vault)) {
    return vault.leaves!.map((leaf) => ({
      id: leaf.id,
      label: leaf.label || leaf.id,
      quorum: leaf.quorum,
      keyCount: leaf.keys.length,
      keys: leaf.keys,
      unlockType: leaf.unlock.type,
      unlockBlocks: leaf.unlock.type === 'immediate' ? 0 : leaf.unlock.blocks,
    }));
  }

  const founderKeys = vault.founder_keys ?? [];
  const founderQuorum = vault.founder_quorum ?? 0;
  const heirKeys = vault.heir_keys ?? [];
  const heirQuorum = vault.heir_quorum ?? 0;
  const recoveryAfter = vault.recovery_after ?? 0;
  const inheritanceAfter = vault.inheritance_after ?? 0;
  const backupKeys = vault.backup_keys ?? [];
  const secondHeirKeys = vault.second_heir_keys ?? [];

  const paths: SpendingPathSummary[] = [
    {
      id: 'founders_now',
      label: 'Founders now',
      quorum: founderQuorum,
      keyCount: founderKeys.length,
      keys: founderKeys,
      unlockType: 'immediate',
      unlockBlocks: 0,
    },
  ];

  if (recoveryAfter > 0) {
    paths.push({
      id: 'recovery',
      label: 'Recovery',
      quorum: vault.recovery_quorum ?? founderQuorum,
      keyCount: founderKeys.length,
      keys: founderKeys,
      unlockType: 'after',
      unlockBlocks: recoveryAfter,
    });
  }

  if (heirKeys.length > 0 && inheritanceAfter > 0) {
    paths.push({
      id: 'inheritance',
      label: 'Inheritance',
      quorum: heirQuorum,
      keyCount: heirKeys.length,
      keys: heirKeys,
      unlockType: 'after',
      unlockBlocks: inheritanceAfter,
    });
  }

  if (backupKeys.length > 0 && vault.backup_quorum != null) {
    paths.push({
      id: 'backup',
      label: 'Backup',
      quorum: vault.backup_quorum,
      keyCount: backupKeys.length,
      keys: backupKeys,
      unlockType: 'immediate',
      unlockBlocks: 0,
    });
  }

  if (secondHeirKeys.length > 0 && vault.second_heir_quorum != null && vault.second_inheritance_after != null) {
    paths.push({
      id: 'second_inheritance',
      label: 'Second inheritance',
      quorum: vault.second_heir_quorum,
      keyCount: secondHeirKeys.length,
      keys: secondHeirKeys,
      unlockType: 'after',
      unlockBlocks: vault.second_inheritance_after,
    });
  }

  return paths;
}

/** Look up one path by id (a leaf's own id, or a named-field path id) --
 *  the shape most single-path call sites (ProposalDetail's signer
 *  discovery, psbt-merge's quorum check, RotateVaultModal's prefill) need. */
export function findSpendingPath(vault: VaultShapeLike, pathId: string): SpendingPathSummary | undefined {
  return getSpendingPaths(vault).find((p) => p.id === pathId);
}
