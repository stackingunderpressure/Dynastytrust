/**
 * test-ranged-sign.mjs -- end to end for a vault with a new address every
 * time (ranged slice 5): two seed phrases make a vault through the compiler
 * wasm; the SERVER builds a spend from two of its addresses
 * (_ranged-spend.js); the BROWSER checks every coin and the change against
 * addresses it derives itself (lib/fresh-addresses.ts) and signs with each
 * key's own child at each coin's address (lib/psbt-signer.ts); the result
 * finalizes (miniscript checks signatures and locks).
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-ranged-sign.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const L = (f) => new URL(`../apps/web/src/lib/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const bc = await import(L('browser-compiler.ts'));
bc.useCompilerWasmBytes(new Uint8Array(readFileSync(new URL('../apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm', import.meta.url))));
const { signPsbtWithMnemonic, mergePsbts } = await import(L('psbt-signer.ts'));
const { checkFreshSpendAddresses } = await import(L('fresh-addresses.ts'));
const { callWasm } = await import(F('_ranged-wasm.js'));
const { buildRangedSpend } = await import(F('_ranged-spend.js'));
const { HDKey } = await import('@scure/bip32');
const { mnemonicToSeedSync } = await import('@scure/bip39');
const hex = (b) => Buffer.from(b).toString('hex');

const TESTNET = { private: 0x04358394, public: 0x043587cf };
const PATH = "m/48'/1'/0'/2'";
const M1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const M2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const M3 = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const key = (m) => {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(m), TESTNET);
  const acct = root.derive(PATH);
  return { fingerprint: root.fingerprint.toString(16).padStart(8, '0'), xpub: acct.publicExtendedKey, pubkey: hex(acct.deriveChild(0).deriveChild(0).publicKey) };
};
const [k1, k2] = [key(M1), key(M2)];

// The vault: everyday 2-of-2 now; "quiet" 1-of-2 if left untouched 100
// blocks; a dated 1-of-2 path (a vault never rests on older() alone).
const leaves = [
  { id: 'everyday', label: 'everyday', keys: [k1.pubkey, k2.pubkey], quorum: 2, unlock: { type: 'immediate' } },
  { id: 'quiet', label: 'quiet', keys: [k1.pubkey, k2.pubkey], quorum: 1, unlock: { type: 'older', blocks: 100 } },
  { id: 'later', label: 'later', keys: [k1.pubkey, k2.pubkey], quorum: 1, unlock: { type: 'after', blocks: 900_000 } },
];
const compiled = callWasm('/compile-leaves', { network: 'signet', leaves }).body;
assert.ok(compiled.ok, JSON.stringify(compiled));
const ranged = callWasm('/ranged-compile', { template: compiled.descriptor, network: 'signet', origins: [k1, k2].map(k => ({ fingerprint: k.fingerprint, account_path: PATH, xpub: k.xpub })) }).body;
assert.ok(ranged.ok, JSON.stringify(ranged)); assert.equal(ranged.receive0, compiled.address);
const V = {
  id: '77777777-7777-7777-7777-777777777777', name: 'Two phones', status: 'compiled', network: 'signet', address: compiled.address,
  leaf_scripts: compiled.leaf_scripts, leaves: leaves.map(l => ({ id: l.id, unlock: l.unlock })),
  descriptor_version: 2, descriptor_multipath: ranged.multipath, descriptor_receive: ranged.receive, descriptor_change: ranged.change,
};
pass('two seed phrases make a fresh-address vault whose first address is the compiled one');

const addr = (b, i) => callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch: b, index: i }).body.address;
const TIP = 200_000;
const coin = (b, i, value, height, k) => ({ txid: k.toString(16).padStart(64, '0'), vout: 0, value, status: { confirmed: true, block_height: height }, address: addr(b, i), branch: b, index: i });
let db;
const supabase = {
  from: (t) => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, then: (res) => res(t === 'vault_addresses' ? { data: [], error: null } : { data: [{ branch: 0, next_index: 4 }, { branch: 1, next_index: 0 }], error: null }), insert: async (row) => { db.push(row); return { error: null }; } }; return o; },
  rpc: async () => ({ data: 0, error: null }),
};
const build = async (path, amount, coins) => {
  db = [];
  const r = await buildRangedSpend({ supabase, vault: V, userId: 'u', body: { destination: addr(0, 30), amount_sats: amount, path } },
    { coinsAt: async () => coins, fetchTipHeight: async () => TIP, getFeeRate: async () => 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

// 1. Everyday: coins on receive 2 and receive 3, change to change 0.
const coins = [coin(0, 2, 30_000, TIP - 500, 1), coin(0, 3, 45_000, TIP - 500, 2)];
const built = await build('everyday', 60_000, coins);
assert.equal(built.summary.addresses_combined, 2);
assert.deepEqual(await checkFreshSpendAddresses(V, built.psbt_hex), { ok: true });
pass('the browser derives each coin\'s and the change\'s address itself and accepts the spend');

// 2. Each phone signs with its key's own child at each coin's address; it finalizes.
const s1 = await signPsbtWithMnemonic(built.psbt_hex, M1, PATH, 'testnet');
const s2 = await signPsbtWithMnemonic(built.psbt_hex, M2, PATH, 'testnet');
assert.equal(s1.signaturesAdded, 2); assert.equal(s2.signaturesAdded, 2);
let fin = callWasm('/psbt-finalize', { psbt_hex: mergePsbts([built.psbt_hex, s1.psbt_hex, s2.psbt_hex]) });
assert.equal(fin.status, 200, JSON.stringify(fin.body)); assert.ok(fin.body.ok);
pass('two phones sign coins on receive 2 and 3 (their /0/2 and /0/3 keys) and the spend finalizes');

// 3. "If left untouched": one phone alone, the old-enough coin only.
const quiet = await build('quiet', 10_000, [coin(0, 1, 40_000, TIP - 150, 3), coin(0, 2, 40_000, TIP - 5, 4)]);
assert.equal(quiet.summary.waiting.length, 1);
assert.deepEqual(await checkFreshSpendAddresses(V, quiet.psbt_hex), { ok: true });
const q1 = await signPsbtWithMnemonic(quiet.psbt_hex, M1, PATH, 'testnet');
fin = callWasm('/psbt-finalize', { psbt_hex: q1.psbt_hex });
assert.equal(fin.status, 200, JSON.stringify(fin.body));
pass('"if left untouched": one phone alone spends the old-enough coin; it finalizes with the wait on the input');

// 4. A key that is not in the vault: nothing to sign.
await assert.rejects(() => signPsbtWithMnemonic(built.psbt_hex, M3, PATH, 'testnet'), /not a signer/);
pass('a seed phrase that is not one of the vault\'s keys signs nothing');

// 5. The browser refuses a spend of ANOTHER vault's coins, and a vault whose
//    stored address list does not start at its own address.
const k3 = key(M3);
const otherLeaves = [{ id: 'everyday', label: 'everyday', keys: [k1.pubkey, k3.pubkey], quorum: 2, unlock: { type: 'immediate' } }];
const oc = callWasm('/compile-leaves', { network: 'signet', leaves: otherLeaves }).body;
const or = callWasm('/ranged-compile', { template: oc.descriptor, network: 'signet', origins: [k1, k3].map(k => ({ fingerprint: k.fingerprint, account_path: PATH, xpub: k.xpub })) }).body;
const OTHER = { ...V, address: oc.address, leaf_scripts: oc.leaf_scripts, leaves: [{ id: 'everyday', unlock: { type: 'immediate' } }], descriptor_multipath: or.multipath, descriptor_receive: or.receive, descriptor_change: or.change };
db = [];
const foreign = await buildRangedSpend({ supabase, vault: OTHER, userId: 'u', body: { destination: addr(0, 30), amount_sats: 20_000, path: 'everyday' } },
  { coinsAt: async () => [{ ...coin(0, 0, 40_000, TIP - 500, 5), address: undefined }].map(c => ({ ...c, branch: 0, index: 1 })), fetchTipHeight: async () => TIP, getFeeRate: async () => 2 });
assert.equal(foreign.status, 200, JSON.stringify(foreign.body));
const r5 = await checkFreshSpendAddresses(V, foreign.body.psbt_hex);
assert.equal(r5.ok, false); assert.match(r5.reason, /does not spend this vault's own coins/);
const r6 = await checkFreshSpendAddresses({ ...V, address: oc.address }, built.psbt_hex);
assert.equal(r6.ok, false); assert.match(r6.reason, /does not start at its own address/);
pass("another vault's coins are refused; so is a vault whose address list does not start at its own address");

console.log(`ranged-sign tests passed (${n} cases)`);
