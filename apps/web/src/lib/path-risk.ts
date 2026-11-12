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
  /** Keys that must EACH sign on this path, on top of `quorum` of `keys`
   *  (protocol::Leaf::required_keys). Never also in `keys`. */
  required?: RiskKey[];
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

const must = (p: RiskPath): RiskKey[] => p.required ?? [];
const isMust = (p: RiskPath, keyId: string) => must(p).some(k => k.keyId === keyId);
const onPath = (p: RiskPath, keyId: string) => isMust(p, keyId) || p.keys.some(k => k.keyId === keyId);

/** True when this path cannot open unless this key signs. */
export function keyRequiredOn(path: RiskPath, keyId: string): boolean {
  if (isMust(path, keyId)) return true;
  return path.keys.some(k => k.keyId === keyId) && path.slots - 1 < path.quorum;
}

/** Blocks until this path can be used WITHOUT the given key, or null if
 *  it never can. A path the key is not on is simply its own wait. */
export function waitWithout(path: RiskPath, keyId: string): number | null {
  // A must-sign key stays required on every step of a relaxing path.
  if (isMust(path, keyId)) return null;
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

// What losing this key costs, computed from every path.
function lossSentence(paths: RiskPath[], key: RiskKey): { level: RiskLevel; text: string } {
  const on = paths.filter(p => onPath(p, key.keyId));
  const dead = on.filter(p => waitWithout(p, key.keyId) == null).map(p => q(p.label));
  const out = lossOutcome(paths, key.keyId);
  const stops = dead.length ? `${listWords(dead)} ${dead.length === 1 ? 'stops' : 'stop'} working for good, and ` : '';
  if (out.kind === 'never') {
    return { level: 'danger', text: 'If it is lost, this bitcoin can never be moved: every path needs this key.' };
  }
  if (out.kind === 'now') {
    return { level: dead.length ? 'warn' : 'info', text: `If it is lost, ${stops}you can still spend right away through ${q(out.path.label)}.` };
  }
  return { level: 'warn', text: `If it is lost, ${stops}nothing can move until ${q(out.path.label)} opens without it: ${waitWords(out.path, out.blocks)}.` };
}

/** The one sentence set for a key that sits on more than one path. */
export function sharedKeyNote(paths: RiskPath[], key: RiskKey, here: RiskPath): RiskNote | null {
  const on = paths.filter(p => onPath(p, key.keyId));
  if (on.length < 2) return null;
  const others = on.filter(p => p.id !== here.id).map(p => q(p.label));
  const lost = lossSentence(paths, key);
  const stolen = `If it is stolen, the thief holds one of the signatures needed on ${on.length === 2 ? 'both' : `all ${on.length}`} of these paths.`;
  const lead = isMust(here, key.keyId) ? `${q(key.label)} must sign every spend on this path, and is also on ${listWords(others)}.` : `${q(key.label)} is also on ${listWords(others)}.`;
  return { level: lost.level, text: `${lead} ${lost.text} ${stolen}` };
}

/** For a must-sign key that is on this path only: what requiring it means. */
export function mustSignNote(paths: RiskPath[], key: RiskKey, here: RiskPath): RiskNote | null {
  if (!isMust(here, key.keyId)) return null;
  if (paths.filter(p => onPath(p, key.keyId)).length >= 2) return null; // sharedKeyNote says it
  const lost = lossSentence(paths, key);
  return { level: lost.level, text: `${q(key.label)} must sign every spend on this path. ${lost.text}` };
}

/** A must-sign key whose seed sits in this browser protects like a phone. */
export function browserMustSignNote(here: RiskPath): RiskNote | null {
  const hot = must(here).filter(k => k.kind === 'browser');
  if (!hot.length) return null;
  return {
    level: 'warn',
    text: `${listWords(hot.map(k => q(k.label)))} ${hot.length === 1 ? 'is' : 'are'} kept in this browser. Making ${hot.length === 1 ? 'it' : 'them'} must-sign gives this path a phone's protection, not a hardware wallet's.`,
  };
}

/** A must-sign key held by an invited person: nothing on the path moves
 *  without it, and this app cannot see what device they keep it on
 *  (operator, 2026-11-12: "Warn both, recommend hardware"). */
export function memberMustSignNote(here: RiskPath): RiskNote | null {
  const theirs = must(here).filter(k => k.kind === 'member');
  if (!theirs.length) return null;
  const one = theirs.length === 1;
  return {
    level: 'warn',
    text: `${listWords(theirs.map(k => q(k.label)))} ${one ? 'holds a must-sign key' : 'hold must-sign keys'} on ${one ? 'their own device' : 'their own devices'}. This app cannot see what kind of device that is, and nothing on this path moves without ${one ? 'it' : 'them'}. Ask ${one ? 'them' : 'each of them'} to use a hardware wallet.`,
  };
}

/** Must-sign keys that EVERY path needs: lose one and nothing can ever
 *  move. The builder asks for an explicit tick before finalizing. */
export function mustSignKeysEveryPathNeeds(paths: RiskPath[]): RiskKey[] {
  const seen = new Map<string, RiskKey>();
  for (const p of paths) for (const k of must(p)) if (!seen.has(k.keyId)) seen.set(k.keyId, k);
  return [...seen.values()].filter(k => lossOutcome(paths, k.keyId).kind === 'never');
}

/** Does the vault mix separate-device keys with browser keys at all?
 *  Only then is "is the separate-device key actually required" a
 *  question worth raising. */
function mixesKinds(paths: RiskPath[]): boolean {
  const all = paths.flatMap(p => [...must(p), ...p.keys]);
  return all.some(k => k.kind === 'outside') && all.some(k => k.kind === 'browser');
}

/** Can this path open with no separate-device key signing? Counted on
 *  the slots that could be anything but a known separate-device key, so
 *  an empty slot is not assumed to be a hardware wallet. */
export function opensWithoutOutsideKey(path: RiskPath): boolean {
  if (must(path).some(k => k.kind === 'outside')) return false;
  const outside = path.keys.filter(k => k.kind === 'outside').length;
  return path.slots - outside >= path.quorum;
}

function outsideNote(path: RiskPath): RiskNote | null {
  if (path.keys.length === 0 && must(path).length === 0) return null;
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
    ? ` To make it required, give this path a must-sign key when you shape the vault, or set how many must agree to more than ${others}, the number of other keys on this path.`
    : ' A hardware wallet guards a path only when the path cannot open without it.';
  return { level: 'warn', text: lead + named + fix };
}

/** Everything to show under one path, most serious first. */
export function pathNotes(paths: RiskPath[], pathId: string): RiskNote[] {
  const here = paths.find(p => p.id === pathId);
  if (!here) return [];
  const notes: RiskNote[] = [];
  for (const k of [...must(here), ...here.keys]) {
    const n = sharedKeyNote(paths, k, here) ?? mustSignNote(paths, k, here);
    if (n) notes.push(n);
  }
  const hot = browserMustSignNote(here);
  if (hot) notes.push(hot);
  const theirs = memberMustSignNote(here);
  if (theirs) notes.push(theirs);
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
  const filled = paths.filter(p => p.keys.length > 0 || must(p).length > 0);
  const open = filled.filter(opensWithoutOutsideKey);
  if (open.length === 0) {
    return { level: 'good', text: 'Every path here needs a separate-device key to sign. That is the strongest set-up: nothing in this vault can be spent from a phone or browser alone.' };
  }
  return {
    level: 'warn',
    text: `The strongest set-up is a hardware wallet, made with good randomness, required on every spend. Right now ${listWords(open.map(p => q(p.label)))} can open without one. Each path below says how to change that.`,
  };
}
