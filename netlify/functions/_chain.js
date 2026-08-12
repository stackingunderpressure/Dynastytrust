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
