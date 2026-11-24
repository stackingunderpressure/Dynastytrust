// Finding a vault's coins (ranged addresses slice 4,
// docs/ranged-addresses-slice3-build-note.md "Remaining slices").
//
// A v1 vault watches its one address. A v2 vault ("a new address every
// time") watches every index the database has ever reserved on each branch
// -- receive (0) and change (1) -- plus a look-ahead past the last one, so a
// payment to an address handed out by another wallet holding the same
// descriptor (Sparrow, a SeedSigner registration) is still seen. Every
// address comes from the vault's STORED descriptors through the compiler
// wasm (the Rust checked against Bitcoin Core); receive/0 must equal the
// vault's own address or nothing is watched at all.

import { callWasm } from "./_ranged-wasm.js";
import { MEMPOOL, mempoolFetch } from "./_chain.js";

/** Unused addresses watched past the last reserved index, per branch. */
export const LOOK_AHEAD = { 0: 10, 1: 5 };
const MAX_PER_BRANCH = 200; // the wasm route's own cap

/** Reserved-index counters for a v2 vault: { 0: n, 1: m } (0 when unset). */
export async function nextIndexes(supabase, vaultId) {
  const { data, error } = await supabase
    .from("vault_address_branches")
    .select("branch, next_index")
    .eq("vault_id", vaultId);
  if (error) throw new Error(`could not read this vault's address counters: ${error.message}`);
  const out = { 0: 0, 1: 0 };
  for (const r of data ?? []) if (r.branch === 0 || r.branch === 1) out[r.branch] = Number(r.next_index) || 0;
  return out;
}

/**
 * Every address to watch: [{ branch, index, address }]. Throws rather than
 * return a partial or wrong list.
 */
export function watchedAddresses(vault, next = { 0: 0, 1: 0 }, call = callWasm) {
  if (!vault.address) return [];
  if (vault.descriptor_version !== 2) return [{ branch: 0, index: 0, address: vault.address }];
  const out = [];
  for (const branch of [0, 1]) {
    const count = Math.min(MAX_PER_BRANCH, Math.max(1, next[branch] ?? 0) + LOOK_AHEAD[branch]);
    const r = call("/ranged-addresses", {
      multipath: vault.descriptor_multipath,
      receive: vault.descriptor_receive,
      change: vault.descriptor_change,
      network: vault.network,
      branch,
      start: 0,
      count,
    });
    if (r.status !== 200 || !r.body?.ok || !Array.isArray(r.body.addresses)) {
      throw new Error(r.body?.error || `address list refused (${r.status})`);
    }
    for (const a of r.body.addresses) out.push({ branch, index: a.index, address: a.address });
  }
  const zero = out.find((a) => a.branch === 0 && a.index === 0);
  if (!zero || zero.address !== vault.address) {
    throw new Error("this vault's stored descriptor does not match its address");
  }
  return out;
}

/** Unspent coins on every watched address, each tagged with where it sits. */
export async function coinsAt(network, watched, fetchJson = mempoolFetch, parallel = 6) {
  const base = MEMPOOL[network] || MEMPOOL.testnet;
  const out = [];
  let next = 0;
  async function worker() {
    while (next < watched.length) {
      const w = watched[next++];
      const raw = await fetchJson(`${base}/address/${w.address}/utxo`);
      for (const u of raw || []) out.push({ ...u, address: w.address, branch: w.branch, index: w.index });
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, watched.length) }, worker));
  return out;
}

/** May this signed-in user see this vault's coins? Owner or active member. */
export async function canSeeVault(supabase, vault, userId) {
  if (vault.user_id === userId) return true;
  const { data } = await supabase
    .from("vault_members")
    .select("id")
    .eq("vault_id", vault.id)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return !!data;
}
