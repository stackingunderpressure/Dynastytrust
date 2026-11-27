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
import { electrumCoins, electrumUsed, serverFor } from "./_electrum.js";

/** Unused addresses watched past the last reserved index, per branch.
 *  Every address the app ever handed out is always watched; this margin is
 *  only for an address another wallet holding the descriptor gave out.
 *  Was 10/5 until 2026-11-24, when mempool.space started refusing ("429 too
 *  many requests") the scans of a fresh-address vault's page (measured:
 *  views 3-6 of 6 all refused). */
export const LOOK_AHEAD = { 0: 5, 1: 2 };
/** Where lookups go to an Electrum server they are batched (one request
 *  for the lot), so the look-ahead can match the 20-address gap wallets
 *  restoring a vault use (outside review 2026-11-27, low 3). The website
 *  fallback still sees only LOOK_AHEAD (vaultCoins/vaultUsed trim it). */
export const ELECTRUM_LOOK_AHEAD = { 0: 20, 1: 20 };
/** Lookups in flight at once, and how often a refused one is retried. */
const PARALLEL = 3;
const RETRIES = 2;
const RETRY_WAIT_MS = 1200;
const ROUTE_MAX = 200; // the wasm route's own cap per call
// Addresses watched per branch. Was 200 (the route's cap) until 2026-11-24,
// which would have stopped a long-lived vault seeing its newest addresses.
const MAX_PER_BRANCH = 5000;

/** The website (one request per address) only looks LOOK_AHEAD past the
 *  addresses handed out, whatever the list was built for. */
function forWebsite(watched) {
  return watched.filter((w) => w.ahead === undefined || w.ahead < LOOK_AHEAD[w.branch]);
}

/** Will lookups for this network be batched (an Electrum server, the
 *  person's own or the default)? Then the wider look-ahead is cheap. */
export async function batchedLookups(network, userServers = {}, deps = {}) {
  try {
    return !!(await (deps.serverFor ?? serverFor)(network, userServers, deps));
  } catch {
    return false;
  }
}

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
export function watchedAddresses(vault, next = { 0: 0, 1: 0 }, call = callWasm, { wide = false } = {}) {
  if (!vault.address) return [];
  if (vault.descriptor_version !== 2) return [{ branch: 0, index: 0, address: vault.address }];
  const out = [];
  for (const branch of [0, 1]) {
    const handedOut = Math.max(1, next[branch] ?? 0);
    const count = Math.min(MAX_PER_BRANCH, handedOut + (wide ? ELECTRUM_LOOK_AHEAD : LOOK_AHEAD)[branch]);
    // The wasm route answers at most ROUTE_MAX per call; ask in runs so a
    // vault past 200 addresses keeps watching its newest ones (2026-11-24).
    for (let start = 0; start < count; start += ROUTE_MAX) {
      const r = call("/ranged-addresses", {
        multipath: vault.descriptor_multipath,
        receive: vault.descriptor_receive,
        change: vault.descriptor_change,
        network: vault.network,
        branch,
        start,
        count: Math.min(ROUTE_MAX, count - start),
      });
      if (r.status !== 200 || !r.body?.ok || !Array.isArray(r.body.addresses)) {
        throw new Error(r.body?.error || `address list refused (${r.status})`);
      }
      // `ahead`: how far past the addresses handed out (0 = the first one
      // after them); absent for an address handed out.
      for (const a of r.body.addresses) out.push({ branch, index: a.index, address: a.address, ...(a.index >= handedOut ? { ahead: a.index - handedOut } : {}) });
    }
  }
  const zero = out.find((a) => a.branch === 0 && a.index === 0);
  if (!zero || zero.address !== vault.address) {
    throw new Error("this vault's stored descriptor does not match its address");
  }
  return out;
}

/** A lookup that mempool.space refused for load (429) or a connection that
 *  dropped is retried after a short wait; anything else fails at once. */
