// psbt-merge may only set a proposal's status from the proposal's OWN
// transaction, judged with the proposal's own coins (blind review
// 2026-11-25, finding 6: docs/audits/2026-11-25-blind-review-new-code.md).
// It took the signatures, leaves and coin amounts all from what a member
// submitted, so a PSBT for a different transaction, signed with throwaway
// keys, could mark the proposal "signed".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as btc from '@scure/btc-signer';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const { callWasm } = await import(F('_ranged-wasm.js'));
const { buildRangedSpend } = await import(F('_ranged-spend.js'));
const { watchedAddresses } = await import(F('_vault-coins.js'));
const { mergeMatchesProposal } = await import(F('_psbt-verify.js'));

const shape = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(s => s.name === 'untouched');
const compiled = callWasm('/compile-leaves', { network: 'signet', leaves: shape.policy.leaves }).body;
const V = { id: '66666666-6666-6666-6666-666666666666', name: 'Test', status: 'compiled', network: 'signet', address: compiled.address, leaf_scripts: compiled.leaf_scripts,
  leaves: shape.policy.leaves.map(l => ({ id: l.id, unlock: l.unlock })), descriptor_version: 2,
  descriptor_multipath: shape.multipath_descriptor, descriptor_receive: shape.receive_descriptor, descriptor_change: shape.change_descriptor };
const w0 = watchedAddresses(V, { 0: 5, 1: 3 }).find(w => w.branch === 0 && w.index === 0);
const TIP = 300_000;
const dest = callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch: 0, index: 40 }).body.address;
const supabase = { from: () => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, then: (res) => res({ data: [], error: null }), insert: async () => ({ error: null }) }; return o; }, rpc: async () => ({ data: 4, error: null }) };
const spend = async (amount, txid = '1') => (await buildRangedSpend({ supabase, vault: V, userId: 'u', body: { destination: dest, amount_sats: amount, path: 'everyday', fee_rate: 2 } },
  { coinsAt: async () => [{ txid: txid.padStart(64, '0'), vout: 0, value: 80_000, status: { confirmed: true, block_height: TIP - 10 }, address: w0.address, branch: 0, index: 0 }],
    fetchTipHeight: async () => TIP, getFeeRate: async () => 2, vaultUsed: async () => new Set() })).body.psbt_hex;

const base = await spend(30_000);
assert.equal(mergeMatchesProposal(base, base), null);
pass("the proposal's own transaction is accepted");
const other = await spend(31_000);
assert.match(String(mergeMatchesProposal(other, base)), /different transaction/);
pass('a merge of a different transaction is refused');
const hex2u8 = (h) => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const u82hex = (b) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const t = btc.Transaction.fromPSBT(hex2u8(base));
const wu = t.getInput(0).witnessUtxo;
t.updateInput(0, { witnessUtxo: { script: wu.script, amount: wu.amount + 1000n } }, true);
assert.match(String(mergeMatchesProposal(u82hex(t.toPSBT()), base)), /coin/);
pass('the same transaction with a different coin amount (witnessUtxo) is refused');

const src = readFileSync(new URL('../netlify/functions/psbt-merge.js', import.meta.url), 'utf8');
assert.match(src, /mergeMatchesProposal\(/, 'psbt-merge does not check the merge against the proposal');
pass('psbt-merge checks the merge against the stored proposal before writing a status');
console.log(`merge-same-tx tests passed (${n} cases)`);
