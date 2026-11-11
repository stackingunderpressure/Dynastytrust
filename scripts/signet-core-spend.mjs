/**
 * signet-core-spend.mjs -- a vault from our compiler, on the PUBLIC
 * signet network, spent with signatures made by Bitcoin Core alone.
 *
 * The private-chain proof (bitcoin-core-proof.mjs) shows the mechanics.
 * This shows the same thing where anyone can look it up.
 *
 * Bitcoin Core runs here OFFLINE in signet mode (a sandbox cannot reach
 * signet peers), so it cannot see coins or broadcast. The public
 * explorer (mempool.space/signet) is used for exactly those two things:
 * reading the coin and sending the finished transaction. Everything a
 * wallet does -- deriving the address, signing, finalizing -- is Core.
 *
 *   setup : make a throwaway seed (kept OUTSIDE the repo), compile the
 *           vault, have Core derive the address, print it.
 *   spend : once the address holds a coin -- try a dated path (the
 *           network must refuse it), then spend the everyday path with
 *           two signers in two separate Core wallets.
 *
 * Run (compiler on :8899):
 *   BITCOIN_BIN=... STATE=/path/outside/repo/state.json node --experimental-strip-types \
 *     --import ./scripts/register-ts-resolver.mjs scripts/signet-core-spend.mjs setup|spend
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import * as btc from '@scure/btc-signer';

const BIN = process.env.BITCOIN_BIN, STATE = process.env.STATE, phase = process.argv[2];
if (!BIN || !STATE || !['setup', 'spend'].includes(phase)) { console.error('Set BITCOIN_BIN and STATE; pass setup or spend.'); process.exit(2); }
const COMPILER = process.env.COMPILER_URL || 'http://127.0.0.1:8899';
const SECRET = process.env.COMPILER_SECRET || 'testsecret';
const API = 'https://mempool.space/signet/api';
const toHex = (b) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const get = async (path) => { const r = await fetch(API + path); if (!r.ok) throw new Error(`${path} -> ${r.status}`); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const post = async (endpoint, body) => {
  const res = await fetch(`${COMPILER}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(`${endpoint} -> ${res.status}: ${json.error || JSON.stringify(json)}`);
  return json;
};
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// ---- throwaway keys: never the published example seed, since anyone
// could sweep a coin sent to it.
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { mnemonic: generateMnemonic(wordlist, 128) };
const ROOT = HDKey.fromMasterSeed(mnemonicToSeedSync(state.mnemonic), { private: 0x04358394, public: 0x043587cf });
const FP = toHex(ROOT.identifier.slice(0, 4));
const S = [0, 1, 2].map((i) => {
  const acct = ROOT.derive(`m/86'/1'/${i}'`);
  const origin = `[${FP}/86h/1h/${i}h]`;
  return { i, pubkey: toHex(acct.deriveChild(0).deriveChild(0).publicKey), pub: `${origin}${acct.publicExtendedKey}/0/0`, prv: `${origin}${acct.privateExtendedKey}/0/0` };
});
const back = ROOT.derive("m/84'/1'/0'/0/0");
const returnAddr = btc.p2wpkh(back.publicKey, btc.TEST_NETWORK).address;

// ---- Bitcoin Core, signet mode, no network
const DATADIR = mkdtempSync(join(tmpdir(), 'dt-signet-'));
const daemon = spawn(join(BIN, 'bitcoind'), ['-signet', `-datadir=${DATADIR}`, '-connect=0', '-listen=0', '-dnsseed=0', '-fallbackfee=0.0001', '-printtoconsole=0'], { stdio: 'ignore' });
const cli = (wallet, ...args) => {
  const base = ['-signet', `-datadir=${DATADIR}`, ...(wallet ? [`-rpcwallet=${wallet}`] : [])];
  const out = execFileSync(join(BIN, 'bitcoin-cli'), [...base, ...args.map(a => (typeof a === 'string' ? a : JSON.stringify(a)))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { return JSON.parse(out); } catch { return out; }
};
process.on('exit', () => { try { cli(null, 'stop'); } catch { daemon.kill(); } });
for (let i = 0; i < 60; i++) { try { cli(null, 'getblockcount'); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
console.log(`Bitcoin Core ${cli(null, 'getnetworkinfo').subversion}, chain "${cli(null, 'getblockchaininfo').chain}", offline`);

const tip = Number(await get('/blocks/tip/height'));
if (!state.policy) {
  const leaf = (o) => ({ label: o.id, decay: null, ...o });
  state.policy = { leaves: [
    leaf({ id: 'everyday', keys: [S[0].pubkey, S[1].pubkey], quorum: 2, unlock: { type: 'immediate' } }),
    leaf({ id: 'backup', keys: [S[0].pubkey, S[2].pubkey], quorum: 2, unlock: { type: 'after', blocks: tip + 26_280 } }),
  ] };
}
const compiled = await post('/compile-leaves', { ...state.policy, network: 'signet' });
const ourSpk = toHex(btc.OutScript.encode(btc.Address(btc.TEST_NETWORK).decode(compiled.address)));
const swap = (form) => S.reduce((d, s) => d.split(s.pubkey).join(form(s)).split(s.pubkey.slice(2)).join(form(s)), compiled.descriptor);
const withSum = (d) => `${d}#${cli(null, 'getdescriptorinfo', d).checksum}`;
const exportDesc = withSum(swap(s => s.pub));
const coreAddr = cli(null, 'deriveaddresses', exportDesc)[0];
assert.equal(coreAddr, compiled.address);
pass(`Bitcoin Core, in signet mode, derives the same address as our compiler: ${coreAddr}`);
state.address = compiled.address; state.backupHeight = state.policy.leaves[1].unlock.blocks;
writeFileSync(STATE, JSON.stringify(state, null, 1), { mode: 0o600 });

if (phase === 'setup') {
  const utxos = await get(`/address/${state.address}/utxo`);
  console.log(`\nFund this signet address: ${state.address}`);
  console.log(`coins there now: ${utxos.length}; signet tip ${tip}; backup path opens at block ${state.backupHeight}`);
  process.exit(0);
}

// ---- spend
const utxos = (await get(`/address/${state.address}/utxo`)).filter(u => u.value >= 2_000);
if (!utxos.length) { console.log(`\nNo coin at ${state.address} yet. Nothing to spend.`); process.exit(3); }
const coin = utxos[0];
console.log(`coin: ${coin.txid}:${coin.vout}, ${coin.value} sats, ${coin.status.confirmed ? 'confirmed' : 'unconfirmed'}`);

const wallet = (name, holders) => {
  cli(null, 'createwallet', name, false, true);
  const r = cli(name, 'importdescriptors', [{ desc: withSum(swap(s => (holders.includes(s.i) ? s.prv : s.pub))), timestamp: 'now' }]);
  assert.equal(r[0].success, true, JSON.stringify(r[0]));
};
wallet('signer-0', [0]); wallet('signer-1', [1]); wallet('signer-2', [2]);

const FEE = 500;
// Core writes the transaction. Offline, it cannot know what the coin is
// worth, so the coin's own output (amount + script, read from the
// explorer) is attached -- the one thing a synced Core would have filled.
const draft = (locktime) => {
  const b64 = cli(null, 'createpsbt', [{ txid: coin.txid, vout: coin.vout, sequence: 4294967294 }], [{ [returnAddr]: (coin.value - FEE) / 1e8 }], locktime);
  const tx = btc.Transaction.fromPSBT(Buffer.from(b64, 'base64'), { allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.updateInput(0, { witnessUtxo: { amount: BigInt(coin.value), script: fromHex(ourSpk) } });
  return Buffer.from(tx.toPSBT()).toString('base64');
};
const signedBy = (names, locktime) => {
  const parts = names.map(w => cli(w, 'walletprocesspsbt', draft(locktime)).psbt);
  return cli(null, 'finalizepsbt', parts.length > 1 ? cli(null, 'combinepsbt', parts) : parts[0]);
};
const broadcast = async (hex) => { const r = await fetch(`${API}/tx`, { method: 'POST', body: hex }); return { ok: r.ok, text: (await r.text()).trim() }; };

// One signature is not enough.
assert.equal(signedBy(['signer-0'], 0).complete, false);
pass('one signer alone: Core cannot complete the spend');

// The dated path: Core signs it, the public network refuses it.
{
  const f = signedBy(['signer-0', 'signer-2'], state.backupHeight);
  assert.equal(f.complete, true);
  const r = await broadcast(f.hex);
  assert.equal(r.ok, false, `the network ACCEPTED a backup-path spend ${state.backupHeight - tip} blocks early: ${r.text}`);
  assert.match(r.text, /non-final/);
  pass(`backup path, ${state.backupHeight - tip} blocks before it opens: signed by Core, refused by signet as non-final`);
  assert.equal(signedBy(['signer-0', 'signer-2'], 0).complete, false);
  pass('backup path with no locktime: Core cannot complete it');
}

// The everyday path: two people, two separate Core wallets.
{
  const f = signedBy(['signer-0', 'signer-1'], 0);
  assert.equal(f.complete, true);
  const r = await broadcast(f.hex);
  assert.equal(r.ok, true, `signet refused the everyday spend: ${r.text}`);
  assert.match(r.text, /^[0-9a-f]{64}$/);
  state.spendTxid = r.text; writeFileSync(STATE, JSON.stringify(state, null, 1), { mode: 0o600 });
  pass(`everyday path: signed by two separate Core wallets, accepted by signet. txid ${r.text}`);
  console.log(`\nLook it up: https://mempool.space/signet/tx/${r.text}`);
}
console.log(`\nsignet-core-spend OK (${n} checks)`);
process.exit(0);