async function withRetry(fn, wait = RETRY_WAIT_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message || e);
      const retryable = /\b429\b|fetch failed|ECONNRESET|socket hang up|ETIMEDOUT/i.test(msg);
      if (!retryable || attempt >= RETRIES) throw e;
      await new Promise((r) => setTimeout(r, wait * (attempt + 1)));
    }
  }
}

/** Unspent coins on every watched address, each tagged with where it sits. */
export async function coinsAt(network, watched, fetchJson = mempoolFetch, parallel = PARALLEL, retryWaitMs = RETRY_WAIT_MS) {
  const base = MEMPOOL[network] || MEMPOOL.testnet;
  const out = [];
  let next = 0;
  async function worker() {
    while (next < watched.length) {
      const w = watched[next++];
      const raw = await withRetry(() => fetchJson(`${base}/address/${w.address}/utxo`), retryWaitMs);
      for (const u of raw || []) out.push({ ...u, address: w.address, branch: w.branch, index: w.index });
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, watched.length) }, worker));
  return out;
}

/**
 * Coins and the chain tip for a vault's watched addresses
 * (docs/chain-lookups-build-note.md). The person's own Electrum server, when
 * their device sent one for this network, and ONLY that server -- a failure
 * is shown, never quietly sent to mempool.space instead, because choosing
 * your own node is a privacy choice. Otherwise the default Electrum server
 * for the network (signet), falling back to the website lookups if it
 * fails; otherwise the website lookups. `source` says which answered.
 */
export async function vaultCoins(network, watched, userServers = {}, deps = {}) {
  const viaWebsite = async () => {
    const base = MEMPOOL[network] || MEMPOOL.testnet;
    const list = forWebsite(watched);
    const [coins, tip] = await Promise.all([
      (deps.coinsAt ?? coinsAt)(network, list),
      (deps.fetchJson ?? mempoolFetch)(`${base}/blocks/tip/height`).catch(() => null),
    ]);
    return { coins, tip: typeof tip === "number" ? tip : null, source: "mempool.space", looked_up: list.length };
  };
  const server = await (deps.serverFor ?? serverFor)(network, userServers, deps);
  if (!server) return viaWebsite();
  try {
    const { coins, tip } = await (deps.electrumCoins ?? electrumCoins)(server, network, watched, deps);
    return { coins, tip, source: server.own ? "your Electrum server" : `Electrum (${server.host})`, looked_up: watched.length };
  } catch (e) {
    if (server.own) throw e;
    console.warn(`default Electrum server failed, using the website lookups: ${e.message}`);
    return viaWebsite();
  }
}

/**
 * Which of `watched` have ever been paid (docs/receive-address-reuse-until-
 * paid-build-note.md): same servers and same rules as vaultCoins -- the
 * person's own Electrum server only, else the default Electrum server with
 * the website as fallback, else the website (an address's transaction
 * count, confirmed plus waiting). A Set of addresses.
 */
export async function vaultUsed(network, watched, userServers = {}, deps = {}) {
  const viaWebsite = async () => {
    const base = MEMPOOL[network] || MEMPOOL.testnet;
    const used = new Set();
    let next = 0;
    const fetchJson = deps.fetchJson ?? mempoolFetch;
    const list = forWebsite(watched);
    async function worker() {
      while (next < list.length) {
        const w = list[next++];
        const st = await withRetry(() => fetchJson(`${base}/address/${w.address}`), deps.retryWaitMs);
        if ((st?.chain_stats?.tx_count ?? 0) + (st?.mempool_stats?.tx_count ?? 0) > 0) used.add(w.address);
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
    return used;
  };
  if (!watched.length) return new Set();
  const server = await (deps.serverFor ?? serverFor)(network, userServers, deps);
  if (!server) return viaWebsite();
  try {
    return await (deps.electrumUsed ?? electrumUsed)(server, network, watched, deps);
  } catch (e) {
    if (server.own) throw e;
    console.warn(`default Electrum server failed, using the website lookups: ${e.message}`);
    return viaWebsite();
  }
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
