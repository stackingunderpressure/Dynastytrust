// Spending a v2 vault ("a new address every time") -- ranged slice 5,
// docs/ranged-addresses-slice5-build-note.md.
//
// Coins come from every one of the vault's addresses (_vault-coins.js). The
// PSBT is built in-process by the compiler wasm (/ranged-spend): the path is
// named by its leaf script at receive/0 and the Rust refuses a leaf that is
// not in the vault's tree; the lock is read from the leaf itself. Change,
// when there is any, goes to a never-used change address reserved from the
// database and recorded before the PSBT is handed out.
//
// Operator's chips (2026-11-24): an "if left untouched" path offers only the
// coins that have sat long enough (each coin has its own clock); coin choice
// is fewest coins (largest first, selectCoins), and the answer says when a
// spend combines coins from several addresses.

import { callWasm, rangedAddress } from "./_ranged-wasm.js";
import { nextIndexes, vaultCoins, vaultUsed, watchedAddresses } from "./_vault-coins.js";
import { reusableChange } from "./_receive-choice.js";
import { fetchTipHeight, getFeeRate } from "./_chain.js";
import { inputVbytesFor, selectCoins } from "../../packages/vault-rules/src/spend.js";

const CHANGE = 1;
const SWAP = { recovery: "backup", backup: "recovery" };

/** The path's leaf script at receive/0 (hex), from the compiled vault. */
export function leafAtZero(vault, path) {
  const ls = vault.leaf_scripts && typeof vault.leaf_scripts === "object" ? vault.leaf_scripts : {};
  return ls[path] || (SWAP[path] ? ls[SWAP[path]] : null) || null;
}

/** The "if left untouched" wait a leaf-list path declares, or null. */
export function olderBlocksFor(vault, path) {
  const leaf = Array.isArray(vault.leaves) ? vault.leaves.find((l) => l?.id === path) : null;
  const u = leaf?.unlock;
  return u && (u.type === "older" || u.type === "older_than") && Number.isInteger(u.blocks) ? u.blocks : null;
}

/** Coins that have sat at least `blocks` blocks by the next block. */
export function oldEnough(coins, tip, blocks) {
  if (!blocks) return { ready: coins, waiting: [] };
  const ready = [], waiting = [];
  for (const c of coins) {
    const h = c.status?.block_height;
    const confs = Number.isInteger(h) && Number.isInteger(tip) ? tip - h + 1 : 0;
    if (confs >= blocks) ready.push(c);
    else waiting.push({ txid: c.txid, vout: c.vout, value_sats: c.value, blocks_left: blocks - confs });
  }
  return { ready, waiting };
}

/**
 * Build the spend. Returns { status, body } for the handler to send.
 * `deps` lets tests stand in the chain and the wasm.
 */
