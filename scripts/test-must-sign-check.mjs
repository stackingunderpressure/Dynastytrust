/**
 * test-must-sign-check.mjs -- a compiled vault is refused unless every
 * must-sign key is really in its own path's script (browser and server
 * twins agree). Guards the window where an older compiler, which ignores
 * the must-sign list, is still answering. Wired into `npm test`.
 */
import assert from 'node:assert/strict';
import * as web from '../apps/web/src/lib/must-sign-check.ts';
import * as fn from '../netlify/functions/_must-sign-check.js';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const K = (c) => '02' + c.repeat(64);
const script = (...keys) => keys.map(k => '20' + k.slice(2) + 'ac').join('');
const both = (leaves, scripts) => { const a = web.mustSignPathsNotInScripts(leaves, scripts), b = fn.mustSignPathsNotInScripts(leaves, scripts); assert.deepEqual(a, b); return a; };
const leaves = [
  { id: 'everyday', label: 'Everyday', required_keys: [K('a')], keys: [K('b'), K('c')] },
  { id: 'kids', label: 'The kids', required_keys: [K('9')], keys: [K('d')], decay: { step_blocks: 1, floor_quorum: 1 } },
  { id: 'last', label: 'Last', keys: [K('a')] },
];
assert.deepEqual(both(leaves, { everyday: script(K('a'), K('b'), K('c')), kids_0: script(K('9'), K('d')), kids_1: script(K('9'), K('d')), last: script(K('a')) }), []);
pass('a vault whose scripts carry every must-sign key passes');
// What an older compiler returns: the same vault with the must-sign keys left out.
assert.deepEqual(both(leaves, { everyday: script(K('b'), K('c')), kids_0: script(K('d')), kids_1: script(K('d')), last: script(K('a')) }), ['Everyday', 'The kids']);
pass('a compiler that ignored the must-sign list is caught, even though the key appears on another path');
assert.deepEqual(both(leaves, { everyday: script(K('a'), K('b')), kids_0: script(K('9'), K('d')), kids_1: script(K('d')), last: script(K('a')) }), ['The kids']);
pass('a relaxing path must carry its must-sign key on every step');
assert.deepEqual(both(leaves, null), ['Everyday', 'The kids']);
assert.deepEqual(both(leaves, {}), ['Everyday', 'The kids']);
assert.deepEqual(both([{ id: 'x', label: 'X', required_keys: ['tpubNope'], keys: [] }], { x: 'tpubnope' }), ['X']);
assert.deepEqual(both([{ id: 'x', keys: [K('a')] }], null), []);
assert.deepEqual(both(null, null), []);
assert.deepEqual(both([{ id: 'x', required_keys: [K('A').toUpperCase().replace('02', '02')], keys: [] }], { x: script(K('a')) }), []);
pass('missing scripts fail closed; a vault with no must-sign keys needs none; case does not matter');
console.log(`must-sign-check tests passed (${n} cases, web/functions identical)`);
