// Remember, on THIS phone, the vault each person agreed to (threat model
// item B, docs/threat-model-2026-11-13.md).
//
// The in-browser address check (descriptor-check.ts) proves a vault's
// stored descriptor really pays to its stored address. It cannot notice a
// SELF-CONSISTENT swap: someone who replaces both with their own vault's.
// So the first time a finalized vault opens on a phone, its address is
// pinned here; if it is ever different afterwards, the vault is stopped.
//
// Why the address and not the descriptor text: the descriptor's text can
// legitimately change after finalizing (repairing a hardware wallet's key
// details rewrites the [fingerprint/path]xpub parts), but its address
// cannot -- the address IS the tree. With the address check above it, a
// pinned address means the same keys, paths and timelocks.
//
// A phone that first sees a vault after a swap pins the swapped one; the
// other members' phones, which pinned the real one, stop. That is why
// every member's phone pins, not only the owner's.

import { HDKey } from '@scure/bip32';

const STORE = 'dt:vaultPins:v1';
const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');

export interface VaultPin { address: string; pinnedAt: string }
export type PinResult =
  | { status: 'pinned_now' }
  | { status: 'same'; pinnedAt: string }
  | { status: 'changed'; pinned: string; now: string; pinnedAt: string };

type Pins = Record<string, VaultPin>;

function load(): Pins {
  try {
    const raw = localStorage.getItem(STORE);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? (v as Pins) : {};
  } catch {
    return {};
  }
}

/** Pure: what this address means against the pins, and the pins after. */
export function comparePin(pins: Pins, vaultId: string, address: string, now: string): { result: PinResult; next: Pins } {
  const a = address.trim().toLowerCase();
  const have = pins[vaultId];
  if (!have) return { result: { status: 'pinned_now' }, next: { ...pins, [vaultId]: { address: a, pinnedAt: now } } };
  if (have.address === a) return { result: { status: 'same', pinnedAt: have.pinnedAt }, next: pins };
  return { result: { status: 'changed', pinned: have.address, now: a, pinnedAt: have.pinnedAt }, next: pins };
}

/** Check a finalized vault's address against this phone's pin, pinning it the first time. */
export function checkVaultPin(vaultId: string, address: string): PinResult {
  const { result, next } = comparePin(load(), vaultId, address, new Date().toISOString());
  if (result.status === 'pinned_now') {
    try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* private mode: nothing pinned, nothing to compare */ }
  }
  return result;
}

/** Every signing key a descriptor names, as 66-char compressed hex where
 *  it can be derived: raw hex keys as written (x-only ones lifted with
 *  02/03 left to the caller), and each extended key's fixed /0/0 child --
 *  the key a DynastyTrust leaf script actually uses. */
export function descriptorSigningKeys(descriptor: string): { compressed: Set<string>; xonly: Set<string> } {
  const compressed = new Set<string>(), xonly = new Set<string>();
  for (const m of descriptor.matchAll(/\b0[23][0-9a-fA-F]{64}\b/g)) { compressed.add(m[0].toLowerCase()); xonly.add(m[0].slice(2).toLowerCase()); }
  for (const m of descriptor.matchAll(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) xonly.add(m[0].toLowerCase());
  for (const m of descriptor.matchAll(/[xt]pub[1-9A-HJ-NP-Za-km-z]{100,112}/g)) {
    try {
      const testnet = m[0].startsWith('t');
      const k = HDKey.fromExtendedKey(m[0], testnet ? { private: 0x04358394, public: 0x043587cf } : undefined);
      const pub = k.deriveChild(0).deriveChild(0).publicKey;
      if (pub) { const h = hex(pub); compressed.add(h); xonly.add(h.slice(2)); }
    } catch { /* not an extended key after all */ }
  }
  return { compressed, xonly };
}

/**
 * Is the key this person joined with really in the vault? Asked only for a
 * key held on THIS phone, so a rewritten member row cannot make it pass:
 * its signing key must be one the descriptor (which the address check just
 * proved) actually names.
 */
export function ownKeyInDescriptor(descriptor: string, pubkey: string): boolean {
  const k = pubkey.toLowerCase();
  const { compressed, xonly } = descriptorSigningKeys(descriptor);
  return compressed.has(k) || (k.length === 66 && xonly.has(k.slice(2))) || (k.length === 64 && xonly.has(k));
}
