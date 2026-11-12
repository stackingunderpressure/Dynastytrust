/**
 * test-rotate.mjs -- proves rotating a path-builder vault changes ONE
 * thing, the dates of its dated paths, on both sides:
 *   - the server's carry-forward (netlify/functions/_rotate.js),
 *   - the browser's plan and its check of the compiled successor
 *     (apps/web/src/lib/rotate-plan.ts).
 * The new vault's address is where a family's coins get sent, so a
 * successor with a swapped key, a lowered quorum, a dropped path or an
 * EARLIER date must be refused. Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-rotate.mjs
 */
import assert from 'node:assert/strict';
import { rotatedLeaves } from '../netlify/functions/_rotate.js';
import { relativeToAbsolute, MIN_RECOVERY_BLOCKS } from '../netlify/functions/_chain.js';
import * as web from '../apps/web/src/lib/rotate-plan.ts';
import { MIN_RECOVERY_BLOCKS as WEB_MIN } from '../apps/web/src/lib/blocks.ts';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const K = (c) => '02' + c.repeat(64);
const TIP = 950_000, YEAR = 52_560, NOW = new Date('2026-11-11T00:00:00Z');
const old = {
  network: 'bitcoin', address: 'bc1pold', consent_keys: [], consent_quorum: null,
  leaves: [
    { id: 'everyday', label: 'Everyday signers', keys: [K('a'), K('b')], quorum: 2, unlock: { type: 'immediate' }, decay: null },
    { id: 'backup', label: 'One of us alone', keys: [K('a'), K('b')], quorum: 1, unlock: { type: 'after', blocks: TIP + YEAR }, decay: null },
    { id: 'kids', label: 'The kids', keys: [K('c'), K('d'), K('e')], quorum: 3, unlock: { type: 'after', blocks: TIP + 2 * YEAR }, decay: { step_blocks: 26_280, floor_quorum: 2 } },
    { id: 'stale', label: 'If untouched', keys: [K('a')], quorum: 1, unlock: { type: 'older', blocks: 30_000 }, decay: null },
  ],
};

// 1. The plan: every dated path moves by the same amount; gaps are kept.
assert.equal(WEB_MIN, MIN_RECOVERY_BLOCKS, 'browser and server agree on the shortest wait');
const plan = web.planRotation(old.leaves, TIP, 3 * YEAR, NOW);
assert.deepEqual(plan.offsets, { backup: 4 * YEAR, kids: 5 * YEAR });
assert.deepEqual(plan.problems, []);
assert.deepEqual(plan.rows.map(r => [r.label, r.oldWords, r.newWords]), [
  ['One of us alone', 'around November 2027', 'around November 2030'],
  ['The kids', 'around November 2028', 'around November 2031'],
]);
assert.equal(plan.offsets.kids - plan.offsets.backup, YEAR, 'the gap between paths is unchanged');
pass('three years later moves every dated path by three years and keeps the gap between them');

// 2. What the plan refuses.
const late = TIP + 2 * YEAR - 1000;     // "One of us alone" already open, the kids nearly
assert.match(web.planRotation(old.leaves, late, 0, NOW).problems.join(' | '), /"One of us alone" would open in less than a day\. A new vault cannot have a wait shorter than about 6 months/);
assert.equal(web.planRotation(old.leaves, late, YEAR, NOW).problems.length, 0, 'a year later clears the floor for both');
assert.match(web.planRotation(old.leaves, TIP, -5, NOW).problems.join(' '), /only be kept or moved later/);
assert.match(web.planRotation(old.leaves, TIP, 200 * YEAR, NOW).problems.join(' '), /more than 100 years/);
assert.match(web.planRotation([old.leaves[0]], TIP, YEAR, NOW).problems.join(' '), /no dated path/);
pass('keeping a date that is too close, moving a date earlier, or absurdly far, is refused in plain words');

// 3. The server carries everything forward exactly, changing only the waits.
const carried = rotatedLeaves(old.leaves, plan.offsets);
assert.deepEqual(carried.map(l => l.unlock), [{ type: 'immediate' }, { type: 'after', blocks: 4 * YEAR }, { type: 'after', blocks: 5 * YEAR }, { type: 'older', blocks: 30_000 }]);
for (const [i, l] of carried.entries()) {
  const o = old.leaves[i];
  assert.deepEqual([l.id, l.label, l.keys, l.quorum, l.decay], [o.id, o.label, o.keys, o.quorum, o.decay]);
  assert.notEqual(l.keys, o.keys, 'copied, not shared');
}
assert.throws(() => rotatedLeaves(old.leaves, { backup: 4 * YEAR }), /Missing the new date for the path "The kids"/);
assert.throws(() => rotatedLeaves(old.leaves, { ...plan.offsets, everyday: YEAR }), /"everyday" is not a dated path/);
assert.throws(() => rotatedLeaves(old.leaves, { ...plan.offsets, kids: 0 }), /must keep a waiting period/);
assert.throws(() => rotatedLeaves(old.leaves, { ...plan.offsets, kids: 100 }), /must be >= 26000 blocks/);
assert.throws(() => rotatedLeaves(old.leaves, { ...plan.offsets, kids: 1.5 }), /whole number of blocks/);
assert.throws(() => rotatedLeaves(old.leaves, { ...plan.offsets, kids: 9_000_000 }), /at most/);
assert.throws(() => rotatedLeaves(old.leaves, undefined), /Missing: the new date/);
assert.throws(() => rotatedLeaves([], {}), /no spending paths/);
assert.throws(() => rotatedLeaves([{ ...old.leaves[0], unlock: { type: 'weird' } }], {}), /cannot carry forward/);
pass('the server copies keys, quorums, step-downs and untouched-for rules exactly, and refuses a missing, zero, short or stray date');

