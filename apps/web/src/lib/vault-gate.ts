// The checks every vault page runs before showing anything
// (VaultAddressGate). Pure of React so scripts/test-vault-pin.mjs can drive it.
import { checkVaultAddress, type VaultAddressCheck } from './descriptor-check';
import { checkVaultPin, ownKeyInDescriptor } from './vault-pin';

// What the gate decided: the address check's own answer, or one of the
// two phone-side checks added 2026-11-13 (threat model item B).
export type GateCheck =
  | VaultAddressCheck
  | { status: 'pin_changed'; pinned: string; now: string; pinnedAt: string }
  | { status: 'own_key_missing'; pubkey: string };

/** Run the address check, then -- for a finalized vault -- this phone's pin
 *  and, when this phone holds the key the person joined with, that the key
 *  is really in the vault. Exported for scripts/test-vault-pin.mjs. */
export async function runGateChecks(
  vault: { id?: string; address?: string | null; descriptor?: string | null; network: string },
  myJoinedPubkey: () => Promise<string | null>,
): Promise<GateCheck> {
  const c = await checkVaultAddress(vault);
  if (c.status !== 'match' || !vault.id) return c;
  const pin = checkVaultPin(vault.id, c.address);
  if (pin.status === 'changed') return { status: 'pin_changed', pinned: pin.pinned, now: pin.now, pinnedAt: pin.pinnedAt };
  let mine: string | null = null;
  try { mine = await myJoinedPubkey(); } catch { mine = null; }
  if (mine && !ownKeyInDescriptor(vault.descriptor ?? '', mine)) return { status: 'own_key_missing', pubkey: mine };
  return c;
}

