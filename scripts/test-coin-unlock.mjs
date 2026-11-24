/**
 * test-coin-unlock.mjs -- per-coin path timing (apps/web/src/lib/coin-unlock.ts).
 * Run: node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-coin-unlock.mjs
 */
import assert from 'node:assert/strict';
import { coinUnlocks, vaultPaths, waitWords } from '../apps/web/src/lib/coin-unlock.ts';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const now = new Date(Date.UTC(2026, 10, 24, 12));
const TIP = 300_000;
const paths = [
  { label: 'Everyday', unlock: { type: 'immediate' } },
  { label: 'Quiet', unlock: { type: 'older', blocks: 8640 } },
  { label: 'Heirs', unlock: { type: 'after', blocks: TIP + 52_560 } },
];

// 1. A young coin: everyday open; quiet counts from its confirmations; heirs at the date.
let s = coinUnlocks({ confirmed: true, confirmations: 40 }, paths, TIP, now);
assert.equal(s[0].open, true);
assert.equal(s[1].open, false); assert.equal(s[1].blocksLeft, 8600);
assert.equal(s[2].open, false); assert.equal(s[2].blocksLeft, 52_560);
assert.match(waitWords(s[1]), /^8,600 blocks left -- about \d+ January 2027$/);
assert.match(waitWords(s[2]), /^52,560 blocks left -- about November 2027$/);
pass('a 40-confirmation coin: everyday now; "if untouched" 8,600 blocks with a day-level date; a dated path a year out, month-level');

// 2. An old coin: the "if untouched" path is open for IT (each coin its own clock).
s = coinUnlocks({ confirmed: true, confirmations: 9000 }, paths, TIP, now);
assert.equal(s[1].open, true); assert.equal(s[2].open, false);
pass('a coin past its wait: "if untouched" open for that coin only; the dated path still the same date');

// 3. Unconfirmed: the clock has not started.
s = coinUnlocks({ confirmed: false, confirmations: 0 }, paths, TIP, now);
assert.equal(s[1].blocksLeft, 8640); assert.equal(s[1].startsOnConfirm, true);
assert.match(waitWords(s[1]), /once it confirms/);
pass('an unconfirmed coin: the full wait, counted from when it confirms');

// 4. Rule matches the spend builder: open exactly when confirmations reach the wait.
assert.equal(coinUnlocks({ confirmed: true, confirmations: 8639 }, paths, TIP, now)[1].open, false);
assert.equal(coinUnlocks({ confirmed: true, confirmations: 8640 }, paths, TIP, now)[1].open, true);
assert.equal(coinUnlocks({ confirmed: true, confirmations: 1 }, [{ label: 'D', unlock: { type: 'after', blocks: TIP } }], TIP, now)[0].open, true);
pass('opens at exactly the wait (as the spend builder and Bitcoin Core enforce); a dated path opens when the tip reaches its height');

// 5. Vault shapes.
assert.deepEqual(vaultPaths({ leaves: [{ id: 'p', label: 'Everyday', unlock: { type: 'immediate' } }] }).map(p => p.label), ['Everyday']);
assert.deepEqual(vaultPaths({ leaves: null, bloc_policy: null, recovery_after: 400_000, inheritance_after: 500_000, second_inheritance_after: null }).map(p => p.label), ['Founders', 'Recovery', 'Inheritance']);
assert.equal(vaultPaths({ leaves: null, bloc_policy: { x: 1 }, recovery_after: 0, inheritance_after: 0 }), null);
pass('path-builder and named-field vaults read; a family-plan vault shows nothing rather than a guess');

console.log(`coin-unlock tests passed (${n} cases)`);
