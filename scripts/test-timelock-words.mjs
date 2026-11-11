/**
 * test-timelock-words.mjs -- proves the words the app uses for a
 * timelock (apps/web/src/lib/timelock-words.ts) are computed from the
 * blocks that are LEFT, not from the block height itself, and say
 * "open" once the height has passed. The dashboard used to show an heir
 * a countdown made from the absolute height: a number that never moved
 * and never reached zero. Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-timelock-words.mjs
 */
import assert from 'node:assert/strict';
import * as w from '../apps/web/src/lib/timelock-words.ts';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const NOW = new Date('2026-11-11T00:00:00Z');
const TIP = 950_000;
const YEAR = w.BLOCKS_PER_YEAR;

// 1. Blocks left, and the three states of knowing.
assert.equal(w.blocksLeft(TIP + 1000, TIP), 1000);
assert.equal(w.blocksLeft(TIP - 5, TIP), 0);
assert.equal(w.blocksLeft(TIP, TIP), 0);
assert.equal(w.blocksLeft(0, TIP), null, 'no such path');
assert.equal(w.blocksLeft(null, TIP), null);
assert.equal(w.blocksLeft(TIP + 1000, null), null, 'tip not loaded: unknown, never a guess');
pass('blocks left is height minus tip, zero once passed, and unknown without a tip');

// 2. The bug this file exists for: an heir's line is made from what is
//    left, changes as blocks pass, and says open at the end.
const height = TIP + 5 * YEAR;
assert.equal(w.heirDashboardLine(height, TIP), 'Inheritance opens in about 5 years');
assert.equal(w.heirDashboardLine(height, TIP + 4 * YEAR), 'Inheritance opens in about 1 year');
assert.equal(w.heirDashboardLine(height, height - 3 * 144), 'Inheritance opens in about 3 days');
assert.equal(w.heirDashboardLine(height, height), 'Inheritance is open -- you can act now');
assert.equal(w.heirDashboardLine(height, height + 10_000), 'Inheritance is open -- you can act now');
assert.equal(w.heirDashboardLine(height, null), null);
// the old behaviour, for the record: the height itself read as a duration
assert.notEqual(w.heirDashboardLine(height, TIP), `Inheritance opens in ${w.durationWords(height)}`);
pass('the heir line counts down from the blocks left and says open once the height is reached');

// 3. Durations and dates read like a person would say them.
assert.equal(w.durationWords(50), 'less than a day');
assert.equal(w.durationWords(144), 'about 1 day');
assert.equal(w.durationWords(30 * 144), 'about 30 days');
assert.equal(w.durationWords(26_280), 'about 6 months');
assert.equal(w.durationWords(YEAR), 'about 1 year');
assert.equal(w.durationWords(2.5 * YEAR), 'about 2.5 years');
assert.equal(w.opensWords(TIP, TIP + 1, NOW), 'open now');
assert.equal(w.opensWords(TIP + 10 * 144, TIP, NOW), 'in about 10 days, around 21 November 2026');
assert.equal(w.opensWords(TIP + 5 * YEAR, TIP, NOW), 'in about 5 years, around November 2031');
pass('durations and estimated dates: a day when it is close, a month and year when it is far');

// 4. Rotating: the founder is told what the chosen number means against
//    the vault being replaced -- rotating with the time left moves nothing.
const old = TIP + 2 * YEAR;
assert.match(w.rotateDateWords(2 * YEAR, old, TIP, NOW), /^Opens around November 2028 \(about 2 years from now\)\. That is the SAME date as this vault -- it does not push anything out\.$/);
assert.match(w.rotateDateWords(5 * YEAR, old, TIP, NOW), /That is about 3 years LATER than this vault\.$/);
assert.match(w.rotateDateWords(YEAR, old, TIP, NOW), /That is about 1 year EARLIER than this vault\.$/);
assert.match(w.rotateDateWords(0, old, TIP, NOW), /No waiting period/);
assert.match(w.rotateDateWords(YEAR, TIP - 100, TIP, NOW), /already passed/);
assert.equal(w.rotateDateWords(YEAR, 0, TIP, NOW), 'Opens around November 2027 (about 1 year from now).');
assert.deepEqual(w.ROTATE_EXTENSIONS.map(e => e.extraBlocks), [0, YEAR, 3 * YEAR, 5 * YEAR]);
pass('the rotate dialog says whether the new date is the same, later or earlier than the vault it replaces');

// 5. Path-builder vaults: no roles, so "is it mine and is it open?" is
//    answered by the keys on this device.
const K = (c) => '02' + c.repeat(64);
const paths = [
  { id: 'everyday', label: 'Everyday signers', keys: [K('a'), K('b')], quorum: 2, unlock: { type: 'immediate' } },
  { id: 'kids', label: 'The kids', keys: [K('c'), K('d'), K('e')], quorum: 2, unlock: { type: 'after', blocks: TIP + 5 * YEAR } },
  { id: 'stale', label: 'If untouched', keys: [K('a')], quorum: 1, unlock: { type: 'older', blocks: 26_280 } },
];
assert.deepEqual(w.pathMoments(paths, TIP, [K('c')], NOW), [], 'five years out: nothing to raise');
assert.deepEqual(w.pathMoments(paths, null, [K('c')], NOW), [], 'no tip: say nothing');
// within six months: everyone is told, whether or not they hold a key on it
const near = w.pathMoments(paths, TIP + 5 * YEAR - 90 * 144, [K('a')], NOW);
assert.equal(near.length, 1);
assert.equal(near[0].kind, 'approaching'); assert.equal(near[0].pathId, 'kids');
assert.equal(near[0].label, '"The kids" opens in about 3 months');
assert.match(near[0].detail, /The date is fixed \(around February 2027\): from then on 2 of 3 of that path's keys can spend, whatever else happens\. To push it out, build a new vault with a later date/);
// open, and this device holds one of its keys (the 03 form of the same key counts)
const open = w.pathMoments(paths, TIP + 5 * YEAR, ['03' + 'c'.repeat(64), K('z')], NOW);
assert.deepEqual(open.map(m => [m.kind, m.pathId, m.label]), [['open', 'kids', '"The kids" is open']]);
assert.match(open[0].detail, /^2 of 3 of this path's keys can now move the coins\. One of them is on this device\. Open Send, choose "The kids"/);
assert.match(w.pathMoments(paths, TIP + 6 * YEAR, [K('c'), K('d')], NOW)[0].detail, /2 of them are on this device/);
// open but none of its keys are here: no prompt to do something this device cannot do
assert.deepEqual(w.pathMoments(paths, TIP + 5 * YEAR, [K('a'), K('b')], NOW), []);
pass('a path-builder vault raises a dated path when it nears, and says it is open only to a device holding one of its keys');

console.log(`timelock-words tests passed (${n} cases)`);