// 4. The browser checks the compiled successor against the old vault.
const compiledNext = (f = (x) => x) => f({
  network: 'bitcoin', address: 'bc1pnew', consent_keys: [], consent_quorum: null,
  leaves: carried.map(l => (l.unlock.type === 'after' ? { ...l, unlock: { type: 'after', blocks: relativeToAbsolute(l.unlock.blocks, TIP + 2) } } : structuredClone(l))),
});
assert.deepEqual(web.checkRotatedVault(old, compiledNext()), []);
const bad = (f) => web.checkRotatedVault(old, compiledNext(v => { f(v); return v; })).join(' | ');
assert.match(bad(v => { v.leaves[2].keys[1] = K('f'); }), /"The kids" does not have the same keys/);
assert.match(bad(v => { v.leaves[2].keys.reverse(); }), /"The kids" does not have the same keys/);
assert.match(bad(v => { v.leaves[2].quorum = 1; }), /"The kids" needs 1 signatures, not 3/);
assert.match(bad(v => { v.leaves[2].decay = null; }), /"The kids" does not have the same step-down rule/);
assert.match(bad(v => { v.leaves[2].decay.floor_quorum = 1; }), /step-down rule/);
assert.match(bad(v => { v.leaves[3].unlock.blocks = 5; }), /"If untouched" has a different untouched-for period/);
assert.match(bad(v => { v.leaves[1].unlock = { type: 'immediate' }; }), /"One of us alone" opens by a different kind of rule/);
assert.match(bad(v => { v.leaves[2].unlock.blocks = TIP + YEAR; }), /"The kids" would open EARLIER than in the old vault/);
assert.match(bad(v => { v.leaves.pop(); }), /has 3 paths, the old one has 4/);
assert.match(bad(v => { v.leaves.push({ id: 'x', label: 'Extra', keys: [K('f')], quorum: 1, unlock: { type: 'immediate' }, decay: null }); }), /has 5 paths/);
assert.match(bad(v => { v.leaves[0].label = 'Someone else'; }), /path 1 is "Someone else", not "Everyday signers"/);
assert.match(bad(v => { v.address = 'bc1pold'; }), /same address as the old one/);

// 4b. Must-sign keys travel with their path, and a successor that lost
// one is refused: it would be a weaker vault than the one rotated from.
{
  const withMust = { ...old, leaves: old.leaves.map((l, i) => (i === 0 ? { ...l, keys: [K('b')], quorum: 1, required_keys: [K('a')] } : l)) };
  const moved = rotatedLeaves(withMust.leaves, plan.offsets);
  assert.deepEqual(moved[0].required_keys, [K('a')]);
  assert.notEqual(moved[0].required_keys, withMust.leaves[0].required_keys, 'copied, not shared');
  assert.equal('required_keys' in moved[1], false, 'a path with none keeps its old shape');
  const next = (f = (x) => x) => f({ network: 'bitcoin', address: 'bc1pnew', consent_keys: [], consent_quorum: null,
    leaves: moved.map(l => (l.unlock.type === 'after' ? { ...l, unlock: { type: 'after', blocks: relativeToAbsolute(l.unlock.blocks, TIP + 2) } } : structuredClone(l))) });
  assert.deepEqual(web.checkRotatedVault(withMust, next()), []);
  assert.match(web.checkRotatedVault(withMust, next(v => { delete v.leaves[0].required_keys; return v; })).join(' | '), /"Everyday signers" does not have the same must-sign keys/);
  assert.match(web.checkRotatedVault(withMust, next(v => { v.leaves[0].required_keys = [K('f')]; return v; })).join(' | '), /does not have the same must-sign keys/);
  assert.match(web.checkRotatedVault(old, next(v => { v.leaves[0].keys = [K('a'), K('b')]; v.leaves[0].quorum = 2; return v; })).join(' | '), /does not have the same must-sign keys/, 'a successor that GAINED one is refused too');
  pass('rotate carries must-sign keys with their path, and a successor that lost or gained one is refused');
}
assert.match(bad(v => { v.address = null; }), /no address/);
assert.match(bad(v => { v.network = 'signet'; }), /on signet, not bitcoin/);
assert.match(bad(v => { v.consent_keys = [K('f')]; v.consent_quorum = 1; }), /consent rule is not the same/);
pass('a successor with a swapped or reordered key, a lower quorum, a dropped or added path, an earlier date or the old address is refused');

console.log(`rotate tests passed (${n} cases)`);
