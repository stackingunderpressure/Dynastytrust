/**
 * test-purse-pay.mjs -- the family purse, slice 3: the treasurer pays over
 * Nostr Wallet Connect and the receipt is checked
 * (apps/web/src/lib/nwc.ts, netlify/functions/vault-purse-pay.js).
 *
 * The wallet is a fake that answers over a fake relay, in both encryptions
 * NIP-47 allows. No network, no real wallet: what this proves is that the
 * app builds a correct request, reads the answer, and only calls it paid
 * when the receipt matches. A real wallet has not been used.
 *
 * Run: node --experimental-strip-types --experimental-test-module-mocks
 *        --import ./scripts/register-ts-resolver.mjs scripts/test-purse-pay.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const nwc = await import('../apps/web/src/lib/nwc.ts');
const purse = await import('../apps/web/src/lib/purse.ts');
const attest = await import('../apps/web/src/lib/attest.ts');
const server = await import(F('_purse.js'));
const { schnorr } = await import('@noble/curves/secp256k1');
const { buildEvent } = await import('@dynastytrust/nostr-transport');
const nip44 = await import('@dynastytrust/nip44');
const hex = (b) => Buffer.from(b).toString('hex');

// 1. The connection string.
const walletSk = hex(randomBytes(32)); const walletPk = hex(schnorr.getPublicKey(walletSk));
const clientSk = hex(randomBytes(32));
const URI = `nostr+walletconnect://${walletPk}?relay=wss%3A%2F%2Frelay.example.com&secret=${clientSk}`;
const parsed = nwc.parseNwcUri(URI);
assert.equal(parsed.ok, true);
assert.deepEqual(parsed.conn.relays, ['wss://relay.example.com']);
assert.equal(parsed.conn.clientPubkey, hex(schnorr.getPublicKey(clientSk)));
assert.match(nwc.parseNwcUri('lnbc1...').error, /not a wallet connection/);
assert.match(nwc.parseNwcUri(`nostr+walletconnect://${walletPk}?relay=ws%3A%2F%2Fplain.example&secret=${clientSk}`).error, /secure relay/);
assert.match(nwc.parseNwcUri(`nostr+walletconnect://${walletPk}?relay=wss%3A%2F%2Fr.example&secret=xyz`).error, /no valid secret/);
pass('reads a connection string; refuses a non-connection, an insecure relay, a missing secret');

// 2. NIP-04 both ways.
const ct = nwc.nip04Encrypt('hello purse', walletPk, clientSk);
assert.match(ct, /\?iv=/);
assert.equal(nwc.nip04Decrypt(ct, hex(schnorr.getPublicKey(clientSk)), walletSk), 'hello purse');
pass('NIP-04 encryption opens with the other side\'s key');

// 3. A fake wallet on a fake relay.
const preimage = hex(randomBytes(32));
const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
function fakeRelay({ nip44: speaks44 = true, advertise = true, answer }) {
  const subs = [];
  const seen = { request: null, decrypted: null };
  const emit = (e) => { for (const s of subs) if (s.f.kinds.includes(e.kind)) s.on(e); };
  const sign = (d) => hex(schnorr.sign(d, walletSk));
  return {
    seen,
    subscribe(f, on) {
      const s = { f, on }; subs.push(s);
      if (f.kinds.includes(nwc.NWC_INFO_KIND) && advertise) {
        void buildEvent({ pubkey: walletPk, sign, kind: nwc.NWC_INFO_KIND, content: 'pay_invoice get_balance', tags: speaks44 ? [['encryption', 'nip44_v2 nip04']] : [] }).then(emit);
      }
      return { close() { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); } };
    },
    async publish(e) {
      seen.request = e;
      const is44 = e.tags.some((t) => t[0] === 'encryption' && t[1] === 'nip44_v2');
      seen.decrypted = JSON.parse(is44 ? nip44.decryptFrom(e.content, e.pubkey, walletSk) : nwc.nip04Decrypt(e.content, e.pubkey, walletSk));
      const reply = answer(seen.decrypted);
      if (!reply) return;
      const body = JSON.stringify(reply);
      const content = is44 ? nip44.encryptTo(body, e.pubkey, walletSk) : nwc.nip04Encrypt(body, e.pubkey, walletSk);
      emit(await buildEvent({ pubkey: walletPk, sign, kind: nwc.NWC_RESPONSE_KIND, content, tags: [['p', e.pubkey], ['e', e.id]] }));
    },
    close() {},
  };
}
const INV = 'lnbc334u1fake';
const paid = (d) => ({ result_type: 'pay_invoice', result: { preimage, fees_paid: 7000 }, _for: d });

let relay = fakeRelay({ answer: paid });
let out = await nwc.payInvoice({ conn: parsed.conn, invoice: INV, paymentHash, transport: relay, infoTimeoutMs: 200 });
assert.deepEqual(out, { kind: 'paid', preimage, fee_sats: 7 });
assert.deepEqual(relay.seen.decrypted, { method: 'pay_invoice', params: { invoice: INV } });
assert.ok(relay.seen.request.tags.some((t) => t[0] === 'p' && t[1] === walletPk));
const exp = Number(relay.seen.request.tags.find((t) => t[0] === 'expiration')[1]);
assert.ok(exp > Date.now() / 1000 && exp <= Date.now() / 1000 + 61);
pass('pays over nip44_v2 when the wallet offers it: right method, right invoice, addressed to the wallet, expires in a minute; fee read in sats');

relay = fakeRelay({ nip44: false, answer: paid });
out = await nwc.payInvoice({ conn: parsed.conn, invoice: INV, paymentHash, transport: relay, infoTimeoutMs: 200 });
assert.equal(out.kind, 'paid'); assert.match(relay.seen.request.content, /\?iv=/);
relay = fakeRelay({ advertise: false, answer: paid });
out = await nwc.payInvoice({ conn: parsed.conn, invoice: INV, paymentHash, transport: relay, infoTimeoutMs: 100 });
assert.equal(out.kind, 'paid'); assert.match(relay.seen.request.content, /\?iv=/);
pass('falls back to NIP-04 when the wallet does not offer nip44, or advertises nothing (as NIP-47 says)');

relay = fakeRelay({ answer: () => ({ result_type: 'pay_invoice', error: { code: 'QUOTA_EXCEEDED', message: 'budget' } }) });
out = await nwc.payInvoice({ conn: parsed.conn, invoice: INV, paymentHash, transport: relay, infoTimeoutMs: 200 });
assert.equal(out.kind, 'failed'); assert.match(out.message, /backstop working/);
relay = fakeRelay({ answer: () => ({ result_type: 'pay_invoice', error: { code: 'INTERNAL', message: 'oops' } }) });
out = await nwc.payInvoice({ conn: parsed.conn, invoice: INV, paymentHash, transport: relay, infoTimeoutMs: 200 });
assert.equal(out.kind, 'unknown');
pass("a definite no (the wallet's own budget) is 'failed'; an unclear error is 'unknown', never 'failed'");

relay = fakeRelay({ answer: () => ({ result_type: 'pay_invoice', result: { preimage: hex(randomBytes(32)) } }) });
out = await nwc.payInvoice({ conn: parsed.conn, invoice: INV, paymentHash, transport: relay, infoTimeoutMs: 200 });
assert.equal(out.kind, 'unknown'); assert.match(out.message, /does not match/);
relay = fakeRelay({ answer: () => null });
out = await nwc.payInvoice({ conn: parsed.conn, invoice: INV, paymentHash, transport: relay, infoTimeoutMs: 100, replyTimeoutMs: 200 });
assert.equal(out.kind, 'unknown'); assert.match(out.message, /cannot pay twice/);
pass("a receipt that does not match, or no answer, is 'unknown' -- never counted as paid");

// 4. The server side.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PATHS = ["m/48'/1'/0'/2'", "m/48'/1'/1'/2'", "m/48'/1'/2'/2'", "m/48'/1'/3'/2'"];
const sign = (i, target) => attest.signAttestation({ mnemonic: MNEMONIC, derivationPath: PATHS[i], network: 'testnet', attestationType: 'purse_payout_yes', targetHash: target });
const keyOf = (i) => sign(i, '00'.repeat(32)).pubkey;
let db;
const REQ = { id: 'r1', vault_id: 'v1', requested_by: 'u3', amount_sats: 33400, road: 'lightning', invoice_sha256: 'cd'.repeat(32), payment_hash: paymentHash, status: 'approved' };
const reset = () => {
  db = {
    vaults: [{ id: 'v1', user_id: 'u0' }],
    vault_members: [0, 1, 2, 3].map((i) => ({ id: `m${i}`, vault_id: 'v1', user_id: `u${i}`, role: i === 0 ? 'owner' : 'founder', status: 'active', pubkey: '02' + keyOf(i) })),
    vault_purse: [{ vault_id: 'v1', settings: { ...server.PURSE_DEFAULTS, approvals_needed: 2, treasurer_member_id: 'm0', monthly_cap_sats: 100000 } }],
    vault_requests: [{ ...REQ }],
    purse_yeses: [],
    purse_payments: [],
    events: [],
  };
  const t = server.payoutTargetHash(REQ);
  for (const i of [0, 1]) { const s = sign(i, t); db.purse_yeses.push({ request_id: 'r1', member_id: `m${i}`, pubkey: s.pubkey, sig: s.signature, target_hash: t }); }
};
const q = (table) => {
  const f = {}; let op = 'select'; let payload;
  const rows = () => db[table].filter((row) => Object.entries(f).every(([k, v]) => row[k] === v));
  const o = {
    select: () => o, order: () => o, limit: () => o,
    eq: (k, v) => { f[k] = v; return o; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (row) => {
      if (table === 'purse_payments' && db.purse_payments.some((p) => p.request_id === row.request_id)) return { error: { message: 'duplicate key' } };
      db[table].push({ ...row }); return { error: null };
    },
    update: (p) => { op = 'update'; payload = p; return o; },
    then: (res) => { if (op === 'update') { rows().forEach((r) => Object.assign(r, payload)); return res({ error: null }); } return res({ data: rows(), error: null }); },
  };
  return o;
};
let user = null;
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from: q, rpc: async () => ({ data: 1, error: null }) }) } });
const realAuth = await import(F('_auth.js'));
mock.module(F('_auth.js'), { namedExports: { ...realAuth, requireUser: async () => (user ? { userId: user } : { error: 'no' }), json: (statusCode, body) => ({ statusCode, headers: {}, body }) } });
const realLedger = await import(F('_ledger.js'));
mock.module(F('_ledger.js'), { namedExports: { ...realLedger, recordEvent: async (_s, e) => { db.events.push(e); } } });
const payFn = (await import(F('vault-purse-pay.js'))).handler;
const reqFn = (await import(F('vault-requests.js'))).handler;
const call = (body) => payFn({ httpMethod: 'POST', headers: {}, queryStringParameters: {}, body: JSON.stringify(body) });
const start = () => call({ action: 'start', request_id: 'r1' });

reset(); user = 'u1';
let res = await start();
assert.equal(res.statusCode, 403); assert.match(res.body.error, /Only the purse's treasurer/);
pass('only the treasurer can pay');
user = 'u0';
db.vault_requests[0].status = 'pending'; res = await start();
assert.equal(res.statusCode, 409);
db.vault_requests[0].status = 'approved';
db.vault_members[1].status = 'removed'; res = await start();
assert.equal(res.statusCode, 409); assert.match(res.body.error, /Only 1 of the 2 yeses needed still count/);
db.vault_members[1].status = 'active';
db.vault_purse[0].settings.voters = ['m0', 'm2']; res = await start();
assert.equal(res.statusCode, 409);
db.vault_purse[0].settings.voters = [];
pass("a request that is not approved, or whose yeses no longer count under today's members or voters, is not paid");
db.purse_payments.push({ request_id: 'other', vault_id: 'v1', amount_sats: 70000, status: 'paid', started_at: new Date().toISOString() });
res = await start();
assert.equal(res.statusCode, 409); assert.match(res.body.error, /monthly cap: 30000 sats are left/);
db.purse_payments[0].started_at = '2000-01-01T00:00:00.000Z';
pass('the monthly cap counts what was paid this month, and last month does not count');

res = await start();
assert.equal(res.statusCode, 200); assert.equal(res.body.resumed, false); assert.equal(res.body.month_left_sats, 100000 - 33400);
res = await start();
assert.equal(res.statusCode, 200); assert.equal(res.body.resumed, true);
pass('starting holds the amount against the cap; starting again after an unknown outcome is allowed');

user = 'u3';
res = await reqFn({ httpMethod: 'PATCH', headers: {}, queryStringParameters: { id: 'r1' }, body: JSON.stringify({ status: 'cancelled' }) });
assert.equal(res.statusCode, 409); assert.match(res.body.error, /already started paying/);
user = 'u0';
res = await reqFn({ httpMethod: 'PATCH', headers: {}, queryStringParameters: { id: 'r1' }, body: JSON.stringify({ status: 'fulfilled' }) });
assert.equal(res.statusCode, 403); assert.match(res.body.error, /only by its receipt/);
pass('a payout being paid cannot be cancelled, and nobody marks it paid by hand');

res = await call({ action: 'paid', request_id: 'r1', preimage: hex(randomBytes(32)), fee_sats: 7 });
assert.equal(res.statusCode, 403); assert.match(res.body.error, /not for this invoice/);
assert.equal(db.vault_requests[0].status, 'approved');
res = await call({ action: 'paid', request_id: 'r1', preimage: preimage.toUpperCase(), fee_sats: 7 });
assert.equal(res.statusCode, 200);
assert.equal(db.vault_requests[0].status, 'fulfilled');
assert.deepEqual([db.purse_payments[1].status, db.purse_payments[1].preimage, db.purse_payments[1].fee_sats], ['paid', preimage, 7]);
const ev = db.events.at(-1);
assert.equal(ev.event_type, 'purse_payout_paid'); assert.equal(ev.metadata.preimage, preimage);
const { MILESTONE_EVENTS } = await import(F('_anchor.js'));
assert.ok(MILESTONE_EVENTS.has('purse_payout_paid'));
pass('a wrong receipt is refused; the right one fulfils the request and is a milestone stamped into Bitcoin');
res = await start();
assert.equal(res.statusCode, 409);
pass('a paid payout cannot be started again');

reset(); user = 'u0';
await start();
res = await call({ action: 'failed', request_id: 'r1', reason: 'over budget' });
assert.equal(res.statusCode, 200);
assert.equal(db.purse_payments[0].status, 'failed'); assert.equal(db.vault_requests[0].status, 'approved');
const get = await payFn({ httpMethod: 'GET', headers: {}, queryStringParameters: { vault_id: 'v1' } });
assert.equal(get.body.month_left_sats, 100000);
res = await start();
assert.equal(res.statusCode, 200); assert.equal(db.purse_payments[0].status, 'started');
pass('a definite no frees the cap and leaves the payout approved, so the treasurer can try again');

console.log(`\ntest-purse-pay: ${n} checks passed`);
