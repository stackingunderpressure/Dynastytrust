/**
 * tapit-circle-members.ts -- shared "which local keys are this vault's Tapit
 * circle members" detection, factored out of CirclePhraseSetup.tsx so
 * circle-membership-delivery.ts's setup UI (Cut C3) can use the exact same
 * logic without a second, silently-drifting copy of it.
 *
 * A key-array entry with no real xpub (a bare 66-hex pubkey) is the
 * signature of a Tapit-origin key (see keystore.ts's importTapitPubkey and
 * vaults-compile.js's keyStoreValue) -- nothing else in this app stores a
 * key that way, so this is the closest available signal that "this vault
 * expects a Tapit circle member here." Role-agnostic on purpose (2026-08-11
 * fix) -- pass whichever of the vault's five key arrays (founder_keys,
 * heir_keys, protector_keys, backup_keys, consent_keys) you're checking;
 * the caller is what knows the role, this only knows "is it Tapit-origin
 * and named here."
 */

import { listKeys, type LocalKey } from './keystore';
import { pubkeyFromXpub } from './xpub';

export interface TapitCircleMembers {
  /** Local keys that are both Tapit-origin AND named in the given array. */
  circleMembers: LocalKey[];
  /** Entries that look Tapit-origin (bare 66-hex pubkey) but have no
   *  matching local key -- used to tell "no circle" apart from "circle
   *  exists, wrong browser/device" instead of going silent either way. */
  barePubkeys: string[];
}

export function getTapitCircleMembers(keyArray: string[]): TapitCircleMembers {
  const signerPubkeys = new Set<string>();
  const barePubkeys: string[] = [];
  for (const x of keyArray) {
    if (typeof x !== 'string') continue;
    if (x.length === 66) {
      signerPubkeys.add(x);
      barePubkeys.push(x);
      continue;
    }
    try {
      signerPubkeys.add(pubkeyFromXpub(x));
    } catch {
      /* skip malformed rows */
    }
  }

  const circleMembers = listKeys().filter(
    k => k.status === 'active' && k.origin === 'tapit' && k.tapitXOnlyPubkey && signerPubkeys.has(k.pubkey),
  );

  return { circleMembers, barePubkeys };
}
