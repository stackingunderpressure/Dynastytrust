/**
 * test-purse-yes.mjs -- the family purse, slice 2: payout requests pick a
 * road, and a Lightning payout is approved only by the family's signed
 * yeses (netlify/functions/vault-purse-yes.js, vault-requests.js,
 * apps/web/src/lib/purse.ts).
 *
 * Run: node --experimental-strip-types --experimental-test-module-mocks
 *        --import ./scripts/register-ts-resolver.mjs scripts/test-purse-yes.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { bech32 } from '@scure/base';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const server = await import(F('_purse.js'));
const purse = await import('../apps/web/src/lib/purse.ts');
const attest = await import('../apps/web/src/lib/attest.ts');

// 1. The browser and the server sign and check the same bytes.
const P = { vault_id: 'v1', request_id: 'r1', amount_sats: 33400, road: 'lightning', invoice_sha256: 'ab'.repeat(32) };
assert.equal(purse.payoutTargetText(P), server.payoutTargetText(P));
assert.equal(purse.payoutTargetHash(P), createHash('sha256').update(server.payoutTargetText(P)).digest('hex'));
assert.equal(purse.YES_TYPE, server.YES_TYPE);
pass('browser and server build the identical yes target');

// 2. Reading an invoice before anyone signs.
const V = 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh';
const r = purse.readInvoice('lightning:' + V.toUpperCase(), 'bitcoin');
assert.equal(r.ok, true); assert.equal(r.amount_sats, 250000); assert.equal(r.sha256, createHash('sha256').update(V).digest('hex'));
pass('reads the BOLT11 spec vector: 2500u is 250,000 sats, and fingerprints the lowercase text');
assert.match(purse.readInvoice(V, 'testnet').error, /for bitcoin, but this vault is on testnet/);
assert.match(purse.readInvoice(V.slice(0, 40) + (V[40] === 'q' ? 'p' : 'q') + V.slice(41), 'bitcoin').error, /did not copy whole/);
assert.match(purse.readInvoice('bc1qsomething', 'bitcoin').error, /not a Lightning invoice/);
const mk = (hrp) => bech32.encode(hrp, bech32.toWords(new Uint8Array(40)), false);
assert.match(purse.readInvoice(mk('lnbc'), 'bitcoin').error, /no amount/);
assert.equal(purse.readInvoice(mk('lnbc1500n'), 'bitcoin').amount_sats, 150);
assert.equal(purse.readInvoice(mk('lntbs10u'), 'signet').amount_sats, 1000);
assert.equal(purse.readInvoice(mk('lntb10u'), 'testnet').amount_sats, 1000);
assert.match(purse.readInvoice(mk('lnbc10p'), 'bitcoin').error, /part of a sat/);
assert.match(purse.readInvoice(mk('lnbc15p'), 'bitcoin').error, /Could not read the amount/);
pass('refuses the wrong network, a broken copy, a non-invoice, no amount, and part-sats; lntbs is signet, not testnet');

// 3. The functions, against an in-memory database.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PATHS = ["m/48'/1'/0'/2'", "m/48'/1'/1'/2'", "m/48'/1'/2'/2'", "m/48'/1'/3'/2'"];
const keyOf = (i) => attest.signAttestation({ mnemonic: MNEMONIC, derivationPath: PATHS[i], network: 'testnet', attestationType: 'purse_payout_yes', targetHash: '00'.repeat(32) }).pubkey;
const sign = (i, target) => attest.signAttestation({ mnemonic: MNEMONIC, derivationPath: PATHS[i], network: 'testnet', attestationType: 'purse_payout_yes', targetHash: target });

let db;
const reset = () => {
  db = {
    vaults: [{ id: 'v1', user_id: 'u0' }],
    vault_members: [0, 1, 2, 3].map((i) => ({ id: `m${i}`, vault_id: 'v1', user_id: `u${i}`, role: i === 0 ? 'owner' : 'founder', status: 'active', pubkey: '02' + keyOf(i) })),
    vault_purse: [{ vault_id: 'v1', settings: { ...server.PURSE_DEFAULTS, approvals_needed: 2, per_payout_limit_sats: 100000 } }],
    vault_requests: [],
    purse_yeses: [],
    events: [],
  };
};
let seq = 0;
const q = (table) => {
  const f = {};
  let op = 'select'; let payload;
  const rows = () => db[table].filter((row) => Object.entries(f).every(([k, v]) => row[k] === v));
  const run = () => {
    if (op === 'update') { const m = rows(); m.forEach((row) => Object.assign(row, payload)); return { data: m, error: null }; }
    return { data: rows(), error: null };
  };
  const o = {
    select: () => o, order: () => o, limit: () => o,
    eq: (k, v) => { f[k] = v; return o; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: payload, error: null }),
    insert: (row) => {
      if (table === 'purse_yeses' && db.purse_yeses.some((y) => y.request_id === row.request_id && y.member_id === row.member_id)) {
        const err = { data: null, error: { message: 'duplicate key value violates unique constraint' } };
        return { ...err, then: (res) => res(err) };
      }
      payload = { id: `${table}-${++seq}`, created_at: new Date().toISOString(), ...row };
      db[table].push(payload);
      return { select: () => ({ single: async () => ({ data: payload, error: null }) }), then: (res) => res({ error: null }) };
    },
    update: (p) => { op = 'update'; payload = p; return o; },
    then: (res) => res(run()),
  };
  return o;
};
const supabase = { from: q, rpc: async () => ({ data: 1, error: null }) };
let user = null;
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => supabase } });
const realAuth = await import(F('_auth.js'));
mock.module(F('_auth.js'), { namedExports: { ...realAuth, requireUser: async () => (user ? { userId: user } : { error: 'Not signed in' }), json: (statusCode, body) => ({ statusCode, headers: {}, body }) } });
const realLedger = await import(F('_ledger.js'));
mock.module(F('_ledger.js'), { namedExports: { ...realLedger, recordEvent: async (_s, e) => { db.events.push(e); } } });
const yesFn = (await import(F('vault-purse-yes.js'))).handler;
const reqFn = (await import(F('vault-requests.js'))).handler;
const post = (h, body) => h({ httpMethod: 'POST', headers: {}, queryStringParameters: {}, body: JSON.stringify(body) });

reset();
user = 'u3';
const SHA = 'cd'.repeat(32);
let res = await post(reqFn, { vault_id: 'v1', amount_sats: 200000, road: 'lightning', invoice: 'sealed', invoice_sha256: SHA });
assert.equal(res.statusCode, 400); assert.match(res.body.error, /at most 100000/);
res = await post(reqFn, { vault_id: 'v1', amount_sats: 33400, road: 'lightning', invoice: 'sealed' });
assert.equal(res.statusCode, 400); assert.match(res.body.error, /fingerprint/);
res = await post(reqFn, { vault_id: 'v1', amount_sats: 33400, road: 'sideways' });
assert.equal(res.statusCode, 400);
pass('a Lightning request over the per-payout limit, without its fingerprint, or on an unknown road is refused');
res = await post(reqFn, { vault_id: 'v1', amount_sats: 33400, road: 'lightning', invoice: 'sealed-invoice', invoice_sha256: SHA.toUpperCase() });
assert.equal(res.statusCode, 201);
const reqRow = db.vault_requests[0];
assert.equal(reqRow.road, 'lightning'); assert.equal(reqRow.invoice_sha256, SHA); assert.equal(reqRow.invoice, 'sealed-invoice');
const days = (new Date(reqRow.expires_at).getTime() - Date.now()) / 86400000;
assert.ok(days > 13.9 && days <= 14);
pass('a good Lightning request keeps its sealed invoice, lowercases the fingerprint, and lapses in the purse\'s 14 days');

user = 'u0';
res = await reqFn({ httpMethod: 'PATCH', headers: {}, queryStringParameters: { id: reqRow.id }, body: JSON.stringify({ status: 'approved' }) });
assert.equal(res.statusCode, 403); assert.match(res.body.error, /only by the family's signed yeses/);
assert.equal(reqRow.status, 'pending');
pass('the vault owner cannot mark a Lightning payout approved by hand');

const target = purse.payoutTargetHash({ vault_id: 'v1', request_id: reqRow.id, amount_sats: 33400, road: 'lightning', invoice_sha256: SHA });
const yes = (i, t = target) => { const s = sign(i, t); return post(yesFn, { request_id: reqRow.id, signature: s.signature, pubkey: s.pubkey }); };

user = 'u3'; res = await yes(3);
assert.equal(res.statusCode, 403); assert.match(res.body.error, /your own payout/);
pass('the person being paid cannot say yes to their own payout');
user = 'u1'; res = await yes(2);
assert.equal(res.statusCode, 403); assert.match(res.body.error, /not your vault key/);
pass('a yes signed with somebody else\'s key is refused');
const wrong = purse.payoutTargetHash({ vault_id: 'v1', request_id: reqRow.id, amount_sats: 334000, road: 'lightning', invoice_sha256: SHA });
res = await yes(1, wrong);
assert.equal(res.statusCode, 403); assert.match(res.body.error, /not signed for this exact payout/);
pass('a yes signed for a different amount does not count');
db.vault_purse[0].settings.voters = ['m0', 'm2'];
res = await yes(1);
assert.equal(res.statusCode, 403); assert.match(res.body.error, /not one of the purse's voters/);
db.vault_purse[0].settings.voters = [];
pass('a member outside the purse\'s voters cannot say yes');

res = await yes(1);
assert.equal(res.statusCode, 200); assert.deepEqual([res.body.yeses, res.body.needed, res.body.status], [1, 2, 'pending']);
const y = db.purse_yeses[0];
assert.equal(attest.verifyAttestation({ attestationType: 'purse_payout_yes', targetHash: y.target_hash, signature: y.sig, pubkey: y.pubkey }), true);
res = await yes(1);
assert.equal(res.statusCode, 409); assert.match(res.body.error, /already said yes/);
pass('a good yes counts once, is stored with a signature anyone can re-check, and a second yes from the same member is refused');

user = 'u0'; res = await yes(0);
assert.equal(res.statusCode, 200); assert.equal(res.body.status, 'approved');
assert.equal(reqRow.status, 'approved');
assert.deepEqual(db.events.map((e) => e.event_type), ['request_created', 'purse_yes', 'purse_yes', 'purse_payout_approved']);
pass('the second yes reaches the number: the request is approved and the approval is a ledger milestone');
user = 'u2'; res = await yes(2);
assert.equal(res.statusCode, 409);
pass('no more yeses once it is approved');

reqRow.status = 'pending'; reqRow.expires_at = new Date(Date.now() - 1000).toISOString();
res = await yes(2);
assert.equal(res.statusCode, 409); assert.match(res.body.error, /lapsed/);
pass('a lapsed request takes no yes');

const { MILESTONE_EVENTS } = await import(F('_anchor.js'));
assert.ok(MILESTONE_EVENTS.has('purse_payout_approved'));
pass('purse_payout_approved is stamped into Bitcoin like the other milestones');

console.log(`\ntest-purse-yes: ${n} checks passed`);
