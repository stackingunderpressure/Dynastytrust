/**
 * timelock-words.ts -- saying a timelock out loud, truthfully.
 *
 * Every timelock on a named-field vault is an ABSOLUTE Bitcoin block
 * height (CLAUDE.md, "Timelocks are absolute CLTV"). That has one
 * consequence people get wrong, and that this app itself used to state
 * wrongly ("triggered only if the trustees are unreachable"): the path
 * opens at that block whatever anyone does or does not do before it.
 * Nothing resets it. The only way to keep it closed longer is to move
 * the coins to a new vault with a later date.
 *
 * Three screens turn the same height into words (the vault page, the
 * dashboard, the rotate dialog); the dashboard used to turn the height
 * itself into a duration, so an heir saw a number that never moved.
 * They all read from here now. Pure: the tip and the clock are
 * arguments. Dates are estimates at ten minutes a block and always say
 * so ("around").
 */

export const BLOCKS_PER_DAY = 144;
export const BLOCKS_PER_YEAR = 52_560;

/** Blocks still to wait, 0 once open, null when it cannot be known
 *  (no such path, or the chain tip has not loaded). */
export function blocksLeft(absHeight: number | null | undefined, tip: number | null | undefined): number | null {
  if (!absHeight || absHeight <= 0 || tip == null) return null;
  return Math.max(0, absHeight - tip);
}

/** "about 3 days", "about 4 months", "about 2.5 years". */
export function durationWords(blocks: number): string {
  const days = Math.max(0, Math.round(blocks / BLOCKS_PER_DAY));
  if (days < 1) return 'less than a day';
  if (days === 1) return 'about 1 day';
  if (days < 60) return `about ${days} days`;
  if (days < 365) return `about ${Math.round(days / 30)} months`;
  const years = Math.round((days / 365) * 10) / 10;
  return years === 1 ? 'about 1 year' : `about ${years} years`;
}

/** When a height is expected, as a calendar estimate. */
export function estimatedDate(absHeight: number, tip: number, now: Date): Date {
  return new Date(now.getTime() + (absHeight - tip) * 10 * 60 * 1000);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "14 March 2031" when it is within about two months (a day matters),
 *  otherwise "March 2031" (a day would be false precision). UTC. */
export function dateWords(d: Date, blocksAway: number): string {
  const month = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return Math.abs(blocksAway) <= 60 * BLOCKS_PER_DAY ? `${d.getUTCDate()} ${month}` : month;
}

/** "open now", or "in about 4.2 years, around March 2031". */
export function opensWords(absHeight: number, tip: number, now: Date): string {
  const left = Math.max(0, absHeight - tip);
  if (left === 0) return 'open now';
  return `in ${durationWords(left)}, around ${dateWords(estimatedDate(absHeight, tip, now), left)}`;
}

/** The one line an heir's dashboard card shows. Null when the tip is
 *  not known yet -- say nothing rather than a number that is wrong. */
export function heirDashboardLine(inheritanceAfter: number | null | undefined, tip: number | null | undefined): string | null {
  const left = blocksLeft(inheritanceAfter, tip);
  if (left == null) return null;
  return left === 0 ? 'Inheritance is open -- you can act now' : `Inheritance opens in ${durationWords(left)}`;
}

/** Choices offered when rotating: how much later than the CURRENT date
 *  the new vault's date should be. */
export const ROTATE_EXTENSIONS: readonly { label: string; extraBlocks: number }[] = [
  { label: 'Keep the same date', extraBlocks: 0 },
  { label: '+1 year', extraBlocks: BLOCKS_PER_YEAR },
  { label: '+3 years', extraBlocks: 3 * BLOCKS_PER_YEAR },
  { label: '+5 years', extraBlocks: 5 * BLOCKS_PER_YEAR },
];

/**
 * What a chosen offset means for a rotated vault, against the vault it
 * replaces. `offsetBlocks` counts from now (the compiler adds the tip).
 * The comparison is what a founder actually needs: rotating with the
 * time that is left keeps the SAME date, which pushes nothing out.
 */
export function rotateDateWords(offsetBlocks: number, oldAbsHeight: number | null | undefined, tip: number, now: Date): string {
  if (!(offsetBlocks > 0)) return 'No waiting period: this path would be open as soon as the new vault exists.';
  const when = dateWords(estimatedDate(tip + offsetBlocks, tip, now), offsetBlocks);
  const base = `Opens around ${when} (${durationWords(offsetBlocks)} from now).`;
  if (!oldAbsHeight || oldAbsHeight <= 0) return base;
  const diff = tip + offsetBlocks - oldAbsHeight;
  if (oldAbsHeight <= tip) return `${base} This vault's own date has already passed.`;
  if (Math.abs(diff) < 7 * BLOCKS_PER_DAY) return `${base} That is the SAME date as this vault -- it does not push anything out.`;
  return diff > 0
    ? `${base} That is ${durationWords(diff)} LATER than this vault.`
    : `${base} That is ${durationWords(-diff)} EARLIER than this vault.`;
}
