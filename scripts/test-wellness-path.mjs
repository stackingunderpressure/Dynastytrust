/**
 * test-wellness-path.mjs -- a wellness-check path designed into the vault
 * (docs/wellness-group-build-note.md; operator, 2026-11-25: "add as many of
 * those keys as they think they need. And threshold of those wellness
 * checks. Along with owner as a has to sign").
 *
 * Run: node scripts/test-wellness-path.mjs
 */
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const { leavesCheck, leavesWire } = await import(new URL('../packages/vault-rules/src/leaves.js', import.meta.url).href);
const { callWasm } = await import(new URL('../netlify/functions/_ranged-wasm.js', import.meta.url).href);
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// Real points: k*G for small k (compressed).
const { secp256k1 } = await import('@noble/curves/secp256k1');
const key = (i) => Buffer.from(secp256k1.ProjectivePoint.BASE.multiply(BigInt(i)).toRawBytes(true)).toString('hex');
const OWNER = key(11);
const CHECKERS = [21, 22, 23, 24, 25].map(key);
const wellness = (view = 'blind') => ({ id: 'wellness', label: 'Wellness check', keys: CHECKERS, quorum: 3, required_keys: [OWNER], unlock: { type: 'immediate' }, decay: null, wellness: { view } });
const later = { id: 'later', label: 'Later', keys: [OWNER], quorum: 1, unlock: { type: 'after', blocks: 30_000 }, decay: null };

assert.equal(leavesCheck({ leaves: [wellness(), later] }).ok, true);
pass('owner must-sign + 3 of 5 checkers, with a later path: accepted');

let r = leavesCheck({ leaves: [wellness()] });
assert.equal(r.ok, false); assert.match(r.error, /needs a later path/);
pass('a wellness path with no later path is refused (operator: refuse)');

r = leavesCheck({ leaves: [{ ...wellness(), required_keys: undefined }, later] });
assert.equal(r.ok, false); assert.match(r.error, /must-sign key/);
pass('a wellness path without the owner as must-sign is refused');

r = leavesCheck({ leaves: [{ ...wellness(), wellness: { view: 'peek' } }, later] });
assert.equal(r.ok, false);
pass('an unreadable view is refused');

const wire = leavesWire([wellness('full'), later], 900_000);
assert.deepEqual(wire[0].wellness, { view: 'full' });
assert.equal(wire[1].wellness, undefined);
pass('the marker is stored with its path; other paths keep their exact shape');

// The marker never changes the script: same compile with and without it.
const compile = (ls) => callWasm('/compile-leaves', { network: 'signet', leaves: leavesWire(ls, 900_000) }).body;
const a = compile([wellness(), later]);
const b = compile([{ ...wellness(), wellness: undefined }, later]);
assert.ok(a.ok, JSON.stringify(a));
assert.equal(a.address, b.address);
assert.deepEqual(a.leaf_scripts, b.leaf_scripts);
const script = a.leaf_scripts.wellness;
assert.ok(script.includes(OWNER.slice(2)), 'owner key in the wellness script');
assert.ok(CHECKERS.every((c) => script.includes(c.slice(2))), 'every checker in the wellness script');
pass('Bitcoin enforces it: the compiled wellness path names the owner and all 5 checkers; the marker changes nothing on chain');

const { rotatedLeaves } = await import(new URL('../netlify/functions/_rotate.js', import.meta.url).href);
const out = rotatedLeaves([wellness('blind'), { ...later, unlock: { type: 'after', blocks: 930_000 } }], { later: 30_000 });
assert.deepEqual(out[0].wellness, { view: 'blind' });
assert.equal(out[1].wellness, undefined);
pass('rotating to a successor keeps the wellness path and its view');
console.log(`wellness-path tests passed (${n} cases)`);
