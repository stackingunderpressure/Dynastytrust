// Messaging safety codes (threat model item E, docs/threat-model-2026-11-13.md).
//
// Each member's messaging public key reaches everyone else through the
// server (vault_members.messaging_pubkey). Anyone able to rewrite that row --
// a server or database compromise -- could put their own key there, read
// every later message to that member and forge messages from them, and
// nothing on screen would change. Two defences, both on THIS phone:
//
//  1. A safety code per pair of people, made from BOTH public keys, that
//     two people read to each other by voice. Same keys, same code on both
//     phones; a swapped key gives a different code.
//  2. The key first seen for each member is remembered. If it is ever
//     different, nothing more is sent to them, and their messages are
//     labelled, until this person has compared the new code and accepted it.
//
// A key can change for an honest reason (they regenerated it, or opened the
// vault in a new browser without restoring their backup); the warning says
// so, and the fix is the same: compare the code by voice.

import { sha256 } from '@noble/hashes/sha2';

const STORE = 'dt:msgKeyPins:v1';

export interface MsgKeyPin { pubkey: string; compared: boolean; pinnedAt: string }
type Pins = Record<string, MsgKeyPin>;
export type PeerKeyStatus = 'compared' | 'not_compared' | 'changed';

const pinId = (vaultId: string, userId: string) => `${vaultId}:${userId}`;
const norm = (k: string) => k.trim().toLowerCase();

/**
 * The code two people compare: twelve digits in three groups of four.
 * Order-independent, so both phones show the same code. 40 bits of a
 * SHA-256: a swapped key would have to be ground for about a trillion tries
 * to collide with one particular pair, for one conversation.
 */
export function safetyCode(myPubkey: string, theirPubkey: string): string {
  const [a, b] = [norm(myPubkey), norm(theirPubkey)].sort();
  const h = sha256(new TextEncoder().encode(`dynastytrust-messaging-safety-v1|${a}|${b}`));
  let n = 0;
  for (let i = 0; i < 5; i++) n = n * 256 + h[i];
  const digits = String(n % 1_000_000_000_000).padStart(12, '0');
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
}

function load(): Pins {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || '{}');
    return v && typeof v === 'object' ? (v as Pins) : {};
  } catch {
    return {};
  }
}
function save(p: Pins): void {
  try { localStorage.setItem(STORE, JSON.stringify(p)); } catch { /* private mode: nothing remembered */ }
}

/** Pure: a member's key against the pins, and the pins after (first sight pins it). */
export function comparePeerKey(pins: Pins, vaultId: string, userId: string, pubkey: string, now: string): { status: PeerKeyStatus; pinned: MsgKeyPin; next: Pins } {
  const id = pinId(vaultId, userId);
  const k = norm(pubkey);
  const have = pins[id];
  if (!have) {
    const pinned = { pubkey: k, compared: false, pinnedAt: now };
    return { status: 'not_compared', pinned, next: { ...pins, [id]: pinned } };
  }
  if (have.pubkey !== k) return { status: 'changed', pinned: have, next: pins };
  return { status: have.compared ? 'compared' : 'not_compared', pinned: have, next: pins };
}

/** This member's key status on this phone, pinning it the first time. */
export function peerKeyStatus(vaultId: string, userId: string, pubkey: string): PeerKeyStatus {
  const pins = load();
  const { status, next } = comparePeerKey(pins, vaultId, userId, pubkey, new Date().toISOString());
  if (next !== pins) save(next);
  return status;
}

/** After comparing the code by voice: remember THIS key as the checked one. */
export function markPeerKeyCompared(vaultId: string, userId: string, pubkey: string): void {
  save({ ...load(), [pinId(vaultId, userId)]: { pubkey: norm(pubkey), compared: true, pinnedAt: new Date().toISOString() } });
}

/** Does a message's sender key match the key this phone remembers for them?
 *  null when this phone has never seen a key for them. */
export function senderKeyMatches(vaultId: string, userId: string, senderPubkey: string): boolean | null {
  const have = load()[pinId(vaultId, userId)];
  return have ? have.pubkey === norm(senderPubkey) : null;
}
