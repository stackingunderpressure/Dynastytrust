/**
 * rotate-plan.ts -- rotating a path-builder vault, the browser's side.
 *
 * Rotation makes a NEW vault with the same paths, keys and quorums and
 * later dates; the coins are then moved to it. Two pure pieces:
 *
 *  - planRotation: from the vault's fixed heights, the chain tip and
 *    one choice ("this much later"), the waiting period each dated path
 *    gets in the new vault. Every dated path moves by the same amount,
 *    so the gaps between paths stay as they were designed.
 *
 *  - checkRotatedVault: after the server and compiler have built the
 *    successor, compare it with the vault it replaces, field by field.
 *    The new address is where the family's coins are about to be sent;
 *    nothing but the dates may differ. This is the browser not taking
 *    the server's word (netlify/functions/_rotate.js) for it.
 *
 * The compiled heights themselves are checked against tip + offset by
 * the same timelock-check.ts gate every new vault passes.
 */
import { MIN_RECOVERY_BLOCKS } from './blocks';
import { dateWords, durationWords, estimatedDate, type PathLike } from './timelock-words';

/** ~100 years; mirrors netlify/functions/_chain.js. */
export const MAX_OFFSET_BLOCKS = 5_256_000;

export interface RotationRow {
  id: string;
  label: string;
  /** "open now" or "around March 2031" for the vault being replaced. */
  oldWords: string;
  newWords: string;
  offsetBlocks: number;
}

export interface RotationPlan {
  /** Blocks from the new vault's compile, per dated path. */
  offsets: Record<string, number>;
  rows: RotationRow[];
  problems: string[];
}

export function planRotation(paths: readonly PathLike[], tip: number, shiftBlocks: number, now: Date): RotationPlan {
  const offsets: Record<string, number> = {};
  const rows: RotationRow[] = [];
  const problems: string[] = [];
  if (!Number.isSafeInteger(shiftBlocks) || shiftBlocks < 0) problems.push('The dates can only be kept or moved later.');
  for (const p of paths) {
    if (p.unlock.type !== 'after') continue;
    const left = Math.max(0, p.unlock.blocks - tip);
    const offset = left + Math.max(0, shiftBlocks);
    offsets[p.id] = offset;
    rows.push({
      id: p.id,
      label: p.label,
      oldWords: left === 0 ? 'open now' : `around ${dateWords(estimatedDate(p.unlock.blocks, tip, now), left)}`,
      newWords: `around ${dateWords(estimatedDate(tip + offset, tip, now), offset)}`,
      offsetBlocks: offset,
    });
    if (offset < MIN_RECOVERY_BLOCKS) {
      problems.push(`"${p.label}" would open in ${durationWords(offset)}. A new vault cannot have a wait shorter than ${durationWords(MIN_RECOVERY_BLOCKS)}, so choose a later date.`);
    } else if (offset > MAX_OFFSET_BLOCKS) {
      problems.push(`"${p.label}" would open more than 100 years from now. Choose an earlier date.`);
    }
  }
  if (rows.length === 0) problems.push('This vault has no dated path, so there is no date to move.');
  return { offsets, rows, problems };
}

interface VaultShape {
  network: string;
  address: string | null;
  leaves: readonly (PathLike & { decay: { step_blocks: number; floor_quorum: number } | null })[] | null;
  consent_keys?: readonly string[] | null;
  consent_quorum?: number | null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Problems that make a compiled successor NOT a faithful rotation of
 * `old`. Empty means: same network, same paths in the same order, same
 * keys, same quorums, same step-downs, same untouched-for-a-while
 * rules, same consent rule -- and a new address of its own.
 */
export function checkRotatedVault(old: VaultShape, next: VaultShape): string[] {
  const problems: string[] = [];
  const a = old.leaves ?? [], b = next.leaves ?? [];
  if (next.network !== old.network) problems.push(`the new vault is on ${next.network}, not ${old.network}`);
  if (!next.address) problems.push('the new vault has no address');
  else if (next.address === old.address) problems.push('the new vault has the same address as the old one');
  if (a.length !== b.length) problems.push(`the new vault has ${b.length} paths, the old one has ${a.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const o = a[i], n = b[i], name = `"${o.label}"`;
    if (n.id !== o.id || n.label !== o.label) { problems.push(`path ${i + 1} is ${JSON.stringify(n.label)}, not ${name}`); continue; }
    if (!same(n.keys, o.keys)) problems.push(`${name} does not have the same keys`);
    if (n.quorum !== o.quorum) problems.push(`${name} needs ${n.quorum} signatures, not ${o.quorum}`);
    if (!same(n.decay ?? null, o.decay ?? null)) problems.push(`${name} does not have the same step-down rule`);
    if (n.unlock.type !== o.unlock.type) problems.push(`${name} opens by a different kind of rule`);
    else if (o.unlock.type === 'older' && n.unlock.type === 'older' && n.unlock.blocks !== o.unlock.blocks) problems.push(`${name} has a different untouched-for period`);
    else if (o.unlock.type === 'after' && n.unlock.type === 'after' && n.unlock.blocks < o.unlock.blocks) problems.push(`${name} would open EARLIER than in the old vault`);
  }
  if (!same(next.consent_keys ?? [], old.consent_keys ?? []) || (next.consent_quorum ?? null) !== (old.consent_quorum ?? null)) {
    problems.push('the consent rule is not the same');
  }
  return problems;
}