export async function buildRangedSpend({ supabase, vault, userId, body, userServers = {} }, deps = {}) {
  const call = deps.callWasm ?? callWasm;
  // Electrum when there is a server for this network (the person's own, or
  // the default); the tip that decides "old enough" stays the two-source
  // check below, never a user-chosen server.
  const coinsFor = deps.coinsAt ?? (async (network, watched) => (await vaultCoins(network, watched, userServers)).coins);
  const tipOf = deps.fetchTipHeight ?? fetchTipHeight;
  const feeOf = deps.getFeeRate ?? getFeeRate;
  const { destination, amount_sats, fee_rate, path = "founders_now", selected_utxos, sweep } = body;
  const network = vault.network || "testnet";

  const leaf = leafAtZero(vault, path);
  if (!leaf) return { status: 400, body: { error: `This vault has no "${path}" path.` } };

  let watched;
  try {
    watched = watchedAddresses(vault, await nextIndexes(supabase, vault.id), call);
  } catch (e) {
    return { status: 500, body: { error: `This vault's addresses could not be worked out, so nothing was built: ${e.message}` } };
  }
  let coins, tip;
  try {
    [coins, tip] = await Promise.all([coinsFor(network, watched), tipOf(network)]);
  } catch (e) {
    return { status: 502, body: { error: "Could not fetch coins: " + e.message } };
  }
  const confirmed = (coins || []).filter((c) => c.status?.confirmed);
  if (!confirmed.length) {
    return { status: 200, body: { ok: true, status: "no_utxos", message: "No confirmed coins. Fund the vault and wait for a confirmation.", address: vault.address } };
  }

  // Decision 2: each coin's own clock.
  const older = olderBlocksFor(vault, path);
  const { ready, waiting } = oldEnough(confirmed, tip, older);
  if (older && !ready.length) {
    return { status: 400, body: { ok: false, error: `No coin has sat untouched long enough for this path yet. The soonest is ready in ${Math.min(...waiting.map((w) => w.blocks_left))} blocks.`, waiting } };
  }

  const rate = fee_rate || (await feeOf(network));
  const picked = selectCoins({ confirmed: ready, amount_sats, sweep, selected_utxos, rate, inputVbytes: inputVbytesFor(vault, path) });
  if (!picked.ok) return { status: picked.status, body: { ...picked.body, ...(waiting.length ? { waiting } : {}) } };

  // A never-used change address, only when there is change. First the
  // lowest change address already issued but never paid -- left by a spend
  // built and never sent -- so abandoned spends leave no gap a restoring
  // wallet could stop at (docs/receive-address-reuse-until-paid-build-
  // note.md); otherwise a new one, reserved.
  let changeIndex = 0;
  let changeReused = false;
  if (picked.hasChange) {
    const usedOf = deps.vaultUsed ?? vaultUsed;
    const { data: issuedChange, error: cErr } = await supabase
      .from("vault_addresses").select("idx, address").eq("vault_id", vault.id).eq("branch", CHANGE).order("idx", { ascending: true }).limit(5000);
    if (cErr) return { status: 500, body: { error: `Could not read the change addresses: ${cErr.message}` } };
    let reuse = null;
    if (issuedChange?.length) {
      try {
        const used = await usedOf(network, issuedChange.map((a) => ({ branch: CHANGE, index: a.idx, address: a.address })), userServers);
        reuse = reusableChange(issuedChange, used);
      } catch (e) {
        return { status: 502, body: { error: "Could not check the change addresses: " + e.message } };
      }
    }
    if (reuse) {
      changeIndex = reuse.idx;
      changeReused = true;
    } else {
      const { data, error } = await supabase.rpc("reserve_vault_address_index", { p_vault_id: vault.id, p_branch: CHANGE });
      if (error || !Number.isInteger(data)) return { status: 500, body: { error: `Could not reserve a change address: ${error?.message || "no index"}` } };
      changeIndex = data;
    }
  }

  const where = new Map(watched.map((w) => [w.address, w]));
  const inputs = picked.selected.map((c) => ({ txid: c.txid, vout: c.vout, value_sats: c.value, branch: c.branch ?? where.get(c.address)?.branch, index: c.index ?? where.get(c.address)?.index }));
  if (inputs.some((i) => !Number.isInteger(i.branch) || !Number.isInteger(i.index))) {
    return { status: 500, body: { error: "A coin's address could not be placed in this vault, so nothing was built." } };
  }

  const r = call("/ranged-spend", {
    multipath: vault.descriptor_multipath,
    receive: vault.descriptor_receive,
    change: vault.descriptor_change,
    network,
    inputs,
    destination,
    amount_sats: picked.amountSatsFinal,
    fee_sats: picked.finalFee,
    change_index: changeIndex,
    leaf_at_zero: leaf,
  });
  if (r.status !== 200 || !r.body?.ok) return { status: 422, body: { error: `The spend could not be built: ${r.body?.error || r.status}` } };
  if ((r.body.relative_blocks ?? null) !== (older ?? null)) {
    return { status: 500, body: { error: "This path's wait does not match the vault's record, so nothing was built." } };
  }

  if (r.body.change_address) {
    let derived;
    try {
      derived = rangedAddress(vault, CHANGE, changeIndex);
    } catch (e) {
      return { status: 500, body: { error: `The change address could not be checked: ${e.message}` } };
    }
    if (derived.address !== r.body.change_address) return { status: 500, body: { error: "The change address did not match, so nothing was built." } };
    // A reused change address is already recorded.
    const { error } = changeReused ? { error: null } : await supabase.from("vault_addresses").insert({
      vault_id: vault.id, branch: CHANGE, idx: changeIndex, address: derived.address,
      script_pubkey: derived.script_pubkey, descriptor_checksum: derived.descriptor_checksum, issued_by: userId, label: null,
    });
    if (error) return { status: 500, body: { error: `The change address could not be recorded, so nothing was built: ${error.message}` } };
  }

  const addressesCombined = new Set(inputs.map((i) => `${i.branch}/${i.index}`)).size;
  return {
    status: 200,
    body: {
      ok: true,
      psbt_hex: r.body.psbt_hex,
      psbt_b64: r.body.psbt_b64,
      summary: {
        vault_name: vault.name,
        vault_address: vault.address,
        destination,
        amount_sats: picked.amountSatsFinal,
        fee_sats: picked.finalFee,
        change_sats: r.body.change_sats,
        change_address: r.body.change_address,
        fee_rate: rate,
        input_count: inputs.length,
        total_in_sats: picked.totalIn,
        network,
        path,
        addresses_combined: addressesCombined,
        lock_time: r.body.lock_time,
        relative_blocks: r.body.relative_blocks,
        ...(waiting.length ? { waiting } : {}),
      },
    },
  };
}
