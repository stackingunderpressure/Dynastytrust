/**
 * test-ranged-compile.mjs -- fresh addresses at compile
 * (netlify/functions/_ranged-compile.js), with the REAL compiler WebAssembly
 * and the Core-checked vectors (protocol/tests/vectors/ranged.json).
 *
 * Proves: a vault with xpub origins gets the vectors' three descriptors and
 * descriptor_version 2; "fixed" and xpub-less vaults keep one address; a key
 * that is not the vault's refuses the compile (nothing saved); and a compiled
 * address that is not receive/0 refuses too.
 *
 * Run:  node scripts/test-ranged-compile.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const { callWasm } = await import(F('_ranged-wasm.js'));
const { rangedFields, rangedOrigins, RANGED_FORMAT } = await import(F('_ranged-compile.js'));
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const shape = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(s => s.name === 'family');
// The vectors are regtest; the vault here is signet (same witness program).
const address0 = callWasm('/ranged-address', { multipath: shape.multipath_descriptor, receive: shape.receive_descriptor, change: shape.change_descriptor, network: 'signet', branch: 0, index: 0 }).body.address;
const compiled = { descriptor: shape.template_descriptor, address: address0 };
const origins = shape.origins.map(o => ({ fingerprint: o.fingerprint, account_path: o.account_path, xpub: o.xpub }));

// 1. Fresh by default: the vectors' descriptors, version 2.
let r = rangedFields(compiled, 'signet', undefined, origins);
assert.equal(r.addresses, 'fresh', JSON.stringify(r));
assert.deepEqual(r.fields, {
  descriptor_version: 2,
  descriptor_multipath: shape.multipath_descriptor,
  descriptor_receive: shape.receive_descriptor,
  descriptor_change: shape.change_descriptor,
  ranged_format: RANGED_FORMAT,
});
pass('fresh by default: the Core-checked descriptors, version 2');

// 2. A full key path ending /0/0 and an "h" hardened marker are cut back.
const full = origins.map(o => ({ ...o, account_path: o.account_path.replace(/'/g, 'h') + '/0/0' }));
assert.deepEqual(rangedFields(compiled, 'signet', 'fresh', full).fields, r.fields);
pass('a /0/0 key path is cut back to its account path');

// 3. Chosen fixed: nothing extra stored.
assert.deepEqual(rangedFields(compiled, 'signet', 'fixed', origins), { fields: {}, addresses: 'fixed', reason: 'chosen' });
pass('"fixed" keeps one address');

// 4. No usable xpubs (Tapit keys only, or junk): one fixed address, with the reason.
for (const bad of [[], null, [{ fingerprint: 'zz', account_path: 'm/1', xpub: 'nope' }]]) {
  const f = rangedFields(compiled, 'signet', 'fresh', bad);
  assert.equal(f.addresses, 'fixed'); assert.deepEqual(f.fields, {}); assert.match(f.reason, /fixed address/);
}
pass('no extended public keys: one fixed address, said plainly');

// 5. An xpub that is not one of this vault's keys: refused, nothing saved.
const { HDKey } = await import('@scure/bip32');
const TESTNET = { private: 0x04358394, public: 0x043587cf };
const foreign = HDKey.fromMasterSeed(new Uint8Array(32).fill(7), TESTNET).derive("m/48'/1'/0'/2'").publicExtendedKey;
assert.match(foreign, /^tpub/);
const wrong = [{ fingerprint: 'deadbeef', account_path: "m/48'/1'/0'/2'", xpub: foreign }, ...origins.slice(1)];
const w = rangedFields(compiled, 'signet', 'fresh', wrong);
assert.equal(w.status, 422, JSON.stringify(w)); assert.match(w.error, /nothing was saved/);
pass('a key that is not the vault\'s never changes which vault it is');

// 6. The compiled address is not receive/0: refused.
const m = rangedFields({ ...compiled, address: 'tb1qnotthisvault' }, 'signet', 'fresh', origins);
assert.equal(m.status, 500); assert.match(m.error, /own address/);
pass('receive/0 must be the compiled address');

// 7. The wasm throws: refused, nothing saved.
const t = rangedFields(compiled, 'signet', 'fresh', origins, () => { throw new Error('boom'); });
assert.equal(t.status, 500); assert.match(t.error, /nothing was saved/);
pass('a compiler failure refuses the compile');

// 8. rangedOrigins drops duplicates and caps the list.
assert.equal(rangedOrigins([...origins, ...origins]).length, origins.length);
pass('duplicate xpubs dropped');

console.log(`ranged-compile tests passed (${n} cases)`);
