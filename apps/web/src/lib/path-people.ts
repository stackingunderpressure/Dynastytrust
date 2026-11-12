/**
 * path-people.ts -- the people side of a path-builder vault's key
 * slots (journey gap J3: family joins with their own keys). Pure.
 *
 * A slot is filled by a key. Until 2026-11-11 the only keys the builder
 * knew were the ones in the owner's own browser. Now a slot can also be
 * filled by a key an invited person made on THEIR device, once the
 * owner has confirmed it by its fingerprint. This file turns a member
 * row into the same SelectedKey the builder already uses, rebuilds the
 * slots of a saved draft, and says what state each invited person is in.
 */
import type { SelectedKey } from './descriptor-keys';
import type { LeafSpec, VaultInvite, VaultMember } from './api';
import type { LocalKey } from './keystore';

/** Same signer whether written 02... or 03... (Taproot names a key by x). */
export const xOnly = (pubkeyHex: string): string => pubkeyHex.toLowerCase().slice(-64);

export const memberKeyId = (memberId: string): string => `member:${memberId}`;

/** An invited person's confirmed key, shaped as the builder's slot entry.
 *  Returns null when the member has no usable key yet. */
export function memberToSelected(m: VaultMember, network: string): SelectedKey | null {
  if (!m.pubkey || m.pubkey.length !== 66 || !m.xpub || !m.fingerprint || !m.derivation_path) return null;
  return {
    keyId: memberKeyId(m.id),
    label: m.label || 'Invited member',
    persona: 'Their own device',
    pubkey: m.pubkey,
    xpub: m.xpub,
    fingerprint: m.fingerprint,
    masterFingerprint: m.fingerprint,
    derivationPath: m.derivation_path,
    network,
    origin: 'member',
  };
}

function localToSelected(k: LocalKey): SelectedKey {
  return {
    keyId: k.keyId, label: k.label, persona: k.persona, xpub: k.xpub,
    pubkey: k.pubkey, fingerprint: k.fingerprint, masterFingerprint: k.masterFingerprint,
    derivationPath: k.derivationPath, network: k.network, origin: k.origin,
  };
}

/**
 * Rebuild the builder's slots from a saved draft. Each saved pubkey is
 * matched to a key in this browser first, then to a CONFIRMED invited
 * member. A saved key that is neither (a key from another device, or a
 * member whose confirmation is gone) is left out and reported, so the
 * owner sees an empty slot instead of a key they cannot account for.
 */
/** Where the builder keeps a path's must-sign keys, beside its other
 *  keys: the same record, under the path's id plus this suffix. A path id
 *  never contains '#', so the two cannot collide. */
export const mustSlot = (leafId: string) => `${leafId}#must`;

export function hydrateSlots(
  leaves: readonly LeafSpec[],
  localKeys: readonly LocalKey[],
  members: readonly VaultMember[],
  ownerUserId: string,
  network: string,
): { slots: Record<string, SelectedKey[]>; dropped: number } {
  const local = new Map(localKeys.filter(k => k.pubkey).map(k => [xOnly(k.pubkey), k]));
  const invited = new Map(
    members
      .filter(m => m.status === 'active' && m.user_id !== ownerUserId && m.pubkey && m.key_confirmed_at)
      .map(m => [xOnly(m.pubkey as string), m]),
  );
  const slots: Record<string, SelectedKey[]> = {};
  let dropped = 0;
  const resolve = (pks: readonly string[]): SelectedKey[] => {
    const out: SelectedKey[] = [];
    for (const pk of pks) {
      const k = local.get(xOnly(pk));
      const m = invited.get(xOnly(pk));
      const sk = k ? localToSelected(k) : m ? memberToSelected(m, network) : null;
      if (sk && !out.some(x => x.keyId === sk.keyId)) out.push(sk);
      else if (!sk) dropped++;
    }
    return out;
  };
  for (const leaf of leaves) {
    slots[leaf.id] = resolve(leaf.keys ?? []);
    if ((leaf.required_keys ?? []).length > 0) slots[mustSlot(leaf.id)] = resolve(leaf.required_keys ?? []);
  }
  return { slots, dropped };
}

export type PersonState =
  | { kind: 'invited'; invite: VaultInvite }                 // link sent, not joined yet
  | { kind: 'joined'; member: VaultMember }                  // joined with a key, owner has not confirmed
  | { kind: 'confirmed'; member: VaultMember; inSlot: boolean };

/** Everyone invited to one path, in the state the owner needs to act on.
 *  `now` decides which unclaimed invites have expired (left out). */
export function peopleOnPath(
  leafId: string,
  invites: readonly VaultInvite[],
  members: readonly VaultMember[],
  ownerUserId: string,
  selected: readonly SelectedKey[],
  now: Date,
): PersonState[] {
  const out: PersonState[] = [];
  for (const m of members) {
    if (m.leaf_id !== leafId || m.status !== 'active' || m.user_id === ownerUserId) continue;
    if (m.key_confirmed_at) out.push({ kind: 'confirmed', member: m, inSlot: selected.some(s => s.keyId === memberKeyId(m.id)) });
    else out.push({ kind: 'joined', member: m });
  }
  for (const i of invites) {
    if (i.leaf_id !== leafId || i.claimed_at || new Date(i.expires_at).getTime() < now.getTime()) continue;
    out.push({ kind: 'invited', invite: i });
  }
  return out;
}

/** Slots on a path that are neither filled nor promised to someone. */
export function openSlots(planned: number, selected: readonly SelectedKey[], people: readonly PersonState[]): number {
  const promised = people.filter(p => p.kind === 'invited' || p.kind === 'joined' || (p.kind === 'confirmed' && !p.inSlot)).length;
  return Math.max(0, planned - selected.length - promised);
}
