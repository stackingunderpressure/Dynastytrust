// Run from the repo root: node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs <this> <out>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
process.env.SUPABASE_URL = 'https://x.supabase.co';
const { callWasm } = await import(`${ROOT}/netlify/functions/_ranged-wasm.js`);
const { buildRangedSpend } = await import(`${ROOT}/netlify/functions/_ranged-spend.js`);
const L = (f) => `${ROOT}/apps/web/src/lib/${f}`;
const bc = await import(L('browser-compiler.ts'));
bc.useCompilerWasmBytes(new Uint8Array(readFileSync(`${ROOT}/apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm`)));
const { signPsbtWithMnemonic, mergePsbts } = await import(L('psbt-signer.ts'));
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const rq = createRequire(ROOT + '/apps/web/package.json');
const { HDKey } = await import(pathToFileURL(rq.resolve('@scure/bip32')).href);
const { mnemonicToSeedSync } = await import(pathToFileURL(rq.resolve('@scure/bip39')).href);
const hex = (b) => Buffer.from(b).toString('hex');
const TESTNET = { private: 0x04358394, public: 0x043587cf };
const PATH = "m/48'/1'/0'/2'";
const MN = ['abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'];
const K = MN.map(m => { const root = HDKey.fromMasterSeed(mnemonicToSeedSync(m), TESTNET); const a = root.derive(PATH);
  return { fingerprint: root.fingerprint.toString(16).padStart(8, '0'), xpub: a.publicExtendedKey, pubkey: hex(a.deriveChild(0).deriveChild(0).publicKey) }; });
const leaves = [
  { id: 'everyday', label: 'Everyday signers', keys: [K[0].pubkey, K[1].pubkey], quorum: 1, unlock: { type: 'immediate' }, decay: null },
  { id: 'path-2', label: 'Path 2', keys: [K[2].pubkey], quorum: 1, unlock: { type: 'older', blocks: 100 }, decay: null },
];
const compiled = callWasm('/compile-leaves', { name: 'Walk', network: 'signet', leaves, consent_keys: [], consent_quorum: null }).body;
if (!compiled.ok) throw new Error(JSON.stringify(compiled));
const origins = K.map(k => ({ fingerprint: k.fingerprint, account_path: PATH, xpub: k.xpub }));
const ranged = callWasm('/ranged-compile', { template: compiled.descriptor, network: 'signet', origins }).body;
if (!ranged.ok || ranged.receive0 !== compiled.address) throw new Error(JSON.stringify(ranged));
const addr = (b, i) => callWasm('/ranged-address', { multipath: ranged.multipath, receive: ranged.receive, change: ranged.change, network: 'signet', branch: b, index: i }).body.address;
const addrs = [0, 1, 2, 3, 4, 5].map(i => addr(0, i));
const TIP = 332480, COIN_TXID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';
const V = { id: 'x', name: 'Walk', status: 'compiled', network: 'signet', address: compiled.address, leaf_scripts: compiled.leaf_scripts,
  leaves: leaves.map(l => ({ id: l.id, unlock: l.unlock })), descriptor_version: 2, descriptor_multipath: ranged.multipath, descriptor_receive: ranged.receive, descriptor_change: ranged.change };
const sb = { from: () => { const o = { select: () => o, eq: () => o, in: () => o, order: () => o, limit: () => o, then: (res) => res({ data: [], error: null }), insert: async () => ({ error: null }) }; return o; }, rpc: async () => ({ data: 0, error: null }) };
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const r = await buildRangedSpend({ supabase: sb, vault: V, userId: 'u', body: { destination: DEST, amount_sats: 5000, path: 'everyday' } },
  { coinsAt: async () => [{ txid: COIN_TXID, vout: 0, value: 9071, status: { confirmed: true, block_height: 332478 }, address: addrs[2], branch: 0, index: 2 }], fetchTipHeight: async () => TIP, getFeeRate: async () => 2, vaultUsed: async () => new Set(addrs.slice(0, 3)) });
if (r.status !== 200) throw new Error(JSON.stringify(r.body));
const s1 = await signPsbtWithMnemonic(r.body.psbt_hex, MN[0], PATH, 'testnet');
const merged = mergePsbts([r.body.psbt_hex, s1.psbt_hex]);
const keyOrigins = K.map(k => ({ pubkey: k.pubkey, fingerprint: k.fingerprint, derivation_path: PATH + '/0/0' }));
writeFileSync(process.argv[2], JSON.stringify({ compiled, ranged, addrs, pk: K.map(k => k.pubkey), keyOrigins, origins, leaves,
  proposalPsbt: r.body, signed1: { psbt_hex: s1.psbt_hex, added: s1.signaturesAdded }, merged }, null, 2));
console.log('ok', compiled.address, 'sigs', s1.signaturesAdded, 'fee', r.body.summary.fee_sats, 'change', r.body.summary.change_address);
