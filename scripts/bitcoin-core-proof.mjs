/**
 * bitcoin-core-proof.mjs -- does a DynastyTrust vault stand on its own
 * in Bitcoin Core, with this app gone?
 *
 * A path-builder vault is compiled by the REAL Rust compiler, then a
 * private regtest chain run by a stock Bitcoin Core binary is asked to:
 *   1. derive the address from our descriptor (the form the app exports,
 *      `[fingerprint/path]xpub/0/0`) and agree with ours byte for byte;
 *   2. watch it, fund it, and spend from it signing with Core ALONE
 *      (seeds handed to Core as tprv) -- the everyday path, then a dated
 *      path before and after its height;
 *   3. accept and mine a spend built, signed and finalized by OUR OWN
 *      compiler and browser signer -- a real node's consensus check on
 *      our transactions, which the offline harness never had.
 *
 * NOT part of `npm test`: it needs a Bitcoin Core download.
 * Run (compiler on :8899 as scripts/offline-harness.sh starts it):
 *   BITCOIN_BIN=/path/to/bitcoin-32.1/bin node --experimental-strip-types \
 *     --import ./scripts/register-ts-resolver.mjs scripts/bitcoin-core-proof.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as btc from '@scure/btc-signer';
import { signPsbtWithMnemonic, mergePsbts } from '../apps/web/src/lib/psbt-signer.ts';

const BIN = process.env.BITCOIN_BIN;
if (!BIN) { console.error('Set BITCOIN_BIN to a Bitcoin Core bin/ directory.'); process.exit(2); }
const COMPILER = process.env.COMPILER_URL || 'http://127.0.0.1:8899';
const SECRET = process.env.COMPILER_SECRET || 'testsecret';
const NET = 'signet';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ROOT = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC), { private: 0x04358394, public: 0x043587cf });
const toHex = (b) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const FP = toHex(ROOT.identifier.slice(0, 4));
const S = Array.from({ length: 9 }, (_, n) => {
  const path = `m/86'/1'/${n}'`;
  const acct = ROOT.derive(path);
  const origin = `[${FP}/86h/1h/${n}h]`;
  return { n, path, pubkey: toHex(acct.deriveChild(0).deriveChild(0).publicKey),
    pub: `${origin}${acct.publicExtendedKey}/0/0`, prv: `${origin}${acct.privateExtendedKey}/0/0` };
});
const keys = (...i) => i.map(n => S[n].pubkey);

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const note = (l) => console.log(`  [..] ${l}`);

// COMPILER_URL=wasm: every compiler request goes to the BROWSER compiler
// (apps/web/src/lib/browser-compiler.ts + the committed .wasm), with no
// server at all -- sovereign slice 1's proof that Bitcoin Core accepts
// vaults and spends built entirely on a device.
let onDevice = null;
async function post(endpoint, body) {
  let res;
  if (COMPILER === 'wasm') {
    if (!onDevice) {
      onDevice = await import(new URL('../apps/web/src/lib/browser-compiler.ts', import.meta.url).href);
      const { readFileSync: rf } = await import('node:fs');
      onDevice.useCompilerWasmBytes(new Uint8Array(rf(new URL('../apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm', import.meta.url))));
    }
    const out = await onDevice.compileOnDevice(endpoint, body);
    res = { ok: out.status === 200, status: out.status, json: async () => JSON.parse(out.body) };
  } else {
    res = await fetch(`${COMPILER}${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
  }
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(`${endpoint} -> ${res.status}: ${json.error || JSON.stringify(json)}`);
  return json;
}

// ---- a private chain
const DATADIR = mkdtempSync(join(tmpdir(), 'dt-core-'));
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

// ---- the vault: five paths, signer 0 on three of them. The compiler
// refuses a dated path under 26,000 blocks, so the private chain is
// mined past that.
const leaf = (o) => ({ label: o.id, decay: null, ...o });
const policy = { leaves: [
  leaf({ id: 'everyday', keys: keys(0, 1, 2), quorum: 3, unlock: { type: 'immediate' } }),
  leaf({ id: 'backup',   keys: keys(0, 3),    quorum: 2, unlock: { type: 'after', blocks: 26_100 } }),
  leaf({ id: 'kids',     keys: keys(0, 4, 5), quorum: 2, unlock: { type: 'after', blocks: 26_200 } }),
  leaf({ id: 'friends',  keys: keys(6, 7),    quorum: 2, unlock: { type: 'after', blocks: 26_300 } }),
  leaf({ id: 'last',     keys: keys(8),       quorum: 1, unlock: { type: 'after', blocks: 26_400 } }),
] };
const compiled = await post('/compile-leaves', { ...policy, network: NET });
const ourSpk = toHex(btc.OutScript.encode(btc.Address(btc.TEST_NETWORK).decode(compiled.address)));
console.log(`our compiler: ${compiled.address}`);

// The descriptor in the three forms that matter.
const swap = (form) => S.reduce((d, s) => d.split(s.pubkey).join(form(s)).split(s.pubkey.slice(2)).join(form(s)), compiled.descriptor.split('#')[0]);
const withSum = (d) => `${d}#${cli(null, 'getdescriptorinfo', d).checksum}`;
const spkOf = (d) => cli(null, 'validateaddress', cli(null, 'deriveaddresses', d)[0]).scriptPubKey;

// 1. Same address.
const rawErr = cliFails(null, 'getdescriptorinfo', compiled.descriptor.split('#')[0]);
if (rawErr) note(`the compiler's raw descriptor (bare public keys) is NOT accepted by Core as is: ${rawErr.split('\n').pop()}`);
else { assert.equal(spkOf(withSum(compiled.descriptor.split('#')[0])), ourSpk); pass('Core derives our exact output script from the compiler\'s raw descriptor'); }
const exportDesc = withSum(swap(s => s.pub));
assert.equal(spkOf(exportDesc), ourSpk);
const vaultAddr = cli(null, 'deriveaddresses', exportDesc)[0];
pass(`Core derives our exact output script from the exported form ([fingerprint/path]xpub/0/0): ${ourSpk}`);

// The same vault written the way many-address wallets (Nunchuk) expect:
// every key ranged. Its first receive address must be our address; its
// second must not be, and is an address this app does not watch.
{
  const ranged = withSum(swap(s => s.pub.replace(/\/0\/0$/, '/0/*')));
  const [first, second] = cli(null, 'deriveaddresses', ranged, [0, 1]);
  assert.equal(cli(null, 'validateaddress', first).scriptPubKey, ourSpk);
  assert.notEqual(cli(null, 'validateaddress', second).scriptPubKey, ourSpk);
  pass('a ranged (many-address) version of the descriptor gives our address at index 0 and a different one at index 1');
}

// 2. Wallets holding only some seeds, like real people.
const wallet = (name, holders) => {
  cli(null, 'createwallet', name, false, true);
  const d = withSum(swap(s => (holders.includes(s.n) ? s.prv : s.pub)));
  const r = cli(name, 'importdescriptors', [{ desc: d, timestamp: 'now' }]);
  assert.equal(r[0].success, true, `${name}: ${JSON.stringify(r[0])}`);
  return r[0].warnings ?? [];
};
wallet('everyday', [0, 1, 2]);
wallet('kids', [4, 5]);
wallet('lone-shared', [0]);
wallet('friend-a', [6]);
wallet('friend-b', [7]);
cli(null, 'createwallet', 'watch', true, true);
assert.equal(cli('watch', 'importdescriptors', [{ desc: exportDesc, timestamp: 'now' }])[0].success, true);
pass('Core imports the vault watch-only, and as three wallets each holding only some of the seeds');

const fund = () => { const txid = cli('miner', 'sendtoaddress', vaultAddr, 1); mine(1); const tx = cli('miner', 'gettransaction', txid, true, true); return { txid, vout: tx.decoded.vout.findIndex(o => o.scriptPubKey.hex === ourSpk) }; };
const coins = [fund(), fund(), fund(), fund(), fund()];
assert.equal(cli('watch', 'getbalance'), 5);
pass('Core sees the deposits: watch-only balance 5.00000000');

const dest = cli('miner', 'getnewaddress', '', 'bech32m');
const draft = (coin, locktime) => cli(null, 'createpsbt', [{ txid: coin.txid, vout: coin.vout, sequence: 0xfffffffe }], [{ [dest]: 0.999 }], locktime);
const spend = (name, coin, locktime) => {
  const p = cli(name, 'walletprocesspsbt', draft(coin, locktime));
  const f = cli(null, 'finalizepsbt', p.psbt);
  return { complete: f.complete, hex: f.hex };
};
const witnessOf = (hex) => cli(null, 'decoderawtransaction', hex).vin[0].txinwitness;
const confirmed = (txid) => cli(null, 'getrawtransaction', txid, 1).confirmations >= 1;

// Everyday: three seeds in one Core wallet, no waiting.
{
  const r = spend('everyday', coins[0], 0);
  assert.equal(r.complete, true);
  const txid = cli(null, 'sendrawtransaction', r.hex); mine(1);
  assert.ok(confirmed(txid));
  pass(`everyday path: signed by Core alone with 3 seeds, mined (${witnessOf(r.hex).length - 2} signatures in the witness)`);
}
// The shared key alone opens nothing, at any locktime.
{
  assert.equal(spend('lone-shared', coins[1], 0).complete, false);
  assert.equal(spend('lone-shared', coins[1], 26_400).complete, false);
  pass('the shared key on its own cannot complete a spend, with or without a locktime');
}
// The kids: two seeds, a dated path, WITHOUT the shared key.
{
  assert.equal(spend('kids', coins[1], 0).complete, false);
  pass('kids path: Core will not complete it with no locktime set');
  const r = spend('kids', coins[1], 26_200);
  assert.equal(r.complete, true);
  const height = cli(null, 'getblockcount');
  assert.ok(height < 26_199);
  const early = cliFails(null, 'sendrawtransaction', r.hex);
  assert.ok(early && /non-final/.test(early), `expected non-final, got: ${early}`);
  pass(`kids path at height ${height}: signed, but the network refuses it as non-final before block 26,200`);
  mine(26_200 - height);
  const txid = cli(null, 'sendrawtransaction', r.hex); mine(1);
  assert.ok(confirmed(txid));
  pass(`kids path at height ${cli(null, 'getblockcount') - 1}: the same transaction is accepted and mined, signed by the 2 kids only`);
}

// 3. Our own stack's transaction, judged by a real node.
{
  const coin = coins[2];
  const destSignet = btc.Address(btc.TEST_NETWORK).encode(btc.OutScript.decode(Uint8Array.from(cli(null, 'validateaddress', dest).scriptPubKey.match(/../g).map(h => parseInt(h, 16)))));
  const bin = await post('/psbt-binary', { ...policy, path: 'backup', destination: destSignet, amount_sats: 90_000_000, fee_sats: 20_000,
    inputs: [{ txid: coin.txid, vout: coin.vout, value_sats: 100_000_000, script_pubkey: ourSpk }], change_address: compiled.address, network: NET });
  const signed = [];
  for (const s of [S[0], S[3]]) signed.push((await signPsbtWithMnemonic(bin.psbt_hex, MNEMONIC, s.path, 'testnet')).psbt_hex);
  const raw = (await post('/psbt-finalize', { psbt_hex: mergePsbts(signed) })).raw_tx_hex;
  const verdict = cli(null, 'testmempoolaccept', [raw])[0];
  assert.equal(verdict.allowed, true, JSON.stringify(verdict));
  const txid = cli(null, 'sendrawtransaction', raw); mine(1);
  assert.ok(confirmed(txid));
  const change = cli(null, 'getrawtransaction', txid, 1).vout.find(o => o.scriptPubKey.hex === ourSpk);
  assert.ok(change, 'change did not return to the vault');
  pass(`a backup-path spend built, signed and finalized by OUR compiler and browser signer is accepted and mined by Core; change of ${change.value} returned to the vault`);

  // And the other direction: our PSBT, signed by Core, finalized by Core.
  const bin2 = await post('/psbt-binary', { ...policy, path: 'everyday', destination: destSignet, amount_sats: 90_000_000, fee_sats: 20_000,
    inputs: [{ txid: coins[3].txid, vout: coins[3].vout, value_sats: 100_000_000, script_pubkey: ourSpk }], change_address: compiled.address, network: NET });
  const b64 = Buffer.from(bin2.psbt_hex, 'hex').toString('base64');
  const p = cli('everyday', 'walletprocesspsbt', b64);
  const f = cli(null, 'finalizepsbt', p.psbt);
  assert.equal(f.complete, true);
  const txid2 = cli(null, 'sendrawtransaction', f.hex); mine(1);
  assert.ok(confirmed(txid2));
  pass('a spend our compiler built is signed and finalized by Core instead of our signer, and mined');
}

// 4. The written recovery instructions, step for step: two people on two
// separate computers, each holding one seed, a dated path.
{
  const coin = cli('watch', 'listunspent').find(u => u.txid === coins[4].txid);
  assert.ok(coin && coin.amount === 1);
  const height = cli(null, 'getblockcount');
  if (height < 26_300) mine(26_300 - height);
  const unsigned = cli(null, 'createpsbt', [{ txid: coin.txid, vout: coin.vout, sequence: 4294967294 }], [{ [dest]: 0.9999 }], 26_300);
  const a = cli('friend-a', 'walletprocesspsbt', unsigned);
  const b = cli('friend-b', 'walletprocesspsbt', unsigned);
  assert.equal(a.complete, false); assert.equal(b.complete, false);
  assert.equal(cli(null, 'finalizepsbt', a.psbt).complete, false);
  const f = cli(null, 'finalizepsbt', cli(null, 'combinepsbt', [a.psbt, b.psbt]));
  assert.equal(f.complete, true);
  const txid = cli(null, 'sendrawtransaction', f.hex); mine(1);
  assert.ok(confirmed(txid));
  pass('the written steps: listunspent, createpsbt with the locktime, two people sign in separate wallets, combinepsbt, finalizepsbt, sendrawtransaction -- mined');
}

// 5. Must-sign keys (compiler slice, 2026-11-12): and(pk(A), thresh(q, others)).
// Does Core read that descriptor, agree on the address, and enforce it?
{
  const ms = { leaves: [
    leaf({ id: 'everyday', required_keys: keys(0), keys: keys(1, 2), quorum: 1, unlock: { type: 'immediate' } }),
    leaf({ id: 'later', required_keys: keys(0), keys: keys(3, 4), quorum: 1, unlock: { type: 'after', blocks: 26_500 } }),
  ] };
  const c = await post('/compile-leaves', { ...ms, network: NET });
  const spk = toHex(btc.OutScript.encode(btc.Address(btc.TEST_NETWORK).decode(c.address)));
  const form = (f) => S.reduce((d, s) => d.split(s.pubkey).join(f(s)).split(s.pubkey.slice(2)).join(f(s)), c.descriptor.split('#')[0]);
  const pub = withSum(form(s => s.pub));
  assert.equal(spkOf(pub), spk);
  const addr = cli(null, 'deriveaddresses', pub)[0];
  const mk = (name, holders) => { cli(null, 'createwallet', name, false, true); assert.equal(cli(name, 'importdescriptors', [{ desc: withSum(form(s => (holders.includes(s.n) ? s.prv : s.pub))), timestamp: 'now' }])[0].success, true); };
  mk('ms-with', [0, 1]); mk('ms-without', [1, 2]); mk('ms-alone', [0]);
  const txid0 = cli('miner', 'sendtoaddress', addr, 1); mine(1);
  const vout = cli('miner', 'gettransaction', txid0, true, true).decoded.vout.findIndex(o => o.scriptPubKey.hex === spk);
  const go = (w) => cli(null, 'finalizepsbt', cli(w, 'walletprocesspsbt', cli(null, 'createpsbt', [{ txid: txid0, vout, sequence: 0xfffffffe }], [{ [dest]: 0.999 }], 0)).psbt);
  assert.equal(go('ms-without').complete, false);
  assert.equal(go('ms-alone').complete, false);
  const f = go('ms-with');
  assert.equal(f.complete, true);
  const txid = cli(null, 'sendrawtransaction', f.hex); mine(1);
  assert.ok(confirmed(txid));
  pass('must-sign vault: Core derives our exact output script; both others without the must-sign key cannot complete, the must-sign key alone cannot, the must-sign key + one other is mined');
}

console.log(`\nbitcoin-core-proof OK (${n} checks) against ${version}`);
process.exit(0);
