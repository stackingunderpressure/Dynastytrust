/**
 * test-timelock-check.mjs -- proves the browser's absolute-timelock
 * cross-check (apps/web/src/lib/timelock-check.ts) refuses a compiled vault
 * whose heights do not equal tip + the chosen offset, and refuses an
 * implausible chain tip outright. Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-timelock-check.mjs
 */

import assert from 'node:assert/strict';
import {
  checkAbsoluteTimelocks,
  checkTipFloor,
  TIP_FLOOR,
  TIP_SLACK_BLOCKS,
} from '../apps/web/src/lib/timelock-check.ts';

let n = 0;
const pass = (label) => { n++; console.log(`  [ok] ${label}`); };

const tip = 975_000;

// Honest compile: every absolute height is tip + offset (server tip a few
// blocks behind the browser's, inside the slack).
{
  const r = checkAbsoluteTimelocks([
    { label: 'Recovery', offsetBlocks: 26_280, absoluteBlocks: tip - 3 + 26_280 },
    { label: 'Inheritance', offsetBlocks: 105_120, absoluteBlocks: tip + 2 + 105_120 },
    { label: 'Second inheritance', offsetBlocks: 0, absoluteBlocks: 0 },
    { label: 'Stale relaxation', offsetBlocks: 26_280, absoluteBlocks: 26_280, kind: 'older' },
  ], tip, 'bitcoin');
  assert.deepEqual(r, { ok: true, problems: [] });
  pass('honest compile within slack passes');
}

// The attack: the server used a tiny tip, so the doors are already open.
{
  const bogusTip = 26_000;
  const r = checkAbsoluteTimelocks([
    { label: 'Recovery', offsetBlocks: 26_280, absoluteBlocks: bogusTip + 26_280 },
  ], tip, 'bitcoin');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /Recovery: compiled to unlock at block 52,280, which is -922,720 blocks from now/);
  pass('doors already open (server tip wrong by ~950k) refused');
}

// Off by exactly the slack passes; one more block fails.
{
  const edge = checkAbsoluteTimelocks([{ label: 'R', offsetBlocks: 1000, absoluteBlocks: tip + 1000 + TIP_SLACK_BLOCKS }], tip, 'bitcoin');
  assert.equal(edge.ok, true);
  const over = checkAbsoluteTimelocks([{ label: 'R', offsetBlocks: 1000, absoluteBlocks: tip + 1000 + TIP_SLACK_BLOCKS + 1 }], tip, 'bitcoin');
  assert.equal(over.ok, false);
  pass(`slack boundary is exactly ${TIP_SLACK_BLOCKS} blocks`);
}

// A timelock that was never asked for, and a missing one that was.
{
  const r = checkAbsoluteTimelocks([
    { label: 'Recovery', offsetBlocks: 0, absoluteBlocks: tip + 26_280 },
    { label: 'Inheritance', offsetBlocks: 105_120, absoluteBlocks: 0 },
  ], tip, 'bitcoin');
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /never asked for/);
  assert.match(r.problems[1], /NO timelock/);
  pass('unasked-for and missing timelocks both refused');
}

// A relative (older) duration must come back untouched -- never tip + N.
{
  const r = checkAbsoluteTimelocks([{ label: 'Relax', offsetBlocks: 26_280, absoluteBlocks: tip + 26_280, kind: 'older' }], tip, 'bitcoin');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /relative wait came back/);
  pass('relative duration converted to a height is refused');
}

// Implausible tips are refused on every network, plausible ones pass.
{
  for (const net of Object.keys(TIP_FLOOR)) {
    assert.equal(checkTipFloor(net, TIP_FLOOR[net]), null);
    assert.match(checkTipFloor(net, TIP_FLOOR[net] - 1), /Implausible/);
    assert.match(checkTipFloor(net, 0), /Implausible/);
  }
  const r = checkAbsoluteTimelocks([{ label: 'R', offsetBlocks: 1000, absoluteBlocks: 1000 + 500 }], 500, 'signet');
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /Implausible signet chain tip 500/);
  pass('tip floors enforced on bitcoin, testnet and signet');
}

console.log(`timelock-check tests passed (${n} cases)`);
