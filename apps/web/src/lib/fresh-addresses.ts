import type { Vault } from './api';
import { parsePsbt, toHex, type TapBip32Derivation } from '@dynastytrust/bip341-psbt-signer';
import { compileOnDevice } from './browser-compiler';

/** A vault made with "a new address every time" (ranged slice 3): its
 *  stored descriptors are `<0;1>/*` (descriptor_version 2). Anything else
 *  has one fixed address. */
export function isFreshAddressVault(v: Pick<Vault, 'descriptor_version'>): boolean {
  return v.descriptor_version === 2;
}

type FreshVault = Pick<Vault, 'address' | 'network' | 'descriptor_multipath' | 'descriptor_receive' | 'descriptor_change'>;
type Derive = (branch: 0 | 1, index: number) => Promise<{ address: string; script_pubkey: string }>;

/** One of the vault's addresses, worked out ON THIS DEVICE by the same Rust
 *  the server uses (the compiler wasm, checked against Bitcoin Core). */
export function deriverFor(v: FreshVault): Derive {
  return async (branch, index) => {
    const r = await compileOnDevice('/ranged-address', {
      multipath: v.descriptor_multipath, receive: v.descriptor_receive, change: v.descriptor_change,
      network: v.network, branch, index,
    });
    const body = JSON.parse(r.body) as { ok?: boolean; address?: string; script_pubkey?: string; error?: string };
    if (r.status !== 200 || !body.ok || !body.address || !body.script_pubkey) throw new Error(body.error || `address check refused (${r.status})`);
    return { address: body.address, script_pubkey: body.script_pubkey };
  };
}

/** Which of the vault's addresses a set of key origins points at: every
 *  per-index origin must agree on (branch, index). null when none say. */
function placeOf(ds: TapBip32Derivation[] | undefined): { branch: 0 | 1; index: number } | null | 'mixed' {
  let found: { branch: 0 | 1; index: number } | null = null;
  for (const d of ds ?? []) {
    if (d.path.length < 2) continue; // the unspendable internal key, or a bare (Tapit) key
    const [b, i] = d.path.slice(-2);
    if ((b !== 0 && b !== 1) || i >= 0x80000000) continue;
    if (found && (found.branch !== b || found.index !== i)) return 'mixed';
    found = { branch: b as 0 | 1, index: i };
  }
  return found;
}

/**
 * The spend check for a fresh-address vault (ranged slice 5), the stand-in
 * for "every input and the change are the vault's one address": every input
 * must spend, and the change must pay, an address THIS DEVICE derives from
 * the vault's stored descriptors -- and those descriptors must give the
 * vault's own (phone-pinned) address at receive 0, so a server cannot swap
 * in someone else's. Reads only the PSBT's own bytes.
 */
export async function checkFreshSpendAddresses(
  vault: FreshVault,
  psbtHex: string,
  derive: Derive = deriverFor(vault),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (!vault.address) return { ok: false, reason: 'This vault has no address on file' };
    const zero = await derive(0, 0);
    if (zero.address !== vault.address) return { ok: false, reason: "This vault's stored address list does not start at its own address" };
    const p = parsePsbt(psbtHex);
    for (let n = 0; n < p.inputs.length; n++) {
      const where = placeOf(p.inputs[n].tapBip32Derivation);
      if (!where || where === 'mixed') return { ok: false, reason: `Input ${n + 1} does not say which of this vault's addresses it spends` };
      const own = await derive(where.branch, where.index);
      if (!p.inputs[n].witnessUtxo || toHex(p.inputs[n].witnessUtxo!.scriptPubkey) !== own.script_pubkey) {
        return { ok: false, reason: `Input ${n + 1} does not spend this vault's own coins` };
      }
    }
    if (p.tx.outputs.length > 2) return { ok: false, reason: 'The PSBT has more than a payment and change' };
    if (p.tx.outputs.length === 2) {
      const where = placeOf(p.outputMaps?.[1]?.tapBip32Derivation);
      if (!where || where === 'mixed' || where.branch !== 1) return { ok: false, reason: "The PSBT's change output does not say which of this vault's change addresses it is" };
      const own = await derive(1, where.index);
      if (toHex(p.tx.outputs[1].scriptPubkey) !== own.script_pubkey) return { ok: false, reason: "The PSBT's change output does not return to this vault" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'The addresses could not be checked' };
  }
}
