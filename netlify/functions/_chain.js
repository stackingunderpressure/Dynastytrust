/**
 * _chain.js -- shared mempool.space client.
 *
 * Started as a tip-height helper for the compile pipeline (converting
 * relative block offsets into absolute CLTV heights -- Miniscript's
 * `after(N)` compiles to OP_CLTV, which is ALWAYS absolute, so a raw
 * offset would put the leaf's N long in the past and the path would
 * unlock immediately). The MEMPOOL base-URL map and a couple of small
 * fetch helpers were independently copy-pasted into six other
 * functions; this is now the single source for all of it.
 */

// The pure timelock rules (floor and ceiling, tip floor, tip
// reconciliation, relative -> absolute) live in packages/vault-rules, ONE
// copy shared with the downloaded app; re-exported here so every function
// keeps importing them from ./_chain.js.
import { TIP_FLOOR, reconcileTips } from "../../packages/vault-rules/src/timelocks.js";
export {
  MIN_RECOVERY_BLOCKS, MAX_TIMELOCK_OFFSET_BLOCKS, checkTimelockFloor,
  TIP_FLOOR, TIP_SOURCE_MAX_DIFF, reconcileTips, relativeToAbsolute,
} from "../../packages/vault-rules/src/timelocks.js";

export const MEMPOOL = {
  testnet: "https://mempool.space/testnet/api",
  signet:  "https://mempool.space/signet/api",
  bitcoin: "https://mempool.space/api",
};

// Mirrors protocol/src/policy_compiler.rs's MIN_RECOVERY_BLOCKS. Single
// source of truth for every Netlify endpoint that must floor-check a raw
// relative block offset (recovery_after, inheritance_after,
// parent_solo_after, kids_decay_start_after, a generic leaf's
// unlock.blocks, second_inheritance_after) BEFORE relativeToAbsolute
// below converts it into an absolute CLTV height. Once absolute (tip +
// offset, generally in the hundreds of thousands on any live network),
// Rust's own `< MIN_RECOVERY_BLOCKS` checks are structurally a no-op --
// this was first fixed for compile.js's recovery_after (2026-08-XX
// security audit) and is centralized here so every sibling timelock
// field gets the identical check rather than each endpoint re-deriving
// (and, as happened, sometimes forgetting) it (Kimi K3 scan Family D).
/** GET a mempool.space URL and parse the JSON body. Throws on a non-2xx status. */
export async function mempoolFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mempool.space ${res.status}: ${url}`);
  return res.json();
}

/** Current recommended fee rate (sat/vB) for a network. Falls back to 5 sat/vB on any failure. */
export async function getFeeRate(network) {
  try {
    const base = MEMPOOL[network] || MEMPOOL.testnet;
    const fees = await mempoolFetch(`${base}/v1/fees/recommended`);
    return fees.halfHourFee || fees.economyFee || 5;
  } catch { return 5; }
}

// A height below which the real chain cannot be. Mirrors TIP_FLOOR in
// apps/web/src/lib/timelock-check.ts (this file cannot import app code).
// Measured 2026-11-09: bitcoin 975,224; testnet3 5,322,818; signet 330,163.
// Every absolute CLTV height this backend bakes is tip + offset; a tip
// that is wrong by a lot (a feed bug, a changed API base, a tampered
// response) would compile recovery/inheritance doors that are already
// open at funding. The browser re-checks the heights it gets back
// against its own tip fetch (timelock-check.ts); this floor is the
// server's half of the same defense. Raise occasionally; never lower.

// Second, independent source for the chain tip (Blockstream's Esplora).
// One feed deciding an irreversible absolute timelock is one feed too
// few: fetchVerifiedTipHeight below requires BOTH to answer and to agree.
export const SECOND_SOURCE = {
  testnet: "https://blockstream.info/testnet/api",
  signet:  "https://blockstream.info/signet/api",
  bitcoin: "https://blockstream.info/api",
};

// Honest sources differ by a block or two while a new block propagates.
// Mirrors TIP_SOURCE_MAX_DIFF in apps/web/src/lib/timelock-check.ts.

async function fetchTipFrom(base, network, sourceName) {
  const res = await fetch(`${base}/blocks/tip/height`);
  if (!res.ok) {
    throw new Error(`${sourceName} tip height ${res.status}`);
  }
  const text = (await res.text()).trim();
  if (!/^\d{1,9}$/.test(text)) {
    throw new Error(`bad ${sourceName} tip height response: ${text.slice(0, 40)}`);
  }
  const height = parseInt(text, 10);
  const floor = TIP_FLOOR[network] ?? 0;
  if (!Number.isSafeInteger(height) || height < floor) {
    throw new Error(`implausible ${network} tip height ${height} from ${sourceName} (the real chain is past ${floor})`);
  }
  return height;
}

export async function fetchTipHeight(network) {
  return fetchTipFrom(MEMPOOL[network] || MEMPOOL.testnet, network, "mempool.space");
}

/**
 * The tip to use for anything irreversible (baking tip + offset into a
 * vault's after() leaves). Both sources must answer and agree; if
 * either is down this FAILS rather than trusting one feed -- compiling
 * a vault a few minutes later is cheap, a wrong timelock is forever.
 */
export async function fetchVerifiedTipHeight(network) {
  const [a, b] = await Promise.all([
    fetchTipFrom(MEMPOOL[network] || MEMPOOL.testnet, network, "mempool.space"),
    fetchTipFrom(SECOND_SOURCE[network] || SECOND_SOURCE.testnet, network, "blockstream.info"),
  ]);
  return reconcileTips(a, b);
}
