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
 * fix) -- pass whichever of the vault's key arrays (founder_keys,
 * heir_keys, backup_keys, consent_keys) you're checking;
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

  // 2026-08-11 fix (operator: "Why two tapit sends for one key?"): this
  // filter used to return every matching LocalKey record, unfiltered --
  // if the local Key Manager happens to hold two separate LocalKey rows
  // (different keyId, e.g. from importing/pasting the same Tapit pubkey
  // twice) that share one real pubkey, both passed through and rendered
  // as two identical-looking "Founder (Tapit)" rows, and notifying both
  // sent the exact same psbt-cosign request twice to the exact same
  // wallet. The vault's OWN key array was never the duplicate -- it's
  // deduped into signerPubkeys (a Set) above -- so this is purely a
  // local-keystore-side duplicate. Deduped by pubkey (keep the first
  // matching LocalKey record) so one real vault signer is always exactly
  // one row here, regardless of how many local records happen to point
  // at the same key.
  const seenPubkeys = new Set<string>();
  const circleMembers = listKeys().filter(k => {
    if (k.status !== 'active' || k.origin !== 'tapit' || !k.tapitXOnlyPubkey) return false;
    if (!signerPubkeys.has(k.pubkey)) return false;
    if (seenPubkeys.has(k.pubkey)) return false;
    seenPubkeys.add(k.pubkey);
    return true;
  });

  return { circleMembers, barePubkeys };
}
