/**
 * tapit-circle-members.ts -- shared "which local keys are this vault's Tapit
 * circle members" detection, factored out of CirclePhraseSetup.tsx so
 * circle-membership-delivery.ts's setup UI (Cut C3) can use the exact same
 * logic without a second, silently-drifting copy of it.
 *
 * A founder_keys entry with no real xpub (a bare 66-hex pubkey) is the
 * signature of a Tapit-origin key (see keystore.ts's importTapitPubkey and
 * vaults-compile.js's keyStoreValue) -- nothing else in this app stores a
 * founder that way, so this is the closest available signal that "this
 * vault expects a Tapit circle member here."
 */

import { listKeys, type LocalKey } from './keystore';
import { pubkeyFromXpub } from './xpub';

export interface TapitCircleMembers {
  /** Local keys that are both Tapit-origin AND named in founder_keys. */
  circleMembers: LocalKey[];
  /** founder_keys entries that look Tapit-origin (bare 66-hex pubkey) but
   *  have no matching local key -- used to tell "no circle" apart from
   *  "circle exists, wrong browser/device" instead of going silent either way. */
  bareFounderPubkeys: string[];
}

export function getTapitCircleMembers(founderKeys: string[]): TapitCircleMembers {
  const signerPubkeys = new Set<string>();
  const bareFounderPubkeys: string[] = [];
  for (const x of founderKeys) {
    if (typeof x !== 'string') continue;
    if (x.length === 66) {
      signerPubkeys.add(x);
      bareFounderPubkeys.push(x);
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

  return { circleMembers, bareFounderPubkeys };
}
