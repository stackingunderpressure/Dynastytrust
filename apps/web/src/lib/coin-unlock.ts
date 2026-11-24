// When each of a vault's paths opens for ONE coin (operator, 2026-11-24:
// "Both showing blocks left estimated date till unlock of each one").
// docs/coin-unlock-view-build-note.md.
//
// A dated path ("after", absolute height h) opens for every coin at once:
// a spend is valid in a block once that block's height is past h, i.e.
// when the tip has reached h. An "if untouched" path ("older", n blocks)
// opens per coin: once the coin has n confirmations (the same rule
// _ranged-spend.js oldEnough uses, and Bitcoin Core enforced in
// scripts/bitcoin-core-ranged-proof.mjs). An unconfirmed coin's clock has
// not started. Pure: no React, no network; tested by scripts/test-coin-unlock.mjs.

import type { Vault } from './api';
import { dateWords, estimatedDate } from './timelock-words';

export type PathUnlock = { type: 'immediate' } | { type: 'after'; blocks: number } | { type: 'older'; blocks: number };
export interface TimedPath { label: string; unlock: PathUnlock }

export type CoinPathState =
  | { label: string; open: true }
  | { label: string; open: false; blocksLeft: number; approxDate: Date; startsOnConfirm: boolean };

/** The vault's paths with their unlocks: a path-builder vault's leaves, or
 *  the named-field shape's dated paths. Null for a shape this cannot read
 *  (the family plan's decay ladders) -- then nothing is shown, never a guess. */
export function vaultPaths(v: Pick<Vault, 'leaves' | 'recovery_after' | 'inheritance_after' | 'second_inheritance_after' | 'bloc_policy'>): TimedPath[] | null {
  if (Array.isArray(v.leaves) && v.leaves.length > 0) {
    return v.leaves.map(l => ({ label: l.label || l.id, unlock: l.unlock as PathUnlock }));
  }
  if (v.bloc_policy) return null;
  const out: TimedPath[] = [{ label: 'Founders', unlock: { type: 'immediate' } }];
  if (v.recovery_after > 0) out.push({ label: 'Recovery', unlock: { type: 'after', blocks: v.recovery_after } });
  if (v.inheritance_after > 0) out.push({ label: 'Inheritance', unlock: { type: 'after', blocks: v.inheritance_after } });
  if ((v.second_inheritance_after ?? 0) > 0) out.push({ label: 'Second inheritance', unlock: { type: 'after', blocks: v.second_inheritance_after! } });
  return out;
}

/** For one coin: each path, open now or how long until it opens. */
export function coinUnlocks(
  coin: { confirmed: boolean; confirmations: number },
  paths: readonly TimedPath[],
  tip: number,
  now: Date,
): CoinPathState[] {
  return paths.map(p => {
    const u = p.unlock;
    if (u.type === 'immediate') return { label: p.label, open: true };
    if (u.type === 'after') {
      const left = Math.max(0, u.blocks - tip);
      return left === 0
        ? { label: p.label, open: true }
        : { label: p.label, open: false, blocksLeft: left, approxDate: estimatedDate(tip + left, tip, now), startsOnConfirm: false };
    }
    const confs = coin.confirmed ? coin.confirmations : 0;
    const left = Math.max(0, u.blocks - confs);
    return left === 0
      ? { label: p.label, open: true }
      : { label: p.label, open: false, blocksLeft: left, approxDate: estimatedDate(tip + left, tip, now), startsOnConfirm: !coin.confirmed };
  });
}

/** "8,410 blocks left -- about 23 January 2027" (operator's chip: blocks
 *  and a rough date; a date is an estimate, blocks average ten minutes). */
export function waitWords(s: Extract<CoinPathState, { open: false }>): string {
  const blocks = `${s.blocksLeft.toLocaleString('en-US')} block${s.blocksLeft === 1 ? '' : 's'} left`;
  const when = `about ${dateWords(s.approxDate, s.blocksLeft)}`;
  return s.startsOnConfirm ? `${blocks} once it confirms -- ${when}` : `${blocks} -- ${when}`;
}
