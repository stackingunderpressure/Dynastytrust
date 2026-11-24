import * as btc from '@scure/btc-signer';
import type { Vault } from './api';
import { deriverFor, isFreshAddressVault } from './fresh-addresses';

/** How many future change addresses a Tapit membership request lists
 *  (operator's choice, 2026-11-24: "Next 200 addresses"). */
export const CHANGE_LIST_SIZE = 200;
/** The Members tab warns once fewer than this many listed addresses remain. */
export const CHANGE_LIST_WARN = 20;

type ChangeVault = Pick<Vault, 'address' | 'network' | 'descriptor_version' | 'descriptor_multipath' | 'descriptor_receive' | 'descriptor_change'>;

function scriptOf(address: string, network: Vault['network']): string {
  const net = network === 'bitcoin' ? btc.NETWORK : btc.TEST_NETWORK;
  return Array.from(btc.OutScript.encode(btc.Address(net).decode(address)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The vault's own change addresses as output scripts, worked out ON THIS
 * DEVICE (docs/tapit-review-modes-build-note.md): a fresh-address vault's
 * change addresses from `nextChange` up to `nextChange + 200` (the compiler
 * wasm, from the vault's stored descriptors, refusing if they do not start
 * at the vault's own address); a one-address vault's one address. `until`
 * is the index the list runs up to (exclusive), null for a one-address vault.
 */
export async function changeScriptsFor(
  vault: ChangeVault,
  nextChange: number,
  derive = deriverFor(vault),
): Promise<{ scripts: string[]; until: number | null }> {
  if (!vault.address) throw new Error('This vault has no address yet.');
  if (!isFreshAddressVault(vault)) return { scripts: [scriptOf(vault.address, vault.network)], until: null };
  const zero = await derive(0, 0);
  if (zero.address !== vault.address) throw new Error("This vault's stored address list does not start at its own address.");
  const scripts: string[] = [];
  for (let i = nextChange; i < nextChange + CHANGE_LIST_SIZE; i++) scripts.push((await derive(1, i)).script_pubkey.toLowerCase());
  return { scripts, until: nextChange + CHANGE_LIST_SIZE };
}
