/**
 * test-rate-limit.mjs -- threat model item H: the signed-out endpoints
 * refuse a flood from one connection, count per connection, and a counter
 * outage never locks people out (fails open). The database half (atomic
 * counter, server-only, challenge cleanup) is in
 * scripts/test-no-client-writes-db.sh. Wired into npm test.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-rate-limit.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const counts = new Map(); let rpcDown = false;
const rpc = async (name, args) => {
  if (rpcDown) return { data: null, error: { message: 'down' } };
  if (name === 'rate_housekeeping') return { data: null, error: null };
  const c = (counts.get(args.p_bucket) ?? 0) + 1; counts.set(args.p_bucket, c); return { data: c, error: null };
};
const q = { insert: () => q, select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }), then: (r) => r({ data: null, error: null }) };
let made = 0;
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ rpc, from: () => q, auth: { admin: { createUser: async () => ({ data: { user: { id: 'u' + (++made) } }, error: null }) } } }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => ({ error: 'n/a' }), json: (statusCode, body) => ({ statusCode, body }) } });
const H = {};
for (const f of ['wallet-signin-challenge', 'key-signup', 'username-signup']) H[f] = (await import(F(f + '.js'))).handler;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const from = (ip) => ({ 'x-nf-client-connection-ip': ip });
const hit = (f, ip, body = {}) => H[f]({ httpMethod: 'POST', headers: from(ip), body: JSON.stringify(body) });

for (let i = 1; i <= 30; i++) assert.notEqual((await hit('wallet-signin-challenge', '1.1.1.1')).statusCode, 429, `challenge ${i}`);
assert.equal((await hit('wallet-signin-challenge', '1.1.1.1')).statusCode, 429);
assert.notEqual((await hit('wallet-signin-challenge', '2.2.2.2')).statusCode, 429, 'another connection is counted separately');
pass('sign-in challenges: 30 per 10 minutes per connection, the 31st refused');

for (let i = 1; i <= 5; i++) assert.notEqual((await hit('username-signup', '3.3.3.3', { username: `kid${i}`, password: 'river-copper-lantern-58' })).statusCode, 429);
const sixth = await hit('username-signup', '3.3.3.3', { username: 'kid6', password: 'river-copper-lantern-58' });
assert.equal(sixth.statusCode, 429); assert.match(sixth.body.error, /Too many/);
assert.equal(made, 5, 'the refused attempt made no account');
for (let i = 1; i <= 5; i++) assert.notEqual((await hit('key-signup', '4.4.4.4')).statusCode, 429);
assert.equal((await hit('key-signup', '4.4.4.4')).statusCode, 429);
pass('account creation: 5 per hour per connection, the 6th refused and nothing made');

rpcDown = true;
assert.notEqual((await hit('wallet-signin-challenge', '1.1.1.1')).statusCode, 429, 'a counter outage must not lock people out');
pass('a counter outage never locks anyone out');

console.log(`rate-limit tests passed (${n} cases)`);
