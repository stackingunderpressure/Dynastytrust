/**
 * download-local-proof.mjs -- the downloaded DynastyTrust, with NO server
 * of ours: one person builds a standard vault, funds it, and spends from it,
 * every call answered by apps/web/src/lib/local-server (the same vault
 * rules as the website's server, the compiler running on the device) and
 * a stock Bitcoin Core on a private regtest chain.
 *
 * The desktop shell's one native command (`bitcoin_rpc`) is stood in for by
 * bitcoin-cli, with the shell's own allow-list and wallet-name rules
 * (desktop/src-tauri/src/main.rs) applied, so a call the shell would refuse
 * fails here too.
 *
 * NOT part of `npm test`: it needs a Bitcoin Core download.
 * Run:
 *   BITCOIN_BIN=/path/to/bitcoin-32.1/bin node --experimental-strip-types \
 *     --import ./scripts/register-ts-resolver.mjs scripts/download-local-proof.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';

const BIN = process.env.BITCOIN_BIN;
if (!BIN) { console.error('Set BITCOIN_BIN to a Bitcoin Core bin/ directory.'); process.exit(2); }

// This computer's storage, as the app sees it.
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};

// ---- a private chain
const DATADIR = mkdtempSync(join(tmpdir(), 'dt-dl-'));
const daemon = spawn(join(BIN, 'bitcoind'), ['-regtest', `-datadir=${DATADIR}`, '-listen=0', '-printtoconsole=0'], { stdio: 'ignore' });
const cli = (wallet, ...args) => {
  const base = ['-regtest', `-datadir=${DATADIR}`, ...(wallet ? [`-rpcwallet=${wallet}`] : [])];
  const out = execFileSync(join(BIN, 'bitcoin-cli'), [...base, ...args.map(a => (typeof a === 'string' ? a : JSON.stringify(a)))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { return JSON.parse(out); } catch { return out; }
};
const stop = () => { try { cli(null, 'stop'); } catch { daemon.kill(); } };
process.on('exit', stop);
for (let i = 0; i < 60; i++) { try { cli(null, 'getblockcount'); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
console.log(`Bitcoin Core ${cli(null, 'getnetworkinfo').subversion}, private regtest chain`);

// ---- the desktop shell, stood in for. Same allow-list as main.rs.
const ALLOWED = ['getblockchaininfo', 'getdescriptorinfo', 'getblockcount', 'getblockhash', 'getblockheader', 'getrawtransaction',
  'estimatesmartfee', 'testmempoolaccept', 'sendrawtransaction', 'gettxout', 'listwallets', 'loadwallet', 'createwallet'];
const WALLET_SCOPED = ['importdescriptors', 'listunspent', 'listtransactions', 'gettransaction', 'getwalletinfo', 'rescanblockchain'];
const calls = [];
const dl = await import('../apps/web/src/lib/download.ts');
dl.useInvoke(async (cmd, { conn, method, params, wallet }) => {
  assert.equal(cmd, 'bitcoin_rpc');
  assert.equal(conn.network, 'regtest');
  calls.push(method);
  if (wallet != null) {
    if (!WALLET_SCOPED.includes(method)) throw new Error(`the shell refuses ${method} on a wallet`);
    if (!String(wallet).startsWith('dynastytrust-')) throw new Error('the shell only touches dynastytrust-* wallets');
  } else if (!ALLOWED.includes(method)) throw new Error(`the shell refuses ${method}`);
  if (method === 'createwallet' && JSON.stringify(params.slice(1)) !== '[true,true]') throw new Error('createwallet must be blank and watch-only');
  try { return cli(wallet, method, ...params); } catch (e) { throw new Error(String(e.stderr || e.message).trim()); }
});

const bc = await import('../apps/web/src/lib/browser-compiler.ts');
bc.useCompilerWasmBytes(new Uint8Array(readFileSync(new URL('../apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm', import.meta.url))));
const core = await import('../apps/web/src/lib/local-server/core.ts');
core.saveCoreConn({ network: 'regtest' });
const { handleLocal } = await import('../apps/web/src/lib/local-server/index.ts');
const { signPsbtWithMnemonic, mergePsbts } = await import('../apps/web/src/lib/psbt-signer.ts');

// The screens' own chain calls (lib/chain.ts and the send buttons' fetch to
// config.ts broadcastTxUrl), with the download's stand-in installed exactly
// as main.tsx installs it. Any request that would still leave the computer
// is caught here and fails the run.
const leaked = [];
globalThis.fetch = async (input) => { leaked.push(String(input)); throw new Error(`left the computer: ${input}`); };
const { installChainFetch } = await import('../apps/web/src/lib/local-server/chain-fetch.ts');
installChainFetch();
const chain = await import('../apps/web/src/lib/chain.ts');
const { broadcastTxUrl, EXPLORER } = await import('../apps/web/src/config.ts');

const call = async (path, method = 'GET', body) => handleLocal(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
const must = async (...a) => {
  const r = await call(...a);
  if (r.status !== 200 || r.payload.ok === false) throw new Error(`${a[1] ?? 'GET'} ${a[0]} -> ${r.status}: ${r.payload.error}`);
  return r.payload;
};

let n = 0; const pass = l => { n++; console.log(`  [ok] ${l}`); };

cli(null, 'createwallet', 'miner');
const minerAddr = cli('miner', 'getnewaddress', '', 'bech32m');
const mine = k => cli('miner', 'generatetoaddress', k, minerAddr);
mine(101);

// ---- keys: three people's seeds (this test holds all three).
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ROOT = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC), { private: 0x04358394, public: 0x043587cf });
const hex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const FP = hex(ROOT.identifier.slice(0, 4));
const key = i => {
  const derivation_path = `m/86'/1'/${i}'`;
  const acct = ROOT.derive(derivation_path);
  return { xpub: acct.publicExtendedKey, fingerprint: FP, derivation_path, pubkey: hex(acct.deriveChild(0).deriveChild(0).publicKey), label: `Key ${i}` };
};

// 1. A draft, then the vault compiled on this device.
const draft = (await must('/vaults', 'POST', { mode: 'draft', name: 'Family', network: 'signet', planned_founder_count: 2, planned_heir_count: 1, founder_quorum: 2, heir_quorum: 1 })).vault;
assert.equal(draft.status, 'draft');
const v = (await must('/vaults-compile', 'POST', { vault_id: draft.id, direct_keys: { founder_keys: [key(0), key(1)], heir_keys: [key(2)] } })).vault;
assert.equal(v.status, 'compiled');
assert.match(String(v.address), /^tb1p/);
const tip = cli(null, 'getblockcount');
assert.equal(v.recovery_after, tip + 26000, 'recovery height is YOUR node\'s tip + the offset');
pass(`standard vault compiled on the device, no server: ${v.address}; recovery at height ${v.recovery_after} (tip ${tip} + 26000)`);

// 2. Core is already watching it, and derives the same script.
const wname = core.walletNameFor(String(v.descriptor));
assert.ok(cli(null, 'listwallets').includes(wname));
const desc = cli(null, 'getdescriptorinfo', String(v.descriptor).split('#')[0]).descriptor;
const coreAddr = cli(null, 'deriveaddresses', desc)[0];
const winfo = cli(wname, 'getwalletinfo');
assert.equal(winfo.private_keys_enabled, false, 'Core holds no keys');
pass(`Core watches it in its own watch-only wallet ${wname} (no private keys); Core's address ${coreAddr}`);

// 3. Fund it; the balance comes from Core.
cli('miner', '-named', 'sendtoaddress', `address=${coreAddr}`, 'amount=0.5', 'fee_rate=2');
let bal = await must(`/balance?address=${v.address}`);
assert.deepEqual([bal.confirmed_sats, bal.unconfirmed_sats], [0, 50_000_000]);
mine(1);
bal = await must(`/balance?address=${v.address}`);
assert.deepEqual([bal.confirmed_sats, bal.unconfirmed_sats], [50_000_000, 0]);
const ux = await must(`/utxos?vault_id=${v.id}`);
assert.equal(ux.utxos.length, 1);
assert.equal(ux.utxos[0].confirmations, 1);
pass('funding shows unconfirmed, then 50,000,000 sats confirmed, from Core alone');

// 4. No fee estimate on a fresh chain: refused, never a made-up rate.
const dest = cli('miner', 'getnewaddress', '', 'bech32m');
// The vault is a signet vault; the private chain prints regtest addresses.
// The script is what matters: hand the compiler the same script as a signet address.
const destSpk = cli(null, 'validateaddress', dest).scriptPubKey;
const btc = await import('@scure/btc-signer');
const destSignet = btc.Address(btc.TEST_NETWORK).encode(btc.OutScript.decode(Uint8Array.from(Buffer.from(destSpk, 'hex'))));
const noRate = await call('/psbt-binary', 'POST', { vault_id: v.id, destination: destSignet, amount_sats: 10_000_000 });
assert.equal(noRate.status, 400);
assert.match(String(noRate.payload.error), /no fee estimate/);
pass(`no fee estimate yet: refused and asked ("${noRate.payload.error}")`);

// 5. The spend, built on the device, signed by two founders, finalized on the device, sent through Core.
const built = await must('/psbt-binary', 'POST', { vault_id: v.id, destination: destSignet, amount_sats: 10_000_000, fee_rate: 2 });
assert.equal(built.summary.amount_sats ?? built.summary.amount, 10_000_000);
const prop = (await must('/proposals', 'POST', { vault_id: v.id, path: 'founders_now', destination: destSignet, amount_sats: 10_000_000, fee_sats: built.summary.fee_sats, psbt_hex: built.psbt_hex })).proposal;
const signed = [];
for (const i of [0, 1]) signed.push((await signPsbtWithMnemonic(built.psbt_hex, MNEMONIC, key(i).derivation_path, 'testnet')).psbt_hex);
const fin = await must('/psbt-finalize', 'POST', { psbt_hex: mergePsbts(signed) });
// The send button's exact request (VaultDetail.tsx / ProposalDetail.tsx).
const res = await fetch(broadcastTxUrl('signet'), { method: 'POST', body: fin.raw_tx_hex, headers: { 'Content-Type': 'text/plain' } });
const txid = (await res.text()).trim();
assert.ok(res.ok && txid.length === 64, `broadcast refused: ${txid}`);
assert.equal(txid, fin.txid);
await must(`/proposals?id=${prop.id}`, 'PATCH', { status: 'broadcast', txid });
assert.equal(await chain.txConfirmations('signet', txid), 0, 'in the mempool: 0 confirmations');
// Sending the same transaction again: Core's own answer, not a silent success.
const again = await fetch(broadcastTxUrl('signet'), { method: 'POST', body: fin.raw_tx_hex });
assert.equal(again.ok, true, 'Core accepts a re-send of a transaction already in its mempool');
const bad = await fetch(broadcastTxUrl('signet'), { method: 'POST', body: fin.raw_tx_hex.slice(0, 40) });
assert.equal(bad.ok, false);
mine(1);
assert.equal(await chain.txConfirmations('signet', txid), 1, 'one block later: 1 confirmation');
const paid = cli(null, 'getrawtransaction', txid, true, cli(wname, 'gettransaction', txid).blockhash).vout.find(o => o.scriptPubKey.hex === destSpk);
assert.equal(Math.round(paid.value * 1e8), 10_000_000);
bal = await must(`/balance?address=${v.address}`);
assert.equal(bal.confirmed_sats, 50_000_000 - 10_000_000 - built.summary.fee_sats, 'change came back to the vault');
pass(`spend of 10,000,000 sats built and finalized on the device, signed by two founders, accepted and mined by Core (txid ${txid.slice(0, 16)}...); vault holds ${bal.confirmed_sats} sats`);

// 5b. The chain screens' other questions, from Core: the countdown tip,
// the two-source tip check (both from your node), and a refusal -- never a
// trip to the internet -- for anything else an explorer would be asked.
const coreTip = cli(null, 'getblockcount');
// The countdown tip is cached 60 s by design (lib/chain.ts), so it may be
// the height read a block ago; the irreversible-timelock check is uncached
// and must be the live one.
const countdownTip = await chain.tipHeight('signet');
assert.ok(coreTip - countdownTip >= 0 && coreTip - countdownTip <= 1, `countdown tip ${countdownTip} vs node ${coreTip}`);
assert.equal(await chain.verifiedTipHeight('signet'), coreTip);
const other = await fetch(`${EXPLORER.signet.api}/address/${destSignet}/txs`);
assert.equal(other.status, 404);
assert.match(await other.text(), /asks only your own node/);
assert.equal(leaked.length, 0, `requests left the computer: ${leaked.join(', ')}`);
pass(`chain screens answered by Core: tip ${coreTip} (countdowns and the two-source check), confirmations 0 then 1, the send button's broadcast; an unsupported explorer question refused; 0 requests left the computer`);

// 6. The record and the activity list stayed on this computer.
const props = (await must(`/proposals?vault_id=${v.id}`)).proposals;
assert.equal(props[0].status, 'broadcast');
const events = (await must(`/vault-events?vault_id=${v.id}`)).events.map(e => e.event_type);
for (const e of ['draft_created', 'draft_compiled', 'psbt_generated', 'broadcast']) assert.ok(events.includes(e), e);
pass(`the spend's record and the activity list (${events.length} events) kept on this computer`);

const used = [...new Set(calls)].sort();
console.log(`\n${n} checks passed. Core calls used: ${used.join(', ')}`);
process.exit(0);
