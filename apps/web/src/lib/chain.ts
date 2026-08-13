import { EXPLORER, type Network } from '../config';

/**
 * Current tip block height on the requested network, fetched from
 * mempool.space. Used by the trust overview to render real-time
 * countdowns ("Recovery path unlocks in 17,432 blocks, ~4 months").
 *
 * Cached in-memory per network for 60s so a page that renders
 * multiple countdowns doesn't hammer the endpoint.
 */

interface CacheEntry {
  height: number;
  fetchedAt: number;
}

const cache = new Map<Network, CacheEntry>();
const TTL_MS = 60_000;

export async function tipHeight(network: Network): Promise<number> {
  const cached = cache.get(network);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.height;

  const res = await fetch(`${EXPLORER[network].api}/blocks/tip/height`);
  if (!res.ok) throw new Error(`Block height fetch failed: ${res.status}`);
  const text = await res.text();
  const height = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(height)) throw new Error(`Invalid height: ${text}`);

  cache.set(network, { height, fetchedAt: Date.now() });
  return height;
}

/**
 * Confirmation status of a broadcast transaction, straight from
 * mempool.space (same client-side, no-backend-proxy pattern as
 * tipHeight above). Used to show a live confirmation count on
 * proposal history rows once a spend has been broadcast.
 */
export async function txStatus(
  network: Network,
  txid: string,
): Promise<{ confirmed: boolean; blockHeight: number | null }> {
  const res = await fetch(`${EXPLORER[network].api}/tx/${txid}/status`);
  if (!res.ok) throw new Error(`Tx status fetch failed: ${res.status}`);
  const body = (await res.json()) as { confirmed: boolean; block_height?: number };
  return { confirmed: body.confirmed, blockHeight: body.confirmed ? (body.block_height ?? null) : null };
}

/**
 * Confirmation count for a broadcast txid, derived from txStatus + the
 * cached chain tip. 0 means broadcast but still unconfirmed (in the
 * mempool); null means not yet known (still loading, or the lookup
 * failed -- best-effort, callers should just omit the count in that case).
 */
export async function txConfirmations(network: Network, txid: string): Promise<number | null> {
  const [status, tip] = await Promise.all([txStatus(network, txid), tipHeight(network)]);
  if (!status.confirmed || status.blockHeight == null) return 0;
  return Math.max(1, tip - status.blockHeight + 1);
}

/**
 * Convert a BIP65/BIP68-style "after(N)" block count into a
 * human-readable countdown relative to the current tip.
 * `afterBlocks` here is the absolute block height the policy uses
 * (in our schema recovery_after / inheritance_after are stored as
 * block counts measured from the vault's first confirmed spend,
 * but the UI treats them as countdowns-from-now for simplicity).
 */
export function blocksToApproxLabel(blocks: number): string {
  if (blocks <= 0) return 'Available now';
  const minutes = blocks * 10;
  const days = minutes / 60 / 24;
  if (days < 1) return `~${Math.round(minutes / 60)} hours`;
  if (days < 60) return `~${Math.round(days)} days`;
  if (days < 365) return `~${Math.round(days / 30)} months`;
  const years = days / 365;
  return `~${years.toFixed(1)} years`;
}

export function approxWallclockDate(blocksFromNow: number): Date {
  const ms = blocksFromNow * 10 * 60 * 1000;
  return new Date(Date.now() + ms);
}

/**
 * Inverse of approxWallclockDate: how many blocks from now (at the
 * same ~10-min average) until a target wall-clock instant. Lets the
 * vault builder accept a real calendar date + time (a graduation, a
 * birthday, a wedding) and store it the same way every other timelock
 * is stored -- a relative block count the compiler adds to the chain
 * tip at compile time. Clamped to 0: a date already in the past just
 * means "available now," same as any other zero-or-negative timelock.
 */
export function blocksUntilDate(target: Date): number {
  const ms = target.getTime() - Date.now();
  return Math.max(0, Math.round(ms / (10 * 60 * 1000)));
}
