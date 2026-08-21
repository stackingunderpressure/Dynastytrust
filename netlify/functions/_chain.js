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
export const MIN_RECOVERY_BLOCKS = 26_000;

/**
 * Floor-check a raw relative block offset before conversion. 0/null/
 * undefined means "no leaf at this path" and is always allowed. Any
 * other value must be a safe positive integer >= MIN_RECOVERY_BLOCKS.
 * Returns null when valid, or a human-readable error string.
 */
export function checkTimelockFloor(value, fieldName) {
  if (!value) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return `${fieldName} must be a whole number of blocks.`;
  }
  if (value < MIN_RECOVERY_BLOCKS) {
    return `${fieldName} must be >= ${MIN_RECOVERY_BLOCKS} blocks (or 0 for no leaf).`;
  }
  return null;
}

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

export async function fetchTipHeight(network) {
  const base = MEMPOOL[network] || MEMPOOL.testnet;
  const res = await fetch(`${base}/blocks/tip/height`);
  if (!res.ok) {
    throw new Error(`mempool.space tip height ${res.status}`);
  }
  const text = (await res.text()).trim();
  const height = parseInt(text, 10);
  if (!Number.isFinite(height) || height < 0) {
    throw new Error(`bad tip height response: ${text}`);
  }
  return height;
}

/**
 * Given a relative offset in blocks and the chain tip, return the
 * absolute CLTV height. Pass through zero / null so "no timelock"
 * stays "no timelock".
 */
export function relativeToAbsolute(offsetBlocks, tipHeight) {
  if (!offsetBlocks || offsetBlocks <= 0) return 0;
  return tipHeight + offsetBlocks;
}
