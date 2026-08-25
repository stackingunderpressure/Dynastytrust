/**
 * _vault-shape.js -- the ONE place a Netlify function turns a vault row
 * into "here are the real spending paths, their keys, and their quorums."
 *
 * Byte-for-byte-bound twin of apps/web/src/lib/vault-spending-paths.ts --
 * see that file's header comment for the full "why this exists" story
 * (a leaf-list vault never populates the named-field columns, and eight-
 * plus files across this repo independently re-derived "what are this
 * vault's spending paths" and got it wrong for that shape). This copy
 * exists because Netlify functions are plain Node ESM and don't import
 * the Vite-bundled frontend app; scripts/test-vault-spending-paths.mjs
 * runs both implementations against the same fixtures and asserts
 * identical output, so the two can never silently drift the way eight
 * independent hand-written copies already did.
 *
 * A Bloc vault (vault.bloc_policy != null) has its own, structurally
 * different four-path shape and is deliberately OUT OF SCOPE here --
 * check vault.bloc_policy first and use Bloc's own logic instead.
 */

export function isLeafListVault(vault) {
  return Array.isArray(vault.leaves) && vault.leaves.length > 0;
}

/**
 * @param {object} vault
 * @returns {{id: string, label: string, quorum: number, keyCount: number, keys: string[], unlockType: 'immediate'|'after'|'older', unlockBlocks: number}[]}
 */
export function getSpendingPaths(vault) {
  if (isLeafListVault(vault)) {
    return vault.leaves.map((leaf) => ({
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

  const paths = [
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

/** Look up one path by id (a leaf's own id, or a named-field path id). */
export function findSpendingPath(vault, pathId) {
  return getSpendingPaths(vault).find((p) => p.id === pathId);
}
