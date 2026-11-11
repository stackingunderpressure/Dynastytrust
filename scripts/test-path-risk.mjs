/**
 * test-path-risk.mjs -- proves the builder's upfront consequence lines
 * (apps/web/src/lib/path-risk.ts) are computed from the paths: what
 * losing a key shared across paths costs, how long the wait is, and
 * whether a separate-device key is actually required. Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-path-risk.mjs
 */
import assert from 'node:assert/strict';
import * as r from '../apps/web/src/lib/path-risk.ts';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const YEAR = 52_560;
const hw = { keyId: 'hw', label: 'Coldcard', kind: 'outside' };
const b = (id) => ({ keyId: id, label: id, kind: 'browser' });
const m = (id) => ({ keyId: id, label: id, kind: 'member' });
const path = (id, keys, quorum, unlock = 'immediate', blocks = 0, extra = {}) => ({ id, label: id, slots: keys.length, quorum, keys, unlock, blocks, decay: null, ...extra });

// 1. Kinds, as far as the browser can tell.
assert.equal(r.keyKind('software'), 'browser');
assert.equal(r.keyKind('imported_xpub'), 'outside');
assert.equal(r.keyKind('tapit'), 'outside');
assert.equal(r.keyKind('member'), 'member');
pass('a seed held here is a browser key; a public-only key is a separate device; an invited key is unknown');

// 2. The operator's own example: one hardware key needed on every path
//    that is open or opens soon; the first path without it is 6 years out.
const six = [
  path('Everyday', [hw, b('Phone A'), b('Phone B')], 3),
  path('Backup', [hw, b('Phone A')], 2, 'after', 1 * YEAR),
  path('Heirs', [m('Anna'), m('Ben')], 2, 'after', 6 * YEAR),
];
assert.deepEqual(r.lossOutcome(six, 'hw'), { kind: 'wait', path: six[2], blocks: 6 * YEAR });
const note = r.sharedKeyNote(six, hw, six[0]);
assert.equal(note.level, 'warn');
assert.equal(note.text, '"Coldcard" is also on "Backup". If it is lost, "Everyday" and "Backup" stop working for good, and nothing can move until "Heirs" opens without it: about 6 years after the vault is made. If it is stolen, the thief holds one of the signatures needed on both of these paths.');
assert.match(r.sharedKeyNote(six, hw, six[1]).text, /^"Coldcard" is also on "Everyday"\./);
const three = [...six.slice(0, 2), path('Kids', [hw, b('K1'), b('K2')], 2, 'after', 3 * YEAR), six[2]];
assert.match(r.sharedKeyNote(three, hw, three[0]).text, /also on "Backup" and "Kids"\. .*until "Kids" opens without it: about 3 years after the vault is made\. .*needed on all 3 of these paths\.$/);
pass('a key needed on every early path: the wait to the first path without it is computed and named (6 years)');

// 3. A key on one path only raises no shared-key note.
assert.equal(r.sharedKeyNote(six, b('Phone B'), six[0]), null);
assert.equal(r.sharedKeyNote(six, m('Anna'), six[2]), null);
pass('a key on a single path gets no shared-key warning');

// 4. Shared but with a spare on the open path: still spend right away.
const spare = [
  path('Everyday', [hw, b('A'), b('B')], 2),
  path('Backup', [hw, b('C')], 2, 'after', YEAR),
];
const s = r.sharedKeyNote(spare, hw, spare[0]);
assert.equal(s.level, 'warn');
assert.match(s.text, /If it is lost, "Backup" stops working for good, and you can still spend right away through "Everyday"\./);
const allSpare = [path('Everyday', [hw, b('A'), b('B')], 2), path('Backup', [hw, b('C'), b('D')], 2, 'after', YEAR)];
assert.equal(r.sharedKeyNote(allSpare, hw, allSpare[0]).level, 'info');
assert.match(r.sharedKeyNote(allSpare, hw, allSpare[0]).text, /If it is lost, you can still spend right away through "Everyday"\./);
pass('a shared key with a spare on the open path: says which path dies and that spending carries on');

// 5. Required everywhere: the bitcoin is gone with the key.
const every = [path('Everyday', [hw, b('A')], 2), path('Later', [hw, b('B')], 2, 'after', YEAR)];
const dead = r.sharedKeyNote(every, hw, every[0]);
assert.equal(dead.level, 'danger');
assert.match(dead.text, /this bitcoin can never be moved: every path needs this key/);
assert.deepEqual(r.lossOutcome(every, 'hw'), { kind: 'never' });
pass('a key every path needs: says plainly the bitcoin can never be moved without it');

