/**
 * test-vault-duress.mjs -- a wellness checker's duress stops the whole
 * circle (netlify/functions/vault-duress.js, _duress.js, vaults.js;
 * docs/wellness-group-build-note.md slice 2; operator, 2026-11-25:
 * "Straight to the server", "Owner + circle quorum").
 *
 * Run: node --experimental-test-module-mocks scripts/test-vault-duress.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const hex = (b) => Buffer.from(b).toString('hex');

const { noticeDigest, holdState } = await import(F('_duress.js'));
assert.equal(hex(noticeDigest('raise', 'tr(abc,{multi_a(1,x)})', '2026-11-25T12:00:00.000Z')), '28ee8aa77e89b45a5c3f6781bea52c5833e3ab821aaefe3171ca42f90e136b86');
pass("the notice bytes match Tapit's (same fixed value as vaultDuress.test.ts)");

const priv = (i) => Uint8Array.from(Buffer.from(i.toString(16).padStart(64, '0'), 'hex'));
const pub = (i) => hex(schnorr.getPublicKey(priv(i)));
const CHECKERS = [1, 2, 3, 4, 5];
const OWNER = 11;
// The compiled vault: owner must sign + 3 of the 5 checkers; a later owner path.
const DESC = `tr(50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0,{and_v(v:pk(${pub(OWNER)}),multi_a(3,${CHECKERS.map(pub).join(',')})),and_v(v:pk(${pub(OWNER)}),after(30000))})`;
const notice = (kind, i, at = new Date().toISOString()) => ({ kind, descriptor: DESC, signed_at: at, pubkey: pub(i), sig: hex(schnorr.sign(noticeDigest(kind, DESC, at), priv(i))) });

let db;
const reset = () => {
  db = {
    vault: { id: 'v1', user_id: 'owner', status: 'compiled', descriptor: DESC, duress: false, leaves: [{ id: 'wellness', quorum: 3, keys: CHECKERS.map(pub), required_keys: [pub(OWNER)], wellness: { view: 'blind' } }] },
    grants: CHECKERS.map((i) => ({ recipient_pubkey: pub(i), status: 'accepted' })),
    notices: [], events: [], t: 0,
  };
};
const q = (table) => {
  const f = {};
  const o = {
    select: () => o, eq: (k, v) => { f[k] = v; return o; }, neq: () => o, order: () => o, limit: () => o,
    maybeSingle: async () => ({ data: table === 'vaults' && f.id === db.vault.id ? db.vault : null, error: null }),
    update: (row) => { if (table === 'vaults') Object.assign(db.vault, row); return o; },
    insert: async (row) => {
      if (table === 'vault_duress_notices') {
        if (row.sig && db.notices.some((x) => x.sig === row.sig)) return { error: { message: 'duplicate key value violates unique constraint' } };
        db.notices.push({ ...row, created_at: new Date(Date.UTC(2026, 10, 25, 12, 0, db.t++)).toISOString() });
      } else db.events.push({ table, ...row });
      return { error: null };
    },
    then: (res) => {
      if (table === 'vaults') return res({ data: (f.descriptor === db.vault.descriptor || f.id === db.vault.id) ? [db.vault] : [], error: null });
      if (table === 'vault_membership_grants') return res({ data: db.grants.filter((g) => g.status === f.status), error: null });
      if (table === 'vault_duress_notices') return res({ data: db.notices, error: null });
      if (table === 'vault_members') return res({ data: [], error: null });
      return res({ data: [], error: null });
    },
  };
  return o;
};
const supabase = { from: q, rpc: async () => ({ data: 1, error: null }) };
let user = null;
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => supabase } });
const realAuth = await import(F('_auth.js'));
mock.module(F('_auth.js'), { namedExports: {
  ...realAuth,
  requireUser: async () => (user ? { userId: user } : { error: 'Not signed in' }),
  json: (statusCode, body) => ({ statusCode, headers: {}, body }),
} });
const realLedger = await import(F('_ledger.js'));
mock.module(F('_ledger.js'), { namedExports: { ...realLedger, recordEvent: async (_s, e) => { db.events.push(e); } } });
const realRate = await import(F('_rate-limit.js'));
mock.module(F('_rate-limit.js'), { namedExports: { ...realRate, overLimit: async () => false, TOO_MANY: 'too many' } });
const { handler } = await import(F('vault-duress.js'));
const post = (body, headers = {}) => handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });

// 1. Only an accepted member's signed notice counts.
reset();
let r = await post({ notice: notice('raise', 9) });
assert.equal(r.statusCode, 403); assert.equal(db.vault.duress, false);
const bad = { ...notice('raise', 1), sig: notice('raise', 2).sig };
r = await post({ notice: bad });
assert.equal(r.statusCode, 400); assert.equal(db.vault.duress, false);
r = await post({ notice: notice('raise', 1, new Date(Date.now() - 3600_000).toISOString()) });
assert.equal(r.statusCode, 400);
pass('a stranger, a forged signature, a stale notice: refused, nothing held');

// 2. A member's raise holds the vault at once and records it.
r = await post({ notice: notice('raise', 1) }, { origin: 'https://tapit-wallet.netlify.app' });
assert.equal(r.statusCode, 200, JSON.stringify(r.body));
assert.equal(db.vault.duress, true); assert.equal(r.body.circle_hold, true); assert.equal(r.body.needed, 3);
assert.ok(db.events.some((e) => e.event_type === 'duress_raised'));
assert.equal(r.headers['access-control-allow-origin'], 'https://tapit-wallet.netlify.app');
const other = await post({ notice: notice('raise', 2) }, { origin: 'https://evil.example' });
assert.equal(other.headers['access-control-allow-origin'], undefined);
pass("a member's raise holds the vault for everyone, recorded; only Tapit's site gets cross-site access");

// 3. The same notice cannot be used twice.
const once = notice('clear', 3);
assert.equal((await post({ notice: once })).statusCode, 200);
assert.equal((await post({ notice: once })).statusCode, 409);
pass('a notice is used once');

// 4. Clears below quorum, or without the owner, keep the hold.
await post({ notice: notice('clear', 4) });
await post({ notice: notice('clear', 5) });
assert.equal(db.vault.duress, true);
user = 'owner';
r = await post({ vault_id: 'v1', action: 'owner_clear' });
assert.equal(r.statusCode, 200, JSON.stringify(r.body));
assert.equal(db.vault.duress, false); assert.ok(db.events.some((e) => e.event_type === 'duress_cleared'));
pass('3 of the circle confirm, then the owner asks: the hold lifts (not before)');

// 5. The owner alone cannot lift it; a stranger cannot ask.
reset(); user = null;
await post({ notice: notice('raise', 2) });
user = 'owner';
r = await post({ vault_id: 'v1', action: 'owner_clear' });
assert.equal(db.vault.duress, true); assert.equal(r.body.owner_cleared, true);
user = 'someone-else';
assert.equal((await post({ vault_id: 'v1', action: 'owner_clear' })).statusCode, 404);
pass("the owner's ask alone does not lift it; nobody else can ask");

// 6. The owner's own halt switch cannot lift a circle hold.
assert.equal(holdState(db.notices.map((x) => ({ ...x, signer_pubkey: x.signer_pubkey })), CHECKERS.map(pub), 3).open, true);
const { handler: vaults } = await import(F('vaults.js'));
user = 'owner';
r = await vaults({ httpMethod: 'PATCH', headers: {}, queryStringParameters: { id: 'v1' }, body: JSON.stringify({ duress: false }) });
assert.equal(r.statusCode, 409, JSON.stringify(r.body)); assert.equal(db.vault.duress, true);
pass("the owner's halt switch cannot lift a hold the circle raised");

// 7. Blind review 2026-11-25 finding 2: the membership list is the owner's
// to write, so it cannot decide who the circle is. Grants the owner made for
// keys of their own (accepted on their word) do not count toward a clear;
// only the wellness path's keys in the compiled vault do.
reset(); user = null;
await post({ notice: notice('raise', 1) });
const MINE = [31, 32, 33];
db.grants.push(...MINE.map((i) => ({ recipient_pubkey: pub(i), status: 'accepted' })));
for (const i of MINE) await post({ notice: notice('clear', i) });
user = 'owner';
r = await post({ vault_id: 'v1', action: 'owner_clear' });
assert.equal(db.vault.duress, true, 'the owner lifted a circle hold with keys of their own');
assert.equal(r.body.clears, 0);
pass("keys the owner added to the membership list can't clear a circle hold: only the vault's own wellness keys count");

// 8. ...and the owner can't stop a real checker raising one by declining
// or re-sending that checker's grant.
reset(); user = null;
db.grants = db.grants.map((g) => ({ ...g, status: 'declined' }));
r = await post({ notice: notice('raise', 4) });
assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(db.vault.duress, true);
assert.equal((await post({ notice: notice('raise', OWNER) })).statusCode, 403);
pass("a wellness checker can raise a hold whatever the membership list says; the owner's own key is not a checker");

console.log(`vault-duress tests passed (${n} cases)`);
