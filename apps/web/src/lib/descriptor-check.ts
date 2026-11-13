// Re-derive a vault's address from its stored descriptor ON THIS DEVICE
// and compare it with the stored address (security backlog items 9 and
// 5). Operator, 2026-11-13: "What about compiler in browser?" -- chose
// "Verify first" and "Refuse to show it" on a mismatch.
//
// The work is done by protocol-wasm/ (rust-miniscript, the same library
// the Fly compiler uses) built to WebAssembly and committed as
// lib/wasm/dynastytrust_protocol_wasm.wasm; scripts/test-protocol-wasm.mjs
// holds that file to its Rust source. Fail closed: a descriptor that does
// not parse, or a module that does not load, is never reported as a match.

interface ProtocolExports {
  memory: WebAssembly.Memory;
  dt_alloc(len: number): number;
  dt_dealloc(ptr: number, cap: number): void;
  dt_descriptor_address(dPtr: number, dLen: number, nPtr: number, nLen: number): number;
}

let loading: Promise<ProtocolExports> | null = null;
let injected: Uint8Array | null = null;

/** Tests (Node) hand in the committed .wasm bytes; the browser fetches it. */
export function useProtocolWasmBytes(bytes: Uint8Array): void {
  injected = bytes;
  loading = null;
}

function load(): Promise<ProtocolExports> {
  if (!loading) {
    loading = (async () => {
      const bytes = injected ?? new Uint8Array(await (await fetch(new URL('./wasm/dynastytrust_protocol_wasm.wasm', import.meta.url))).arrayBuffer());
      const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
      return instance.exports as unknown as ProtocolExports;
    })();
    loading.catch(() => { loading = null; }); // a failed load can be retried
  }
  return loading;
}

/** The address a descriptor pays to, computed on this device. */
export async function descriptorAddress(descriptor: string, network: string): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const x = await load();
  const enc = new TextEncoder();
  const d = enc.encode(descriptor), n = enc.encode(network);
  const dp = x.dt_alloc(d.length), np = x.dt_alloc(n.length);
  new Uint8Array(x.memory.buffer, dp, d.length).set(d);
  new Uint8Array(x.memory.buffer, np, n.length).set(n);
  const rp = x.dt_descriptor_address(dp, d.length, np, n.length);
  x.dt_dealloc(dp, d.length);
  x.dt_dealloc(np, n.length);
  const len = new DataView(x.memory.buffer).getUint32(rp, true);
  const json = new TextDecoder().decode(new Uint8Array(x.memory.buffer, rp + 4, len));
  x.dt_dealloc(rp, 4 + len);
  const v = JSON.parse(json) as { ok: boolean; address?: string; error?: string };
  return v.ok && typeof v.address === 'string' ? { ok: true, address: v.address } : { ok: false, error: v.error ?? 'unreadable answer' };
}

export type VaultAddressCheck =
  | { status: 'not_applicable' }           // a draft: no address to protect yet
  | { status: 'match'; address: string }
  | { status: 'mismatch'; stored: string; derived: string }
  | { status: 'unreadable'; reason: string } // descriptor will not compile here
  | { status: 'unchecked'; reason: string }; // the checker itself did not run

/**
 * Does this vault's descriptor really pay to the address shown for it?
 * Only 'match' lets the vault be shown. A vault with an address but no
 * descriptor is 'unreadable': there is nothing to check the address against.
 */
export async function checkVaultAddress(vault: { address?: string | null; descriptor?: string | null; network: string }): Promise<VaultAddressCheck> {
  const stored = (vault.address ?? '').trim();
  const descriptor = (vault.descriptor ?? '').trim();
  if (!stored && !descriptor) return { status: 'not_applicable' };
  if (!descriptor) return { status: 'unreadable', reason: 'This vault has an address but no descriptor to check it against.' };
  if (!stored) return { status: 'unreadable', reason: 'This vault has a descriptor but no address.' };
  let res: Awaited<ReturnType<typeof descriptorAddress>>;
  try {
    res = await descriptorAddress(descriptor, vault.network);
  } catch (e) {
    return { status: 'unchecked', reason: e instanceof Error ? e.message : 'The address checker did not load.' };
  }
  if (!res.ok) return { status: 'unreadable', reason: res.error };
  // Bech32 addresses are case-insensitive; compare the canonical lower case.
  return res.address.toLowerCase() === stored.toLowerCase()
    ? { status: 'match', address: res.address }
    : { status: 'mismatch', stored, derived: res.address };
}
