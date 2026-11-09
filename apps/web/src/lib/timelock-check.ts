/**
 * timelock-check.ts -- the browser's own check that a compiled vault's
 * absolute timelocks are the ones the human asked for.
 *
 * Every `after(N)` leaf is compiled server-side as `tip + offset`, where
 * the Netlify function fetches `tip` from mempool.space. Nothing used to
 * check that number: a wrong tip (an API bug, a changed API base in the
 * Netlify environment, a tampered function) would compile a vault whose
 * recovery and inheritance doors are already open the day it is funded,
 * and the only symptom would be a height nobody reads by hand. These two
 * pure functions close that: the wizard fetches the tip itself (a
 * separate request from the server's), refuses an implausible tip
 * outright, and refuses to accept a compiled vault whose every absolute
 * height is not `tip + the offset chosen` within a few blocks of slack.
 *
 * Pure and DOM-free so `scripts/test-timelock-check.mjs` can prove it.
 */

import type { Network } from '../config';

/** A height below which the real chain cannot be. Mirrors TIP_FLOOR in
 *  netlify/functions/_chain.js (the functions cannot import app code).
 *  Measured 2026-11-09: bitcoin 975,224; testnet3 5,322,818; signet
 *  330,163. Floors sit well below so they never false-positive, and far
 *  above anything a broken feed would plausibly return (0, a small
 *  count, a different network's height). Raise them occasionally; never
 *  lower them. */
export const TIP_FLOOR: Record<Network, number> = {
  bitcoin: 900_000,
  testnet: 5_000_000,
  signet: 300_000,
};

/** Blocks of disagreement tolerated between the server's tip and the
 *  browser's (two separate fetches seconds apart, plus the odd fast
 *  block). 12 blocks is ~2 hours -- generous for the honest case and
 *  useless to an attacker, whose wrong heights are off by thousands. */
export const TIP_SLACK_BLOCKS = 12;

export function checkTipFloor(network: Network, tip: number): string | null {
  if (!Number.isSafeInteger(tip) || tip <= 0) return `Implausible ${network} chain tip: ${tip}`;
  const floor = TIP_FLOOR[network];
  if (floor !== undefined && tip < floor) {
    return `Implausible ${network} chain tip ${tip.toLocaleString()} (the real chain is past ${floor.toLocaleString()})`;
  }
  return null;
}

export interface TimelockPair {
  /** Human label for the error message ("Recovery", "Kids alone"). */
  label: string;
  /** The relative offset the human chose, in blocks. 0 = no timelock. */
  offsetBlocks: number;
  /** The absolute height the server compiled. 0 = no timelock. */
  absoluteBlocks: number;
  /** 'after' heights are tip + offset; 'older' durations must come back
   *  unchanged (BIP68 relative locks are never converted). */
  kind?: 'after' | 'older';
}

export interface TimelockCheckResult {
  ok: boolean;
  problems: string[];
}

export function checkAbsoluteTimelocks(
  pairs: TimelockPair[],
  tip: number,
  network: Network,
  slack: number = TIP_SLACK_BLOCKS,
): TimelockCheckResult {
  const problems: string[] = [];
  const floorProblem = checkTipFloor(network, tip);
  if (floorProblem) problems.push(floorProblem);

  for (const p of pairs) {
    const kind = p.kind ?? 'after';
    if (!Number.isSafeInteger(p.absoluteBlocks) || p.absoluteBlocks < 0) {
      problems.push(`${p.label}: compiled height is not a valid block number (${p.absoluteBlocks})`);
      continue;
    }
    if (p.offsetBlocks <= 0) {
      if (p.absoluteBlocks !== 0) {
        problems.push(`${p.label}: compiled with a timelock (block ${p.absoluteBlocks.toLocaleString()}) that was never asked for`);
      }
      continue;
    }
    if (kind === 'older') {
      if (p.absoluteBlocks !== p.offsetBlocks) {
        problems.push(`${p.label}: relative wait came back as ${p.absoluteBlocks.toLocaleString()} blocks, not the ${p.offsetBlocks.toLocaleString()} you chose`);
      }
      continue;
    }
    if (p.absoluteBlocks === 0) {
      problems.push(`${p.label}: compiled with NO timelock, but you asked for ${p.offsetBlocks.toLocaleString()} blocks`);
      continue;
    }
    const fromNow = p.absoluteBlocks - tip;
    if (Math.abs(fromNow - p.offsetBlocks) > slack) {
      problems.push(
        `${p.label}: compiled to unlock at block ${p.absoluteBlocks.toLocaleString()}, which is ${fromNow.toLocaleString()} blocks from now, not the ${p.offsetBlocks.toLocaleString()} you chose`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}
