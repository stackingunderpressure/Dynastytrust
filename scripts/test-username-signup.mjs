/**
 * test-username-signup.mjs -- username accounts with no email
 * (operator, 2026-11-13: "user name password ... or email for future
 * proof of getting locked out"). The REAL handler with Supabase's admin
 * auth stood in; the browser's own rules (apps/web/src/lib/username.ts)
 * must agree with the server's. Wired into npm test.
 *
 * Run:  node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/register-ts-resolver.mjs scripts/test-username-signup.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const made = [];
const auth = { admin: { createUser: async (o) => {
  if (made.some(u => u.email === o.email)) return { data: null, error: { message: 'A user with this email address has already been registered' } };
  made.push(o); return { data: { user: { id: 'u' + made.length } }, error: null };
} } };
// placeholder_account: who holds a name (threat model J); rate_hit otherwise.
const rpc = async (name, a) => name === 'placeholder_account'
  ? { data: made.filter(u => u.email === a.p_email).map((u, i) => ({ id: 'u' + (i + 1), confirmed: true, made_by: u.app_metadata?.dt_made_by ?? null })), error: null }
  : { data: 1, error: null };
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ auth, rpc, from: () => { throw new Error('no table use expected'); } }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => ({ error: 'n/a' }), json: (statusCode, body) => ({ statusCode, body }) } });
const srv = await import(F('username-signup.js'));
const web = await import('../apps/web/src/lib/username.ts');
const call = (body) => srv.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const GOOD = 'river-copper-lantern-58';

// 1. A username account: confirmed, never-mailed address, name defaults to the username.
let r = await call({ username: '  Grandpa.Joe ', password: GOOD });
assert.equal(r.statusCode, 200, JSON.stringify(r.body));
assert.deepEqual(made[0], { email: 'grandpa.joe@users.dynastytrust.family', password: GOOD, email_confirm: true, user_metadata: { display_name: 'grandpa.joe', username: 'grandpa.joe', signin: 'username' }, app_metadata: { dt_made_by: 'username-signup' } });
assert.equal(web.signInAddress(' Grandpa.Joe '), made[0].email, 'the browser signs in at the same address');
assert.equal(web.signInAddress('anna@example.com'), 'anna@example.com', 'an email is used as typed');
pass('a username account: confirmed, never-mailed address, same address at sign-in');

// 2. Taken, bad names and weak passwords are refused; nothing made.
r = await call({ username: 'grandpa.joe', password: GOOD }); assert.equal(r.statusCode, 409); assert.match(r.body.error, /taken/);
for (const u of ['ab', 'a@b.com', '-joe', 'joe smith', 'x'.repeat(31), '', null]) {
  r = await call({ username: u, password: GOOD }); assert.equal(r.statusCode, 400, String(u));
  assert.notEqual(web.usernameProblem(String(u ?? '')), null, `browser agrees: ${u}`);
}
for (const p of ['short1', 'aaaaaaaaaaaaaaaa', 'mybitcoinvault2026', 'joe-is-great-2026']) {
  r = await call({ username: 'joe', password: p }); assert.equal(r.statusCode, 400, p);
}
for (const u of ['joe', 'Grandpa.Joe', 'kid_1', 'a-b.c']) assert.equal(web.usernameProblem(u), null, u);
assert.equal(made.length, 1, 'nothing made by a refused request');
pass('taken usernames, bad usernames (browser agrees) and weak or guessable passwords are refused');

console.log(`username-signup tests passed (${n} cases)`);
