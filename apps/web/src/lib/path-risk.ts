// What a set of paths means for the person building it, computed from
// the paths themselves and shown while they are still choosing keys
// (2026-11-11, operator: "the consequence being known upfront").
//
// Since this date the builder lets one key be picked on more than one
// path. That is a real design choice with a real cost: one loss, or one
// theft, now touches several paths at once. Every sentence this file
// produces is derived from the draft -- which paths the key is on, which
// of them cannot open without it, and how long until the first path that
// can. Nothing here is static copy.
//
// Pure: no React, no network, no clock. Tested by scripts/test-path-risk.mjs.

import { durationWords } from './timelock-words';

/** Where a key lives, as far as this browser can honestly tell.
 *  browser -- its seed is held in this browser (a hot key).
 *  outside -- brought in by its public half only (a hardware wallet, a
 *             key on another device, or a Tapit key): this browser never
 *             holds the seed.
 *  member  -- made by an invited person on their own device; we cannot
 *             see what kind of device that is. */
export type KeyKind = 'browser' | 'outside' | 'member';

export function keyKind(origin: string | undefined): KeyKind {
  if (origin === 'software') return 'browser';
  if (origin === 'member') return 'member';
  return 'outside';
}

export interface RiskKey { keyId: string; label: string; kind: KeyKind }

export interface RiskPath {
  id: string;
  label: string;
  /** How many keys this path will hold once every slot is filled. */
  slots: number;
  quorum: number;
  keys: RiskKey[];
  unlock: 'immediate' | 'after' | 'older';
  /** For 'after': blocks from when the vault is made. For 'older':
   *  blocks the coins must sit untouched. 0 for 'immediate'. */
  blocks: number;
  /** One fewer signature needed every stepBlocks, down to floorQuorum. */
  decay?: { stepBlocks: number; floorQuorum: number } | null;
}

export type RiskLevel = 'good' | 'info' | 'warn' | 'danger';
export interface RiskNote { level: RiskLevel; text: string }

