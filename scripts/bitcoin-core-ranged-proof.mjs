/**
 * bitcoin-core-ranged-proof.mjs -- does a vault with a NEW ADDRESS EVERY
 * TIME (ranged addresses, slices 3-6) stand on its own in Bitcoin Core,
 * with this app gone? The sibling of bitcoin-core-proof.mjs (one-address
 * vaults). Everything the backup file tells a family to type for a
 * fresh-address vault (lib/recovery-instructions.ts coreRangedRecoveryLines)
 * is run here first, against a stock Bitcoin Core on a private chain:
 *   1. Core reads our `<0;1>/*` descriptor, gives it the same checksum, and
 *      derives the same receive and change addresses as our compiler;
 *   2. one watch-only import of that ONE descriptor sees coins on several
 *      receive addresses and a change address;
 *   3. two people, each with one seed in their own Core wallet, spend
 *      coins from two different addresses with Core alone;
 *   4. a spend built by OUR server code and signed by OUR browser signer
 *      from two addresses, change to a fresh change address, is accepted;
 *   5. the "if left untouched" path: refused before the coin's own wait is
 *      over, accepted after -- by our stack, and by Core alone.
 *
 * NOT part of `npm test`: it needs a Bitcoin Core download.
 *   BITCOIN_BIN=/path/to/bitcoin-32.1/bin node --experimental-strip-types \
 *     --import ./scripts/register-ts-resolver.mjs scripts/bitcoin-core-ranged-proof.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as btc from '@scure/btc-signer';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const BIN = process.env.BITCOIN_BIN;
if (!BIN) { console.error('Set BITCOIN_BIN to a Bitcoin Core bin/ directory.'); process.exit(2); }
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const L = (f) => new URL(`../apps/web/src/lib/${f}`, import.meta.url).href;
const bc = await import(L('browser-compiler.ts'));
bc.useCompilerWasmBytes(new Uint8Array(readFileSync(new URL('../apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm', import.meta.url))));
const { signPsbtWithMnemonic, mergePsbts } = await import(L('psbt-signer.ts'));
const { checkFreshSpendAddresses } = await import(L('fresh-addresses.ts'));
const { signersOnEveryInput } = await import(L('psbt-signer.ts'));
const { callWasm } = await import(F('_ranged-wasm.js'));
const { buildRangedSpend } = await import(F('_ranged-spend.js'));

const NET = 'signet';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ROOT = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC), { private: 0x04358394, public: 0x043587cf });
const toHex = (b) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const FP = toHex(ROOT.identifier.slice(0, 4));
const S = Array.from({ length: 3 }, (_, n) => {
  const path = `m/48'/1'/${n}'/2'`;
  const acct = ROOT.derive(path);
  return { n, path, acct, pubkey: toHex(acct.deriveChild(0).deriveChild(0).publicKey), xpub: acct.publicExtendedKey, xprv: acct.privateExtendedKey };
});
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const wasm = (ep, body) => { const r = callWasm(ep, body); if (r.status !== 200 || r.body.ok === false) throw new Error(`${ep}: ${JSON.stringify(r.body)}`); return r.body; };

// ---- a private chain
const DATADIR = mkdtempSync(join(tmpdir(), 'dt-core-ranged-'));
const daemon = spawn(join(BIN, 'bitcoind'), ['-regtest', `-datadir=${DATADIR}`, '-fallbackfee=0.0001', '-txindex=1', '-listen=0', '-printtoconsole=0'], { stdio: 'ignore' });
const cli = (wallet, ...args) => {
  const base = ['-regtest', `-datadir=${DATADIR}`, ...(wallet ? [`-rpcwallet=${wallet}`] : [])];
  const out = execFileSync(join(BIN, 'bitcoin-cli'), [...base, ...args.map(a => (typeof a === 'string' ? a : JSON.stringify(a)))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { return JSON.parse(out); } catch { return out; }
};
const cliFails = (wallet, ...args) => { try { cli(wallet, ...args); return null; } catch (e) { return String(e.stderr || e.message).trim(); } };
const stop = () => { try { cli(null, 'stop'); } catch { daemon.kill(); } };
process.on('exit', stop);
for (let i = 0; i < 60; i++) { try { cli(null, 'getblockcount'); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
const version = cli(null, 'getnetworkinfo').subversion;
console.log(`Bitcoin Core ${version}, private regtest chain`);
cli(null, 'createwallet', 'miner');
const minerAddr = cli('miner', 'getnewaddress', '', 'bech32m');
const mine = (k) => { for (let left = k; left > 0; left -= 1000) cli('miner', 'generatetoaddress', Math.min(left, 1000), minerAddr); };
mine(101);

// ---- the vault: a DEAD MAN'S SWITCH -- everyday 2 of 3; "quiet" 1 of 3 if
// left untouched 150 blocks, and no fixed-date path at all (allowed since
// 2026-11-24, docs/untouched-only-build-note.md).
const QUIET = 150;
const leaves = [
  { id: 'everyday', label: 'everyday', keys: S.map(s => s.pubkey), quorum: 2, unlock: { type: 'immediate' } },
  { id: 'quiet', label: 'quiet', keys: S.map(s => s.pubkey), quorum: 1, unlock: { type: 'older', blocks: QUIET } },
];
const compiled = wasm('/compile-leaves', { network: NET, leaves });
const ranged = wasm('/ranged-compile', { template: compiled.descriptor, network: NET, origins: S.map(s => ({ fingerprint: FP, account_path: s.path, xpub: s.xpub })) });
assert.equal(ranged.receive0, compiled.address);
const V = { id: '88888888-8888-8888-8888-888888888888', name: 'Core proof', status: 'compiled', network: NET, address: compiled.address,
  leaf_scripts: compiled.leaf_scripts, leaves: leaves.map(l => ({ id: l.id, unlock: l.unlock })),
  descriptor_version: 2, descriptor_multipath: ranged.multipath, descriptor_receive: ranged.receive, descriptor_change: ranged.change };
const ours = (branch, start, count) => wasm('/ranged-addresses', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: NET, branch, start, count }).addresses;
const spkOfAddr = (a) => cli(null, 'validateaddress', a).scriptPubKey;
const toSignet = (bcrt) => btc.Address(btc.TEST_NETWORK).encode(btc.OutScript.decode(Uint8Array.from(spkOfAddr(bcrt).match(/../g).map(h => parseInt(h, 16)))));

// 1. Same descriptor, same addresses.
const info = cli(null, 'getdescriptorinfo', V.descriptor_multipath.split('#')[0]);
assert.equal(`${V.descriptor_multipath.split('#')[0]}#${info.checksum}`, V.descriptor_multipath);
assert.equal(info.multipath_expansion.length, 2);
for (const [branch, d] of [[0, info.multipath_expansion[0]], [1, info.multipath_expansion[1]]]) {
  const core = cli(null, 'deriveaddresses', d, [0, 499]).map(spkOfAddr);
  const mine500 = [...ours(branch, 0, 200), ...ours(branch, 200, 200), ...ours(branch, 400, 100)];
  assert.deepEqual(core, mine500.map(a => a.script_pubkey));
}
pass(`Core gives our fresh-address descriptor the same checksum (${info.checksum}) and the same receive and change addresses 0-499`);

// 2. ONE watch-only import, exactly as the backup file says.
cli(null, 'createwallet', 'vault', true, true);
const imp = cli('vault', 'importdescriptors', [{ desc: V.descriptor_multipath, timestamp: 0, range: [0, 999], active: true }]);
assert.equal(imp[0].success, true, JSON.stringify(imp));
const at = (branch, index) => ours(branch, index, 1)[0];
const fund = (addr, btcAmount) => {
  const txid = cli('miner', 'sendtoaddress', addr, btcAmount); mine(1);
  const tx = cli('miner', 'gettransaction', txid, true, true);
  return { txid, vout: tx.decoded.vout.findIndex(o => o.scriptPubKey.address === addr), value: btcAmount };
};
const bcrt = (branch, index) => cli(null, 'deriveaddresses', info.multipath_expansion[branch], [index, index])[0];
const coins = {
  r0: fund(bcrt(0, 0), 1), r7: fund(bcrt(0, 7), 1), c3: fund(bcrt(1, 3), 1), r12: fund(bcrt(0, 12), 1), r20: fund(bcrt(0, 20), 1),
};
assert.equal(toSignet(bcrt(0, 7)), at(0, 7).address);
assert.equal(cli('vault', 'getbalance'), 5);
const listed = cli('vault', 'listunspent');
assert.equal(listed.length, 5);
assert.deepEqual(new Set(listed.map(u => u.address)), new Set([bcrt(0, 0), bcrt(0, 7), bcrt(1, 3), bcrt(0, 12), bcrt(0, 20)]));
pass('one watch-only import of the one descriptor sees coins on receive 0, 7, 12, 20 and change 3: balance 5.00000000, and listunspent lists all five');

// 3. Core alone: two people, one seed each, coins from two addresses.
const withKeys = (held) => S.reduce((d, s) => (held.includes(s.n) ? d.split(s.xpub).join(s.xprv) : d), V.descriptor_multipath.split('#')[0]);
const signer = (name, held) => {
  cli(null, 'createwallet', name, false, true);
  const d = withKeys(held);
  const r = cli(name, 'importdescriptors', [{ desc: `${d}#${cli(null, 'getdescriptorinfo', d).checksum}`, timestamp: 0, range: [0, 999], active: true }]);
  assert.equal(r[0].success, true, JSON.stringify(r));
};
signer('alice', [0]); signer('bob', [1]);
const dest = cli('miner', 'getnewaddress', '', 'bech32m');
{
  const unsigned = cli(null, 'createpsbt', [{ txid: coins.r7.txid, vout: coins.r7.vout, sequence: 4294967294 }, { txid: coins.c3.txid, vout: coins.c3.vout, sequence: 4294967294 }], [{ [dest]: 1.999 }], 0);
  const a = cli('alice', 'walletprocesspsbt', unsigned);
  const b = cli('bob', 'walletprocesspsbt', unsigned);
  assert.equal(a.complete, false); assert.equal(b.complete, false);
  const f = cli(null, 'finalizepsbt', cli(null, 'combinepsbt', [a.psbt, b.psbt]));
  assert.equal(f.complete, true);
  const txid = cli(null, 'sendrawtransaction', f.hex); mine(1);
  assert.ok(cli(null, 'getrawtransaction', txid, 1).confirmations >= 1);
  pass('Core alone: two people in separate wallets sign coins on receive 7 and change 3, combinepsbt, finalizepsbt -- mined');
}

// 4. Our server code + our browser signer, judged by Core.
const tip = () => cli(null, 'getblockcount');
const coinFor = (c, branch, index) => ({ txid: c.txid, vout: c.vout, value: Math.round(c.value * 1e8), status: { confirmed: true, block_height: cli(null, 'getrawtransaction', c.txid, 1).confirmations && tip() - cli(null, 'getrawtransaction', c.txid, 1).confirmations + 1 }, address: at(branch, index).address, branch, index });
let reserved = 0;
// Change addresses already issued (an abandoned spend leaves one), and which
// of them the chain says were ever paid -- the reuse rule's two inputs.
let issuedChange = [];
let usedChange = new Set();
const supabase = {
  from: () => { const o = { select: () => o, eq: () => o, order: () => o, limit: async () => ({ data: issuedChange, error: null }), then: (res) => res({ data: [{ branch: 0, next_index: 21 }, { branch: 1, next_index: reserved }], error: null }), insert: async () => ({ error: null }) }; return o; },
  rpc: async () => ({ data: reserved++ + 10, error: null }),
};
const build = async (path, amount, list) => {
  const r = await buildRangedSpend({ supabase, vault: V, userId: 'u', body: { destination: toSignet(dest), amount_sats: amount, path, fee_rate: 2 } },
    { coinsAt: async () => list, fetchTipHeight: async () => tip(), getFeeRate: async () => 2, vaultUsed: async () => usedChange });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await checkFreshSpendAddresses(V, r.body.psbt_hex), { ok: true });
  return r.body;
};
{
  const b = await build('everyday', 150_000_000, [coinFor(coins.r0, 0, 0), coinFor(coins.r12, 0, 12)]);
  assert.equal(b.summary.addresses_combined, 2);
  const s1 = await signPsbtWithMnemonic(b.psbt_hex, MNEMONIC, S[0].path, 'testnet');
  const s2 = await signPsbtWithMnemonic(b.psbt_hex, MNEMONIC, S[2].path, 'testnet');
  const raw = wasm('/psbt-finalize', { psbt_hex: mergePsbts([b.psbt_hex, s1.psbt_hex, s2.psbt_hex]) }).raw_tx_hex;
  const verdict = cli(null, 'testmempoolaccept', [raw])[0];
  assert.equal(verdict.allowed, true, JSON.stringify(verdict));
  const txid = cli(null, 'sendrawtransaction', raw); mine(1);
  const change = cli(null, 'getrawtransaction', txid, 1).vout.find(o => o.scriptPubKey.address === bcrt(1, 10));
  assert.ok(change, 'change did not go to change address 10');
  assert.equal(cli('vault', 'getaddressinfo', bcrt(1, 10)).ismine, true);
  pass(`our server built and our browser signer signed a spend of receive 0 + receive 12; Core mined it; the change (${change.value}) is on never-used change address 10 and Core's watch-only wallet counts it as the vault's`);
}

// 4b. Who signed, as the app counts it (packages/vault-rules ranged-signers):
// a child key's signature counts once, for its own vault key, and nothing
// else is credited. Judged against the keys Core just accepted.
{
  // Coins of their own: receive 7 was spent by Core alone in step 3.
  const r30 = fund(bcrt(0, 30), 1), r31 = fund(bcrt(0, 31), 1);
  const b = await build('everyday', 40_000_000, [coinFor(r30, 0, 30)]);
  const s0 = await signPsbtWithMnemonic(b.psbt_hex, MNEMONIC, S[0].path, 'testnet');
  const s2 = await signPsbtWithMnemonic(b.psbt_hex, MNEMONIC, S[2].path, 'testnet');
  const xonly = (k) => k.slice(2).toLowerCase();
  assert.deepEqual(signersOnEveryInput(s0.psbt_hex, V.descriptor_multipath), [xonly(S[0].pubkey)]);
  const both = mergePsbts([b.psbt_hex, s0.psbt_hex, s2.psbt_hex]);
  assert.deepEqual(new Set(signersOnEveryInput(both, V.descriptor_multipath)), new Set([xonly(S[0].pubkey), xonly(S[2].pubkey)]));
  assert.equal(signersOnEveryInput(mergePsbts([b.psbt_hex, s0.psbt_hex, s0.psbt_hex]), V.descriptor_multipath).length, 1);
  // Without the vault's descriptor the child is not credited to anyone's
  // vault key: no stand-in, no guess.
  assert.ok(!signersOnEveryInput(both, null).includes(xonly(S[0].pubkey)));
  const raw = wasm('/psbt-finalize', { psbt_hex: both }).raw_tx_hex;
  assert.equal(cli(null, 'testmempoolaccept', [raw])[0].allowed, true);
  pass('the signatures Core accepts are exactly the ones the app counts: each child key credited once to its own vault key, a repeated signature not double-counted, nothing credited without the vault descriptor');

  // A change address issued for a spend never sent is reused, and Core
  // accepts the result.
  issuedChange = [{ idx: 11, address: at(1, 11).address }];
  usedChange = new Set();
  const b2 = await build('everyday', 40_000_000, [coinFor(r31, 0, 31)]);
  const t = btc.Transaction.fromPSBT(Uint8Array.from(b2.psbt_hex.match(/../g).map(h => parseInt(h, 16))));
  const outs = Array.from({ length: t.outputsLength }, (_, i) => btc.Address(btc.TEST_NETWORK).encode(btc.OutScript.decode(t.getOutput(i).script)));
  assert.ok(outs.includes(at(1, 11).address), `change not on the abandoned change address 11: ${outs}`);
  const m2 = mergePsbts([b2.psbt_hex, (await signPsbtWithMnemonic(b2.psbt_hex, MNEMONIC, S[0].path, 'testnet')).psbt_hex, (await signPsbtWithMnemonic(b2.psbt_hex, MNEMONIC, S[1].path, 'testnet')).psbt_hex]);
  const raw2 = wasm('/psbt-finalize', { psbt_hex: m2 }).raw_tx_hex;
  const txid2 = cli(null, 'sendrawtransaction', raw2); mine(1);
  assert.ok(cli(null, 'getrawtransaction', txid2, 1).vout.some(o => o.scriptPubKey.address === bcrt(1, 11)));
  assert.equal(cli('vault', 'getaddressinfo', bcrt(1, 11)).ismine, true);
  pass('an issued-but-never-paid change address (11) is reused for the next spend; Core mines it and counts the change as the vault\'s');
  issuedChange = []; usedChange = new Set();

  // The same transaction checked against ANOTHER vault: its change is not
  // that vault's, so the change check must refuse it.
  const T = S.map(s2 => { const path = s2.path.replace("/2'", "/1'"); const acct = ROOT.derive(path); return { path, xpub: acct.publicExtendedKey, pubkey: toHex(acct.deriveChild(0).deriveChild(0).publicKey) }; });
  const otherCompiled = wasm('/compile-leaves', { network: NET, leaves: leaves.map(l => ({ ...l, keys: T.map(t => t.pubkey) })) });
  const other = wasm('/ranged-compile', { template: otherCompiled.descriptor, network: NET, origins: T.map(t => ({ fingerprint: FP, account_path: t.path, xpub: t.xpub })) });
  const otherVault = { ...V, leaf_scripts: otherCompiled.leaf_scripts, descriptor_multipath: other.multipath, descriptor_receive: other.receive, descriptor_change: other.change, address: other.receive0 };
  const verdict = await checkFreshSpendAddresses(otherVault, b2.psbt_hex);
  assert.equal(verdict.ok, false, 'a spend checked against a different vault was accepted');
  // Honest scope: this refusal fires on the INPUTS (they are not the other
  // vault's). A spend with this vault's inputs but someone else's change is
  // the case test-change-scripts / Tapit's change check cover, not this one.
  pass(`the address check refuses this spend when judged against a different vault (${String(verdict.reason ?? verdict.error ?? 'refused').slice(0, 60)})`);
}

// 5. "If left untouched", by our stack and by Core alone.
{
  const young = fund(bcrt(0, 15), 1);
  const b = await build('quiet', 50_000_000, [{ ...coinFor(young, 0, 15), status: { confirmed: true, block_height: tip() - QUIET + 1 } }]);
  const s = await signPsbtWithMnemonic(b.psbt_hex, MNEMONIC, S[1].path, 'testnet');
  const raw = wasm('/psbt-finalize', { psbt_hex: s.psbt_hex }).raw_tx_hex;
  const early = cli(null, 'testmempoolaccept', [raw])[0];
  assert.equal(early.allowed, false); assert.match(early['reject-reason'], /non-BIP68-final/);
  pass(`"if left untouched" (${QUIET} blocks): one key alone, signed by our stack, refused by Core while the coin is 1 block old (non-BIP68-final)`);
  mine(QUIET - 1);
  assert.equal(cli(null, 'testmempoolaccept', [raw])[0].allowed, true);
  const txid = cli(null, 'sendrawtransaction', raw); mine(1);
  assert.ok(cli(null, 'getrawtransaction', txid, 1).confirmations >= 1);
  pass(`the same transaction is accepted and mined once the coin has sat ${QUIET} blocks`);

  // Core alone, as the backup file says: the sequence is the wait.
  const coin = coins.r20;
  const unsigned = cli(null, 'createpsbt', [{ txid: coin.txid, vout: coin.vout, sequence: QUIET }], [{ [dest]: 0.999 }], 0);
  const f = cli(null, 'finalizepsbt', cli('bob', 'walletprocesspsbt', unsigned).psbt);
  assert.equal(f.complete, true);
  const txid2 = cli(null, 'sendrawtransaction', f.hex); mine(1);
  assert.ok(cli(null, 'getrawtransaction', txid2, 1).confirmations >= 1);
  pass(`Core alone: one person spends the "if left untouched" path with createpsbt sequence ${QUIET} -- mined`);
}

// 6. A vault MIXING a bare Tapit key (no xpub: the same key at every
// address) with two xpub keys -- the shape a family with one Tapit co-signer
// makes. Core is the referee and also stands in for Tapit's signer (a
// wallet holding only that one bare key).
{
  const tapPriv = ROOT.derive("m/86'/1'/0'/0/7").privateKey;
  const tapX = toHex(ROOT.derive("m/86'/1'/0'/0/7").publicKey.slice(1));
  const tapC = toHex(ROOT.derive("m/86'/1'/0'/0/7").publicKey);
  const mixLeaves = [
    { id: 'everyday', label: 'everyday', keys: [S[0].pubkey, S[1].pubkey, tapC], quorum: 2, unlock: { type: 'immediate' } },
    { id: 'later', label: 'later', keys: [S[0].pubkey, S[1].pubkey, tapC], quorum: 1, unlock: { type: 'after', blocks: 900_000 } },
  ];
  const mc = wasm('/compile-leaves', { network: NET, leaves: mixLeaves });
  const mr = wasm('/ranged-compile', { template: mc.descriptor, network: NET, origins: [S[0], S[1]].map(k => ({ fingerprint: FP, account_path: k.path, xpub: k.xpub })) });
  assert.equal(mr.receive0, mc.address);
  assert.ok(mr.multipath.includes(tapX), 'the bare key is not in the multipath descriptor as itself');
  const MV = { ...V, id: '99999999-9999-9999-9999-999999999999', address: mc.address, leaf_scripts: mc.leaf_scripts,
    leaves: mixLeaves.map(l => ({ id: l.id, unlock: l.unlock })), descriptor_multipath: mr.multipath, descriptor_receive: mr.receive, descriptor_change: mr.change };
  const minfo = cli(null, 'getdescriptorinfo', MV.descriptor_multipath.split('#')[0]);
  assert.equal(`${MV.descriptor_multipath.split('#')[0]}#${minfo.checksum}`, MV.descriptor_multipath);
  const mours = (branch, start, count) => wasm('/ranged-addresses', { multipath: MV.descriptor_multipath, receive: MV.descriptor_receive, change: MV.descriptor_change, network: NET, branch, start, count }).addresses;
  for (const branch of [0, 1]) {
    const core = cli(null, 'deriveaddresses', minfo.multipath_expansion[branch], [0, 199]).map(spkOfAddr);
    assert.deepEqual(core, mours(branch, 0, 200).map(a => a.script_pubkey));
  }
  pass(`mixed vault (2 xpub keys + 1 bare Tapit key): Core gives the same checksum (${minfo.checksum}) and the same receive and change addresses 0-199`);

  // Core as Tapit: a wallet holding ONLY the bare key's private half.
  const wif = btc.WIF(btc.TEST_NETWORK).encode(tapPriv);
  const md = MV.descriptor_multipath.split('#')[0];
  const tapDesc = md.includes(tapC) ? md.split(tapC).join(wif) : md.split(tapX).join(wif);
  cli(null, 'createwallet', 'tapit', false, true);
  const ti = cli('tapit', 'importdescriptors', [{ desc: `${tapDesc}#${cli(null, 'getdescriptorinfo', tapDesc).checksum}`, timestamp: 0, range: [0, 999], active: true }]);
  assert.equal(ti[0].success, true, JSON.stringify(ti));
  const mbcrt = (branch, index) => cli(null, 'deriveaddresses', minfo.multipath_expansion[branch], [index, index])[0];
  const mcoin = fund(mbcrt(0, 5), 1);

  // Our server builds; our browser signer signs with xpub key 0 (a CHILD
  // key at receive 5); Core-as-Tapit signs with the bare key; our
  // finalizer finishes; Core judges and mines.
  const supa = { from: () => { const o = { select: () => o, eq: () => o, order: () => o, limit: async () => ({ data: [], error: null }), then: (res) => res({ data: [{ branch: 0, next_index: 6 }, { branch: 1, next_index: 0 }], error: null }), insert: async () => ({ error: null }) }; return o; }, rpc: async () => ({ data: 0, error: null }) };
  const r = await buildRangedSpend({ supabase: supa, vault: MV, userId: 'u', body: { destination: toSignet(dest), amount_sats: 40_000_000, path: 'everyday', fee_rate: 2 } },
    { coinsAt: async () => [{ ...coinFor(mcoin, 0, 5), address: mours(0, 5, 1)[0].address }], fetchTipHeight: async () => tip(), getFeeRate: async () => 2, vaultUsed: async () => new Set() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await checkFreshSpendAddresses(MV, r.body.psbt_hex), { ok: true });
  const ours0 = await signPsbtWithMnemonic(r.body.psbt_hex, MNEMONIC, S[0].path, 'testnet');
  const b64 = Buffer.from(r.body.psbt_hex, 'hex').toString('base64');
  const tapSigned = cli('tapit', 'walletprocesspsbt', b64, true, 'DEFAULT', true, false);
  const tapHex = Buffer.from(tapSigned.psbt, 'base64').toString('hex');
  const merged = mergePsbts([r.body.psbt_hex, ours0.psbt_hex, tapHex]);
  const xonly = (k) => k.slice(2).toLowerCase();
  assert.deepEqual(new Set(signersOnEveryInput(merged, MV.descriptor_multipath)), new Set([xonly(S[0].pubkey), tapX]));
  pass('the app counts exactly the two who signed: xpub key 0 (its child at receive 5, mapped back) and the bare Tapit key as itself');
  const raw = wasm('/psbt-finalize', { psbt_hex: merged }).raw_tx_hex;
  assert.equal(cli(null, 'testmempoolaccept', [raw])[0].allowed, true);
  const txid = cli(null, 'sendrawtransaction', raw); mine(1);
  assert.ok(cli(null, 'getrawtransaction', txid, 1).confirmations >= 1);
  pass('built by our server, signed by our browser signer + a bare-key signer (Core standing in for Tapit), finalized by us: Core mines it');

  // One signature alone is not enough, whoever it is.
  assert.throws(() => wasm('/psbt-finalize', { psbt_hex: mergePsbts([r.body.psbt_hex, tapHex]) }));
  pass('the bare Tapit key alone cannot complete a 2-of-3 spend');
}

console.log(`\nbitcoin-core-ranged-proof OK (${n} checks) against ${version}`);
process.exit(0);
