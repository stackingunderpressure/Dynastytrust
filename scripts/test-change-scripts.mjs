/**
 * test-change-scripts.mjs -- the change-address list a Tapit membership
 * request carries (apps/web/src/lib/change-scripts.ts;
 * docs/tapit-review-modes-build-note.md), plus the grants migration staying
 * additive.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-change-scripts.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const { callWasm } = await import(new URL('../netlify/functions/_ranged-wasm.js', import.meta.url).href);
const { changeScriptsFor, CHANGE_LIST_SIZE } = await import(new URL('../apps/web/src/lib/change-scripts.ts', import.meta.url).href);
const { HDKey } = await import('@scure/bip32');
const { mnemonicToSeedSync } = await import('@scure/bip39');
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const hex = (b) => Buffer.from(b).toString('hex');
const TESTNET = { private: 0x04358394, public: 0x043587cf };
const PATH = "m/48'/1'/0'/2'";
const key = (m) => { const root = HDKey.fromMasterSeed(mnemonicToSeedSync(m), TESTNET); const acct = root.derive(PATH);
  return { fingerprint: root.fingerprint.toString(16).padStart(8, '0'), xpub: acct.publicExtendedKey, pubkey: hex(acct.deriveChild(0).deriveChild(0).publicKey) }; };
const k1 = key('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const TAPIT = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const leaves = [{ id: 'everyday', label: 'everyday', keys: [TAPIT, k1.pubkey], quorum: 1, unlock: { type: 'immediate' } },
  { id: 'later', label: 'later', keys: [k1.pubkey], quorum: 1, unlock: { type: 'after', blocks: 900_000 } }];
const compiled = callWasm('/compile-leaves', { network: 'signet', leaves }).body;
const ranged = callWasm('/ranged-compile', { template: compiled.descriptor, network: 'signet', origins: [{ fingerprint: k1.fingerprint, account_path: PATH, xpub: k1.xpub }] }).body;
const V = { address: compiled.address, network: 'signet', descriptor_version: 2, descriptor_multipath: ranged.multipath, descriptor_receive: ranged.receive, descriptor_change: ranged.change };
// Stand-in for the browser's wasm deriver: the same Rust, through the server's copy.
const derive = async (branch, index) => callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch, index }).body;

const r = await changeScriptsFor(V, 7, derive);
assert.equal(r.scripts.length, CHANGE_LIST_SIZE);
assert.equal(r.until, 7 + CHANGE_LIST_SIZE);
assert.equal(r.scripts[0], (await derive(1, 7)).script_pubkey.toLowerCase());
assert.equal(r.scripts[199], (await derive(1, 206)).script_pubkey.toLowerCase());
assert.ok(r.scripts.every(s => /^5120[0-9a-f]{64}$/.test(s)));
pass('a fresh-address vault lists its next 200 change addresses, from the next index');

const receive = new Set(await Promise.all(Array.from({ length: 10 }, async (_, i) => (await derive(0, i)).script_pubkey.toLowerCase())));
assert.ok(r.scripts.every(s => !receive.has(s)));
pass('none of them is a receive address');

await assert.rejects(changeScriptsFor({ ...V, address: 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c' }, 0, derive), /does not start at its own address/);
pass('refused when the stored descriptors do not start at the vault address');

const one = await changeScriptsFor({ ...V, descriptor_version: 1 }, 0, derive);
assert.deepEqual(one, { scripts: [(await derive(0, 0)).script_pubkey.toLowerCase()], until: null });
pass("a one-address vault's change list is its one address");

const mig = readFileSync(new URL('../supabase/migrations/20261124210000_grant_review_mode.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '').toLowerCase();
assert.ok(!/\b(drop table|drop column|delete from|update |truncate)\b/.test(mig));
assert.match(mig, /review_mode text not null default 'wellness'/);
pass("the grants migration only adds; every existing member stays 'wellness'");
console.log(`change-scripts tests passed (${n} cases)`);
