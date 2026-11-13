/**
 * test-placeholder-guard.mjs -- threat model item J: an account at a
 * never-mailed username/Tapit address that DynastyTrust did not make
 * (someone used Supabase's public sign-up with it) is refused by every
 * function, and a squatter on a username is removed so the real person can
 * have it. The database half (backfill, server-only lookup) is in
 * scripts/test-no-client-writes-db.sh. Wired into npm test.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-placeholder-guard.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;

// The token IS its claims here; signature checking is jose's job, not this test's.
mock.module(F('node_modules/jose/dist/node/esm/index.js'), { namedExports: {
  createRemoteJWKSet: () => ({}),
  jwtVerify: async (token) => ({ payload: JSON.parse(token) }),
} });

let lookupDown = false;
const appMetaById = new Map();
const users = new Map(); // email -> { id, confirmed, made_by }
const deleted = [];
let made = 0;
const admin = {
  getUserById: async (id) => lookupDown ? { data: null, error: { message: 'down' } } : { data: { user: { id, app_metadata: appMetaById.get(id) ?? {} } }, error: null },
  mfa: { listFactors: async () => ({ data: { factors: [] }, error: null }) },
  createUser: async ({ email, app_metadata }) => {
    if (users.has(email)) return { data: null, error: { message: 'A user with this email address has already been registered' } };
    const id = 'u' + (++made); users.set(email, { id, confirmed: true, made_by: app_metadata?.dt_made_by ?? null });
    return { data: { user: { id } }, error: null };
  },
  deleteUser: async (id) => { deleted.push(id); for (const [e, u] of users) if (u.id === id) users.delete(e); return { error: null }; },
};
const rpc = async (name, args) => {
  if (name === 'placeholder_account') { const u = users.get(args.p_email); return { data: u ? [u] : [], error: null }; }
  return { data: 1, error: null }; // rate_hit
};
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ rpc, auth: { admin } }) } });

const { requireUser } = await import(F('_auth.js'));
const { handler: usernameSignup } = await import(F('username-signup.js'));
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const call = (claims) => requireUser({ headers: { authorization: 'Bearer ' + JSON.stringify({ aal: 'aal1', ...claims }) } });

// 1. Ordinary email accounts are untouched.
assert.equal((await call({ sub: 'e1', email: 'dad@example.com' })).userId, 'e1');
// 2. A placeholder account this app made passes on its token's mark.
assert.equal((await call({ sub: 'p1', email: 'joe@users.dynastytrust.family', app_metadata: { dt_made_by: 'username-signup' } })).userId, 'p1');
pass('ordinary email accounts and our own marked placeholder accounts act as before');

// 3. No mark on the token, but the account is marked now (backfilled, or
//    the token predates the mark): looked up fresh, allowed.
appMetaById.set('p2', { dt_made_by: 'backfill-2026-11-13' });
assert.equal((await call({ sub: 'p2', email: 'k-ab@keys.dynastytrust.family', app_metadata: {} })).userId, 'p2');
// 4. A public sign-up at a placeholder address: refused, for either domain.
for (const email of ['grandpa.joe@users.dynastytrust.family', 'K-X@Keys.DynastyTrust.Family']) {
  const r = await call({ sub: 'sq', email, app_metadata: { provider: 'email' } });
  assert.ok(r.error && /not made by DynastyTrust/.test(r.error), `squatter allowed: ${email}`);
}
pass('an unmarked account at a username or Tapit address is refused; a backfilled one is not');

// 5. The lookup failing refuses (fail closed), and says so.
lookupDown = true;
assert.match((await call({ sub: 'p3', email: 'x@users.dynastytrust.family' })).error, /Could not check this account/);
lookupDown = false;
pass('a failed account lookup refuses rather than guessing');

// 6. username-signup: a squatter on the name is removed and the real account made.
users.set('grandpa.joe@users.dynastytrust.family', { id: 'squatter', confirmed: true, made_by: null });
const pw = 'river-copper-lantern-58';
const ok = await usernameSignup({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ username: 'grandpa.joe', password: pw }) });
assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
assert.deepEqual(deleted, ['squatter']);
assert.equal(users.get('grandpa.joe@users.dynastytrust.family').made_by, 'username-signup');
// 7. A name held by an account WE made stays taken, and nothing is deleted.
const again = await usernameSignup({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ username: 'grandpa.joe', password: pw }) });
assert.equal(again.statusCode, 409);
assert.deepEqual(deleted, ['squatter'], 'a real account must never be deleted');
pass('username sign-up removes a squatter on the name; a real holder keeps it');

console.log(`placeholder-guard tests passed (${n} cases)`);
