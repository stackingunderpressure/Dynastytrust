/**
 * nostrRelayPrefs.ts -- this browser's chosen Nostr relay list for every
 * outgoing DynastyTrust-side Nostr send (vault-membership grants and
 * circle safety-phrase delivery, plus their ack subscriptions). Defaults
 * to DEFAULT_RELAYS (tapit-nostr-cosign.ts) exactly as before; overriding
 * it here is opt-in and stored locally, never sent to the server.
 *
 * Mirrors Tapit Wallet's own Settings screen (prefs.nostrRelays via
 * updatePrefs) -- a family that wants to run its own relay, or just
 * trusts a smaller set more than the public defaults, can now set that
 * on both ends of the conversation, not only the wallet's. See
 * SettingsScreen.tsx in the tapit-wallet repo for the pattern this
 * mirrors.
 *
 * NOT a security control. Relay choice affects delivery (whether the
 * sender and recipient overlap on at least one relay) and metadata
 * exposure (who can observe that encrypted traffic occurred, and when)
 * -- never who can decrypt or sign anything. That trust lives entirely
 * in the attested vault-membership trail Tapit checks against the
 * PSBT's own leaf-script bytes, unaffected by which relay carried the
 * request; see tapit-nostr-cosign.ts's header for why the sender
 * identity is already an ephemeral, per-request keypair regardless of
 * relay choice.
 */

import { DEFAULT_RELAYS } from './tapit-nostr-cosign';

const STORAGE_KEY = 'dynastytrust:nostr-relays';

function isValidRelayUrl(s: string): boolean {
  return /^wss:\/\/\S+$/.test(s.trim());
}

/** This browser's relay list -- the saved override, or DEFAULT_RELAYS. */
export function getNostrRelays(): readonly string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RELAYS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_RELAYS;
    const valid = parsed.filter((s): s is string => typeof s === 'string' && isValidRelayUrl(s));
    return valid.length > 0 ? valid : DEFAULT_RELAYS;
  } catch {
    return DEFAULT_RELAYS;
  }
}

/** True when this browser has an explicit override saved (vs. the default). */
export function hasCustomNostrRelays(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Save a relay list. Lines that don't look like a wss:// URL are
 * silently dropped; the caller can surface `dropped` if it wants to.
 * Saving an empty/all-invalid list clears the override instead
 * (falls back to DEFAULT_RELAYS on the next read).
 */
export function setNostrRelays(relays: readonly string[]): { saved: string[]; dropped: number } {
  const valid = relays.map(s => s.trim()).filter(isValidRelayUrl);
  const dropped = relays.length - valid.length;
  if (valid.length === 0) {
    clearNostrRelays();
    return { saved: [], dropped };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(valid));
  return { saved: valid, dropped };
}

/** Clear the override -- back to DEFAULT_RELAYS. */
export function clearNostrRelays(): void {
  localStorage.removeItem(STORAGE_KEY);
}
