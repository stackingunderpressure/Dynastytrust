/**
 * test-dust-change.mjs -- a spend whose leftover change is too small to keep
 * (1-545 sats) must still be signable (found 2026-11-13 by reading the code;
 * this reproduces it before fixing it).
 *
 * The REAL psbt-binary.js handler runs; only the database, the account check,
 * the activity log and mempool.space are stood in. Its compiler call is
 * answered by the browser compiler module (the same Rust code as the Fly
 * server, sovereign slice 1), so the PSBT is real. Then the phone's own
 * pre-signing check (verifyPsbtMatchesRequest) runs on it exactly as the
 * Send page calls it.
 *
 * Run:  node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/register-ts-resolver.mjs scripts/test-dust-change.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
process.env.COMPILER_URL = 'https://compiler.invalid';
process.env.COMPILER_SECRET = 'test';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const L = (f) => new URL(`../apps/web/src/lib/${f}`, import.meta.url).href;

const bc = await import(L('browser-compiler.ts'));
bc.useCompilerWasmBytes(new Uint8Array(readFileSync(new URL('../apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm', import.meta.url))));
const { verifyPsbtMatchesRequest } = await import(L('psbt-signer.ts'));
const btc = await import('@scure/btc-signer');
const { secp256k1 } = await import('@noble/curves/secp256k1');
const hex = (b) => Buffer.from(b).toString('hex');

// A real 2-of-2 vault, compiled by the real compiler code.
const pub = (n) => hex(secp256k1.getPublicKey(new Uint8Array(32).fill(n), true));
const founders = [pub(1), pub(2)], heir = [pub(3)];
const compiled = JSON.parse((await bc.compileOnDevice('/compile', {
  network: 'testnet', founder_keys: founders, founder_quorum: 2, heir_keys: heir, heir_quorum: 1,
  recovery_after: 0, inheritance_after: 3_000_000, address_type: 'tr_multileaf',
})).body);
assert.ok(compiled.ok, JSON.stringify(compiled));
const spk = hex(btc.OutScript.encode(btc.Address(btc.TEST_NETWORK).decode(compiled.address)));
const vault = {
  id: 'v1', name: 'Test', address: compiled.address, network: 'testnet', descriptor: compiled.descriptor,
  address_type: 'tr_multileaf', recovery_after: 0, inheritance_after: 3_000_000, founder_quorum: 2, heir_quorum: 1,
  founder_keys: founders, heir_keys: heir, consent_keys: [], backup_keys: [], second_heir_keys: [], key_origins: [], leaves: null,
};

// Stand-ins: database, account, activity log.
const q = (data) => { const o = { select: () => o, eq: () => o, maybeSingle: async () => ({ data, error: null }) }; return o; };
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from: (t) => q(t === 'vaults' ? vault : { id: 'm1' }) }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => ({ userId: 'u1' }), json: (statusCode, body) => ({ statusCode, body }) } });
mock.module(F('_ledger.js'), { namedExports: { recordEvent: async () => {} } });

// Stand-in mempool.space: one confirmed coin of VALUE sats; compiler calls
// go to the real compiler code in-process.
const VALUE = 100_000, TXID = 'aa'.repeat(32);
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (u.startsWith('https://compiler.invalid')) {
    const out = await bc.compileOnDevice(u.slice('https://compiler.invalid'.length), JSON.parse(init.body));
    return new Response(out.body, { status: out.status });
  }
  if (u.endsWith('/utxo')) return ok([{ txid: TXID, vout: 0, value: VALUE, status: { confirmed: true } }]);
  if (u.endsWith(`/tx/${TXID}`)) return ok({ txid: TXID, vout: [{ scriptpubkey: spk, value: VALUE }] });
  throw new Error('unexpected fetch ' + u);
};
const { handler } = await import(F('psbt-binary.js'));
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const build = async (amount) => {
  const r = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1', destination: DEST, amount_sats: amount, fee_rate: 2, path: 'founders_now' }) });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return r.body;
};
// As the Send page checks it (VaultDetail.tsx SendTab).
const phoneCheck = (res) => verifyPsbtMatchesRequest(res.psbt_hex, {
  destination: DEST, amountSats: res.summary.amount_sats, network: 'testnet', ownAddress: vault.address,
  feeSats: res.summary.fee_sats, changeSats: res.summary.change_sats,
});
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// 1. Normal change: signable (today's behaviour, unchanged).
const normal = await build(50_000);
assert.ok(normal.summary.change_sats > 546);
assert.deepEqual(phoneCheck(normal), { ok: true });
pass(`normal change (${normal.summary.change_sats} sats): the phone agrees with the summary`);

// 2. Change of 300 sats -- below the 546 floor, so it joins the fee.
const fee = normal.summary.fee_sats;
const dust = await build(VALUE - fee - 300);
const check = phoneCheck(dust);
assert.deepEqual(check, { ok: true }, `dust change: the phone refuses to sign: ${check.reason}`);
assert.equal(dust.summary.change_sats, 0);
assert.equal(dust.summary.fee_sats, fee + 300, 'the fee shown must be the fee the transaction really pays');
pass(`change of 300 sats goes to the fee, the summary says so (${dust.summary.fee_sats} sats), and the phone agrees`);

// 3. Change exactly 0: no change output, fee as shown.
const exact = await build(VALUE - fee);
assert.equal(exact.summary.change_sats, 0);
assert.equal(exact.summary.fee_sats, fee);
assert.deepEqual(phoneCheck(exact), { ok: true });
pass('change of exactly 0: no change output, the phone agrees');

// 4. A real shortfall is still refused -- never turned into a smaller fee.
const short = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1', destination: DEST, amount_sats: VALUE - fee + 10, fee_rate: 2, path: 'founders_now' }) });
assert.equal(short.statusCode, 400, JSON.stringify(short.body));
assert.match(short.body.error, /Insufficient funds/);
pass('a spend 10 sats short of covering its fee is refused as insufficient funds');

console.log(`dust-change tests passed (${n} cases)`);
