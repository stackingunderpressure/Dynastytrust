// After a spend is sent, the app must never call it a failure because
// mempool.space has not indexed it yet (operator's phone screenshot,
// 2026-11-26: "Could not find transaction 6118ab4f... on signet: mempool.space
// 404" with a "Retry broadcast" button -- while the transaction sat in the
// signet mempool). Three parts:
//  1. the server waits and retries a not-yet-indexed lookup before refusing;
//  2. re-sending a transaction the network already has counts as sent;
//  3. recording the send retries, and a failure says "sent", not "failed".
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const { fetchTxPatiently } = await import('../netlify/functions/_chain.js');
const { sendRawTx, recordBroadcast } = await import('../apps/web/src/lib/broadcast.ts');
const TXID = '6118ab4faef78343766e01560bd73a487940c22164357b2badcc4ba49dd6cb5e';
const noSleep = async () => {};
const resp = (status, body) => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

// 1.
let calls = 0;
const slow = () => { calls++; return calls < 3 ? resp(404, 'Transaction not found') : resp(200, { txid: TXID, vout: [] }); };
assert.equal((await fetchTxPatiently('https://m/signet/api', TXID, { fetchFn: slow, sleep: noSleep })).txid, TXID);
assert.equal(calls, 3);
pass('a transaction not indexed yet is looked up again, and found on the third try');
calls = 0;
await assert.rejects(fetchTxPatiently('https://m/signet/api', TXID, { fetchFn: () => { calls++; return resp(404, 'nope'); }, sleep: noSleep, tries: 4 }), /404/);
assert.equal(calls, 4);
calls = 0;
await assert.rejects(fetchTxPatiently('https://m/signet/api', TXID, { fetchFn: () => { calls++; return resp(500, 'down'); }, sleep: noSleep }), /500/);
assert.equal(calls, 1);
pass('it gives up after its tries, and does not retry errors other than "not found"');

// 2.
assert.equal(await sendRawTx('signet', '02ab', TXID, () => resp(200, TXID)), TXID);
for (const msg of ['sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}', 'txn-already-in-mempool', 'txn-already-known']) {
  assert.equal(await sendRawTx('signet', '02ab', TXID, () => resp(400, msg)), TXID, msg);
}
await assert.rejects(sendRawTx('signet', '02ab', TXID, () => resp(400, 'bad-txns-inputs-missingorspent')), /Broadcast failed/);
await assert.rejects(sendRawTx('signet', '02ab', TXID, () => resp(200, 'f'.repeat(64))), /different transaction/);
pass('sending again a transaction the network already has counts as sent; a real refusal is still a failure');

// 3.
let tries = 0;
await recordBroadcast(async () => { tries++; if (tries < 2) throw new Error('Could not find transaction'); }, { sleep: noSleep });
assert.equal(tries, 2);
tries = 0;
await assert.rejects(recordBroadcast(async () => { tries++; throw new Error('Could not find transaction'); }, { sleep: noSleep, tries: 3 }), /Could not find/);
assert.equal(tries, 3);
pass('recording the send is retried; if it still fails, the error is the recording, not the sending');

const src = (await import('node:fs')).readFileSync(new URL('../apps/web/src/pages/vault-detail/SendTab.tsx', import.meta.url), 'utf8');
assert.match(src, /sendRawTx\(/); assert.match(src, /recordBroadcast\(/); assert.match(src, /Record it in history/);
const pd = (await import('node:fs')).readFileSync(new URL('../apps/web/src/pages/ProposalDetail.tsx', import.meta.url), 'utf8');
assert.match(pd, /sendRawTx\(/); assert.match(pd, /recordBroadcast\(/);
const pr = (await import('node:fs')).readFileSync(new URL('../netlify/functions/proposals.js', import.meta.url), 'utf8');
assert.match(pr, /fetchTxPatiently\(/);
pass('the Send screen, the request page and the server all use these');
console.log(`broadcast-record tests passed (${n} cases)`);