// 6. A path that relaxes over time opens without the key after one step.
const relax = [
  path('Everyday', [hw, b('A')], 2),
  path('Family', [hw, b('B'), b('C')], 3, 'after', 2 * YEAR, { decay: { stepBlocks: YEAR, floorQuorum: 2 } }),
];
assert.equal(r.waitWithout(relax[1], 'hw'), 3 * YEAR);
assert.match(r.sharedKeyNote(relax, hw, relax[0]).text, /nothing can move until "Family" opens without it: about 3 years after the vault is made/);
assert.equal(r.waitWithout({ ...relax[1], decay: { stepBlocks: YEAR, floorQuorum: 3 } }, 'hw'), null);
pass('a path that needs one fewer signature each year is counted from the year the others are enough');

// 7. An "if untouched" path is worded as untouched time, not a date.
const idle = [path('Everyday', [hw, b('A')], 2), path('Idle', [hw, b('B'), b('C')], 2, 'older', 26_280)];
assert.match(r.sharedKeyNote(idle, hw, idle[0]).text, /until "Idle" opens without it: the coins have sat untouched for about 6 months/);
pass('an if-untouched path is worded as untouched time');

// 8. Unfilled slots count: a 2-of-3 with one key picked still has a spare.
const partial = [{ ...path('Everyday', [hw], 2), slots: 3 }, path('Backup', [hw, b('C')], 2, 'after', YEAR)];
assert.equal(r.keyRequiredOn(partial[0], 'hw'), false);
assert.equal(r.lossOutcome(partial, 'hw').kind, 'now');
pass('the planned size of a path is used, so a half-filled path is not called all-must-sign');

// 9. One hardware wallet and two phone keys.
const mixed = [path('Everyday', [hw, b('A'), b('B')], 2), path('Backup', [b('A'), b('B')], 2, 'after', YEAR)];
assert.equal(r.opensWithoutOutsideKey(mixed[0]), true);
const notes = r.pathNotes(mixed, 'Everyday');
const o = notes.find(x => x.text.startsWith('This path can be opened by keys kept in this browser alone.'));
assert.ok(o); assert.equal(o.level, 'warn');
assert.match(o.text, /"Coldcard" is on it but not required\. To make it required, set how many must agree to more than 2, the number of other keys on this path\./);
assert.match(r.pathNotes(mixed, 'Backup').at(-1).text, /A hardware wallet guards a path only when the path cannot open without it\./);
assert.equal(r.vaultNote(mixed).level, 'warn');
assert.match(r.vaultNote(mixed).text, /required on every spend\. Right now "Everyday" and "Backup" can open without one\./);
const strict = [path('Everyday', [hw, b('A'), b('B')], 3), path('Backup', [hw, b('A')], 2, 'after', YEAR)];
assert.equal(r.vaultNote(strict).level, 'good');
assert.equal(r.pathNotes(strict, 'Everyday').at(-1).level, 'good');
const viaMember = [path('Everyday', [hw, b('A'), m('Anna')], 2)];
assert.match(r.pathNotes(viaMember, 'Everyday')[0].text, /^This path can open without any separate-device key signing\./);
pass('a hardware key that is on a path but not required is called out, with the number that would make it required');

// 10. No mix, no hardware advice; most serious note first; unknown path.
assert.equal(r.vaultNote([path('Everyday', [b('A'), b('B')], 2)]), null);
assert.equal(r.vaultNote([path('Everyday', [hw, { ...hw, keyId: 'hw2', label: 'Trezor' }], 2)]), null);
assert.deepEqual(r.pathNotes([path('Everyday', [b('A'), b('B')], 2)], 'Everyday'), []);
assert.deepEqual(r.pathNotes(six, 'nope'), []);
const order = r.pathNotes([path('Everyday', [hw, b('A')], 2), path('Later', [hw, b('A')], 2, 'after', YEAR)], 'Everyday').map(x => x.level);
assert.deepEqual(order, ['danger', 'danger', 'good']);
pass('no advice where there is no mix of key kinds; the most serious line comes first');

console.log(`path-risk tests passed (${n} cases)`);
