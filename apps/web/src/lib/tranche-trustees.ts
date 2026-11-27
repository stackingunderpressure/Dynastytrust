/**
 * tranche-trustees.ts -- which keys back a Distribution wallet (tranche).
 *
 * A tranche is one address with two ways out: the beneficiary alone
 * after its unlock block, or the trustees at any time (the "Trustee
 * escape"). The tranche compiler only takes the trustees as a plain
 * "Q of these N keys".
 *
 * Until 2026-11-27 the trustees always came from vault.founder_keys /
 * vault.founder_quorum. A vault made with the path builder (every new
 * vault) never fills those columns -- they sit at the DB defaults,
 * founder_keys [] and founder_quorum 2 -- so the creator sent no trustees
 * and compile-tranche refused with "Missing: trustee_keys". Reproduced
 * against the real in-process compiler before this fix; the same compiler
 * builds a valid tranche when given the vault's own right-away path.
 *
 * For a path-builder vault the trustees are now the keys and quorum of a
 * path that opens right away. A path with must-sign keys or a wellness
 * check is never offered: neither fits "Q of N", and flattening one into
 * it would let a tranche skip the very key or check the owner required.
 */

import type { Vault } from './api';
import { pubkeyFromXpub } from './xpub';

export interface TrusteeChoice {
  /** The path id, or 'founders' for a vault built the older way. */
  id: string;
  label: string;
  keys: string[];
  quorum: number;
}

export interface TrusteeOptions {
  choices: TrusteeChoice[];
  /** Right-away paths that were left out, with the plain reason. */
  skipped: { label: string; reason: string }[];
}

function founderPubkeys(founderKeys: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const x of founderKeys) {
    if (typeof x !== 'string') continue;
    // Current vaults store the /0/0 pubkey hex; a few older rows hold a bare xpub.
    if (x.length === 66) { out.push(x); continue; }
    try { out.push(pubkeyFromXpub(x)); } catch { /* skip malformed rows */ }
  }
  return out;
}

export function trancheTrusteeOptions(
  vault: Pick<Vault, 'leaves' | 'founder_keys' | 'founder_quorum'>,
): TrusteeOptions {
  const leaves = Array.isArray(vault.leaves) ? vault.leaves : [];
  if (leaves.length === 0) {
    const keys = founderPubkeys(vault.founder_keys ?? []);
    const quorum = vault.founder_quorum ?? 0;
    const ok = keys.length > 0 && quorum >= 1 && quorum <= keys.length;
    return {
      choices: ok ? [{ id: 'founders', label: 'Founders', keys, quorum }] : [],
      skipped: [],
    };
  }
  const choices: TrusteeChoice[] = [];
  const skipped: TrusteeOptions['skipped'] = [];
  for (const leaf of leaves) {
    if (leaf.unlock?.type !== 'immediate') continue;
    if (leaf.wellness) {
      skipped.push({ label: leaf.label, reason: 'it needs a wellness check, which a tranche backup cannot carry' });
      continue;
    }
    if ((leaf.required_keys ?? []).length > 0) {
      skipped.push({ label: leaf.label, reason: 'it has must-sign keys, which a tranche backup cannot carry' });
      continue;
    }
    const keys = leaf.keys.filter((k) => typeof k === 'string' && k.length === 66);
    if (keys.length === 0 || leaf.quorum < 1 || leaf.quorum > keys.length) {
      skipped.push({ label: leaf.label, reason: 'it has no complete set of keys yet' });
      continue;
    }
    choices.push({ id: leaf.id, label: leaf.label, keys, quorum: leaf.quorum });
  }
  return { choices, skipped };
}
