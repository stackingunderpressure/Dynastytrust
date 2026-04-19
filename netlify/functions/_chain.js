/**
 * _chain.js -- mempool.space tip helper for the compile pipeline.
 *
 * Converts relative block offsets ("6 months from now") into
 * absolute CLTV heights (current_tip + offset) right before
 * forwarding to the Fly.io compiler. Required because Miniscript's
 * `after(N)` compiles to OP_CLTV, which is ALWAYS absolute -- if we
 * store the raw offset, the leaf's N is long past on mainnet /
 * testnet / signet and the path unlocks immediately.
 */

const MEMPOOL = {
  testnet: "https://mempool.space/testnet/api",
  signet:  "https://mempool.space/signet/api",
  bitcoin: "https://mempool.space/api",
};

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
