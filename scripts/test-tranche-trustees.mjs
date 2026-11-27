/**
 * test-tranche-trustees.mjs -- a Distribution wallet (tranche) can be made
 * on a vault built with the path builder (lib/tranche-trustees.ts).
 *
 * Before 2026-11-27 the creator read vault.founder_keys, which a
 * path-builder vault never fills, so it sent no trustees and
 * compile-tranche refused. This runs the real in-process compiler with
 * the trustees the creator now picks. Wired into `npm test`.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-tranche-trustees.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { HDKey } = await import('@scure/bip32');
const { trancheTrusteeOptions } = await import('../apps/web/src/lib/tranche-trustees.ts');
const { compilerPost } = await import('../netlify/functions/_compiler.js');
const bc = await import('../apps/web/src/lib/browser-compiler.ts');
bc.useCompilerWasmBytes(new Uint8Array(readFileSync(new URL('../apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm', import.meta.url))));

const hex = (b) => Buffer.from(b).toString('hex');
const node = (n) => HDKey.fromMasterSeed(new Uint8Array(32).fill(n));
const PK = (n) => hex(node(n).deriveChild(0).deriveChild(0).publicKey);
const leaf = (o) => ({ label: o.id, decay: null, ...o });

// A path-builder vault exactly as stored: founder columns at DB defaults.
const BUILDER = { founder_keys: [], founder_quorum: 2 };
const EVERYDAY = leaf({ id: 'everyday', label: 'Everyday signers', keys: [PK(1)], quorum: 1, unlock: { type: 'immediate' } });
const LATER = leaf({ id: 'kids', keys: [PK(2), PK(3)], quorum: 1, unlock: { type: 'after', blocks: 960_000 } });

let n = 0;

// 1. The bug: the old rule (founder_keys) finds no trustees on this vault.
assert.deepEqual(BUILDER.founder_keys, []); n++;

// 2. The right-away path becomes the trustees, and the real compiler takes it.
{
  const { choices } = trancheTrusteeOptions({ ...BUILDER, leaves: [EVERYDAY, LATER] });
  assert.equal(choices.length, 1); n++;
  assert.deepEqual(choices[0], { id: 'everyday', label: 'Everyday signers', keys: [PK(1)], quorum: 1 }); n++;
  const res = await compilerPost('/compile-tranche', {
    network: 'bitcoin', beneficiary_key: PK(5), trustee_keys: choices[0].keys,
    trustee_quorum: choices[0].quorum, unlock_block: 930_000,
  });
  assert.equal(res.status, 200); n++;
  const body = await res.json();
  assert.match(body.address, /^bc1p/); n++;
}

// 3. A later (time-locked) path is never a trustee: the escape is "any time".
assert.equal(trancheTrusteeOptions({ ...BUILDER, leaves: [LATER] }).choices.length, 0); n++;

// 4. Must-sign and wellness paths are left out, with the reason said.
{
  const must = { ...EVERYDAY, id: 'must', label: 'With Mom', required_keys: [PK(6)] };
  const well = { ...EVERYDAY, id: 'well', label: 'Wellness check', wellness: { view: 'blind' } };
  const { choices, skipped } = trancheTrusteeOptions({ ...BUILDER, leaves: [must, well, LATER] });
  assert.equal(choices.length, 0); n++;
  assert.deepEqual(skipped.map((s) => s.label), ['With Mom', 'Wellness check']); n++;
  assert.match(skipped[0].reason, /must-sign/); n++;
  assert.match(skipped[1].reason, /wellness/); n++;
}

// 5. Two right-away paths: both offered, in vault order.
{
  const two = { ...EVERYDAY, id: 'pair', label: 'Mom and Dad', keys: [PK(1), PK(7)], quorum: 2 };
  assert.deepEqual(trancheTrusteeOptions({ ...BUILDER, leaves: [EVERYDAY, two] }).choices.map((c) => c.id), ['everyday', 'pair']); n++;
}

// 6. An unfinished path (slot not filled) is not offered.
assert.equal(trancheTrusteeOptions({ ...BUILDER, leaves: [{ ...EVERYDAY, keys: [] }] }).choices.length, 0); n++;

// 7. A vault built the older way still uses its founders, unchanged.
{
  const { choices } = trancheTrusteeOptions({ leaves: null, founder_keys: [PK(1), PK(2), PK(3)], founder_quorum: 2 });
  assert.deepEqual(choices, [{ id: 'founders', label: 'Founders', keys: [PK(1), PK(2), PK(3)], quorum: 2 }]); n++;
  assert.equal(trancheTrusteeOptions({ leaves: null, founder_keys: [], founder_quorum: 2 }).choices.length, 0); n++;
}

console.log(`tranche-trustees tests passed (${n} assertions, compiled a mainnet tranche from a path-builder vault)`);