const q = (s: string) => `"${s}"`;
function listWords(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** True when this path cannot open unless this key signs. */
export function keyRequiredOn(path: RiskPath, keyId: string): boolean {
  return path.keys.some(k => k.keyId === keyId) && path.slots - 1 < path.quorum;
}

/** Blocks until this path can be used WITHOUT the given key, or null if
 *  it never can. A path the key is not on is simply its own wait. */
export function waitWithout(path: RiskPath, keyId: string): number | null {
  if (!path.keys.some(k => k.keyId === keyId)) return path.blocks;
  const others = path.slots - 1;
  if (others <= 0) return null;
  if (path.quorum <= others) return path.blocks;
  // Needs every key today. A path that relaxes over time gets there
  // once enough steps have passed for the others to be enough.
  const d = path.decay;
  if (path.unlock !== 'immediate' && d && d.stepBlocks > 0 && d.floorQuorum <= others) {
    return path.blocks + d.stepBlocks * (path.quorum - others);
  }
  return null;
}

export type LossOutcome =
  | { kind: 'now'; path: RiskPath }
  | { kind: 'wait'; path: RiskPath; blocks: number }
  | { kind: 'never' };

/** If this key were lost today: the soonest way the bitcoin can still move. */
export function lossOutcome(paths: RiskPath[], keyId: string): LossOutcome {
  let best: { path: RiskPath; blocks: number } | null = null;
  for (const p of paths) {
    const w = waitWithout(p, keyId);
    if (w == null) continue;
    if (!best || w < best.blocks) best = { path: p, blocks: w };
  }
  if (!best) return { kind: 'never' };
  return best.blocks <= 0 ? { kind: 'now', path: best.path } : { kind: 'wait', path: best.path, blocks: best.blocks };
}

function waitWords(path: RiskPath, blocks: number): string {
  return path.unlock === 'older'
    ? `the coins have sat untouched for ${durationWords(blocks)}`
    : `${durationWords(blocks)} after the vault is made`;
}

/** The one sentence set for a key that sits on more than one path. */
export function sharedKeyNote(paths: RiskPath[], key: RiskKey, here: RiskPath): RiskNote | null {
  const on = paths.filter(p => p.keys.some(k => k.keyId === key.keyId));
  if (on.length < 2) return null;
  const others = on.filter(p => p.id !== here.id).map(p => q(p.label));
  const dead = on.filter(p => waitWithout(p, key.keyId) == null).map(p => q(p.label));
  const out = lossOutcome(paths, key.keyId);

  let lost: string;
  let level: RiskLevel;
  const stops = dead.length ? `${listWords(dead)} ${dead.length === 1 ? 'stops' : 'stop'} working for good, and ` : '';
  if (out.kind === 'never') {
    level = 'danger';
    lost = 'If it is lost, this bitcoin can never be moved: every path needs this key.';
  } else if (out.kind === 'now') {
    level = dead.length ? 'warn' : 'info';
    lost = `If it is lost, ${stops}you can still spend right away through ${q(out.path.label)}.`;
  } else {
    level = 'warn';
    lost = `If it is lost, ${stops}nothing can move until ${q(out.path.label)} opens without it: ${waitWords(out.path, out.blocks)}.`;
  }
  const stolen = `If it is stolen, the thief holds one of the signatures needed on ${on.length === 2 ? 'both' : `all ${on.length}`} of these paths.`;
  return { level, text: `${q(key.label)} is also on ${listWords(others)}. ${lost} ${stolen}` };
}

/** Does the vault mix separate-device keys with browser keys at all?
 *  Only then is "is the separate-device key actually required" a
 *  question worth raising. */
function mixesKinds(paths: RiskPath[]): boolean {
  const all = paths.flatMap(p => p.keys);
  return all.some(k => k.kind === 'outside') && all.some(k => k.kind === 'browser');
}

/** Can this path open with no separate-device key signing? Counted on
 *  the slots that could be anything but a known separate-device key, so
 *  an empty slot is not assumed to be a hardware wallet. */
export function opensWithoutOutsideKey(path: RiskPath): boolean {
  const outside = path.keys.filter(k => k.kind === 'outside').length;
  return path.slots - outside >= path.quorum;
}

function outsideNote(path: RiskPath): RiskNote | null {
  if (path.keys.length === 0) return null;
  const outside = path.keys.filter(k => k.kind === 'outside');
  if (!opensWithoutOutsideKey(path)) {
    return { level: 'good', text: 'This path cannot open without a separate-device key signing. A stolen phone or browser is not enough here.' };
  }
  const browserOnly = path.keys.filter(k => k.kind === 'browser').length >= path.quorum;
  const lead = browserOnly
    ? 'This path can be opened by keys kept in this browser alone.'
    : 'This path can open without any separate-device key signing.';
  const named = outside.length
    ? ` ${listWords(outside.map(k => q(k.label)))} ${outside.length === 1 ? 'is' : 'are'} on it but not required.`
    : '';
  const others = path.slots - outside.length;
  const fix = outside.length
    ? ` To make it required, set how many must agree to more than ${others}, the number of other keys on this path.`
    : ' A hardware wallet guards a path only when the path cannot open without it.';
  return { level: 'warn', text: lead + named + fix };
}

/** Everything to show under one path, most serious first. */
export function pathNotes(paths: RiskPath[], pathId: string): RiskNote[] {
  const here = paths.find(p => p.id === pathId);
  if (!here) return [];
  const notes: RiskNote[] = [];
  for (const k of here.keys) {
    const n = sharedKeyNote(paths, k, here);
    if (n) notes.push(n);
  }
  if (mixesKinds(paths)) {
    const n = outsideNote(here);
    if (n) notes.push(n);
  }
  const rank: Record<RiskLevel, number> = { danger: 0, warn: 1, info: 2, good: 3 };
  return notes.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** One line for the whole vault, shown above the paths, once it holds
 *  both a separate-device key and a browser key. */
export function vaultNote(paths: RiskPath[]): RiskNote | null {
  if (!mixesKinds(paths)) return null;
  const filled = paths.filter(p => p.keys.length > 0);
  const open = filled.filter(opensWithoutOutsideKey);
  if (open.length === 0) {
    return { level: 'good', text: 'Every path here needs a separate-device key to sign. That is the strongest set-up: nothing in this vault can be spent from a phone or browser alone.' };
  }
  return {
    level: 'warn',
    text: `The strongest set-up is a hardware wallet, made with good randomness, required on every spend. Right now ${listWords(open.map(p => q(p.label)))} can open without one. Each path below says how to change that.`,
  };
}
