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
 * @returns {{id: string, label: string, quorum: number, keyCount: number, keys: string[], requiredKeys: string[], consent: {keys: string[], quorum: number}|null, unlockType: 'immediate'|'after'|'older', unlockBlocks: number}[]}
 */
export function getSpendingPaths(vault) {
  const consent = (vault.consent_keys ?? []).length > 0 && vault.consent_quorum != null
    ? { keys: vault.consent_keys, quorum: vault.consent_quorum }
    : null;

  if (isLeafListVault(vault)) {
    // The consent group gates the FIRST immediate leaf only -- the same
    // rule protocol::build_leaf_multileaf applies.
    const primary = vault.leaves.findIndex((leaf) => leaf.unlock.type === 'immediate');
    return vault.leaves.map((leaf, i) => ({
      id: leaf.id,
      label: leaf.label || leaf.id,
      quorum: leaf.quorum,
      keyCount: leaf.keys.length,
      keys: leaf.keys,
      requiredKeys: leaf.required_keys ?? [],
      consent: i === primary ? consent : null,
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

  // Named-field vaults have no must-sign keys; consent gates founders-now.
  return paths.map((p) => ({ ...p, requiredKeys: [], consent: p.id === 'founders_now' ? consent : null }));
}

/** How many signatures a spend on this path needs in all. */
export function signaturesNeeded(path) {
  return path.requiredKeys.length + path.quorum + (path.consent ? path.consent.quorum : 0);
}

// A stored key as the 32-byte x-only hex a tapscript signature is filed
// under, or null when it is not a plain public key (an xpub).
function xOnlyHex(k) {
  if (typeof k !== 'string') return null;
  const h = k.toLowerCase();
  if (/^0[23][0-9a-f]{64}$/.test(h)) return h.slice(2);
  if (/^[0-9a-f]{64}$/.test(h)) return h;
  return null;
}

/**
 * Is this path's rule met by THESE signers? Counting signatures is not
 * enough once a path has must-sign keys or a consent group: on "the
 * hardware wallet and 1 of 2 phones", two phones are two signatures and
 * still cannot spend. `signedKeys` are the public keys (hex, x-only or
 * compressed) whose signatures have been verified.
 *
 * byName is false when a key on the path is stored as an xpub and cannot
 * be matched; the answer then falls back to the count.
 */
export function pathSignatureStatus(path, signedKeys) {
  const signed = new Set(signedKeys.map(xOnlyHex).filter(Boolean));
  const need = signaturesNeeded(path);
  const groups = [path.requiredKeys, path.keys, path.consent ? path.consent.keys : []];
  const byName = groups.every((g) => g.every((k) => xOnlyHex(k) !== null));
  if (!byName) {
    return { byName: false, satisfied: signed.size >= need, have: Math.min(signed.size, need), need, missingRequired: [], poolHave: 0, consentHave: 0 };
  }
  const has = (k) => signed.has(xOnlyHex(k));
  const missingRequired = path.requiredKeys.filter((k) => !has(k));
  const poolHave = Math.min(path.keys.filter(has).length, path.quorum);
  const consentHave = path.consent ? Math.min(path.consent.keys.filter(has).length, path.consent.quorum) : 0;
  const have = path.requiredKeys.length - missingRequired.length + poolHave + consentHave;
  return { byName: true, satisfied: have >= need, have, need, missingRequired, poolHave, consentHave };
}

/**
 * In what capacity does this key sign on this path? 'must_sign' (one of
 * the keys every spend on the path needs), 'consent' (one of the
 * consent group), 'signer' (one of the path's ordinary k-of-n keys),
 * or null when the key is not on the path or cannot be matched (a key
 * stored as an xpub). Server only: it labels a sealed signature.
 */
export function signerCapacity(path, pubkey) {
  const mine = xOnlyHex(pubkey);
  if (!path || !mine) return null;
  const on = (keys) => (keys ?? []).some((k) => xOnlyHex(k) === mine);
  if (on(path.requiredKeys)) return 'must_sign';
  if (path.consent && on(path.consent.keys)) return 'consent';
  if (on(path.keys)) return 'signer';
  return null;
}

/** Look up one path by id (a leaf's own id, or a named-field path id). */
export function findSpendingPath(vault, pathId) {
  const paths = getSpendingPaths(vault);
  const exact = paths.find((p) => p.id === pathId);
  if (exact || !isLeafListVault(vault)) return exact;
  // A relaxing path is spent by naming one of its steps ("kids_1"): the
  // same keys, one fewer needed per step, down to its floor. Must-sign
  // keys stay required on every step (protocol::expand_decay).
  const m = /^(.*)_(\d+)$/.exec(pathId);
  if (!m) return undefined;
  const leaf = vault.leaves.find((l) => l.id === m[1]);
  const base = paths.find((p) => p.id === m[1]);
  if (!leaf || !base || !leaf.decay || leaf.unlock.type === 'immediate') return undefined;
  const step = Number(m[2]);
  if (step > leaf.quorum - leaf.decay.floor_quorum) return undefined;
  return { ...base, id: pathId, quorum: leaf.quorum - step, unlockBlocks: leaf.unlock.blocks + step * leaf.decay.step_blocks };
}
