/**
 * test-faceid-account.mjs -- Z4 (docs/z4-accounts-without-identity-build-note.md):
 * an account made from Face ID alone, adding Face ID to an existing account,
 * and removing an account's email.
 *
 * The browser side (lib/passkey-account.ts) runs with a stand-in passkey that
 * returns a fixed PRF secret per "passkey" -- a synced passkey on a second
 * device is the same passkey, so it returns the same secret. Its requests go
 * to the REAL key-signup, wallet-signin-verify, wallet-link and
 * account-email handlers against an in-memory database.
 *
 * Run:  node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/register-ts-resolver.mjs scripts/test-faceid-account.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const W = (f) => new URL(`../apps/web/src/lib/${f}`, import.meta.url).href;

globalThis.localStorage = (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() }; })();

// --- in-memory database + auth -----------------------------------------------
const tables = { wallet_signin_challenges: [], wallet_identities: [], wallet_signins: [], key_session_claims: [] };
const users = new Map();
let seq = 0;
function from(table) {
  const rows = (tables[table] ??= []);
  const filters = []; let op = 'select', payload = null, countHead = false;
  const match = r => filters.every(f => f(r));
  const run = () => {
    if (op === 'update') { const hit = rows.filter(match); hit.forEach(r => Object.assign(r, payload)); return hit; }
    if (op === 'delete') { const hit = rows.filter(match); for (const h of hit) rows.splice(rows.indexOf(h), 1); return hit; }
    if (op === 'insert') { const list = Array.isArray(payload) ? payload : [payload]; const out = list.map(p => ({ id: `${table}-${++seq}`, ...p })); rows.push(...out); return out; }
    return rows.filter(match);
  };
  const q = {
    select: (_c, o) => { if (o?.head) countHead = true; return q; },
    insert: p => { op = 'insert'; payload = p; return q; },
    update: p => { op = 'update'; payload = p; return q; },
    delete: () => { op = 'delete'; return q; },
    eq: (k, v) => { filters.push(r => r[k] === v); return q; },
    is: (k, v) => { filters.push(r => (r[k] ?? null) === v); return q; },
    gt: () => q, lt: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    single: async () => { const d = run()[0]; return { data: d ?? null, error: d ? null : { message: 'none' } }; },
    then: res => { const d = run(); return res(countHead ? { count: d.length, data: null, error: null } : { data: d, error: null }); },
  };
  return q;
}
const admin = {
  createUser: async ({ email, user_metadata, app_metadata }) => { const id = `u-${++seq}`; users.set(id, { id, email, user_metadata, app_metadata }); return { data: { user: users.get(id) }, error: null }; },
  getUserById: async id => ({ data: { user: users.get(id) ?? null }, error: users.has(id) ? null : { message: 'none' } }),
  updateUserById: async (id, patch) => { Object.assign(users.get(id), patch); return { data: { user: users.get(id) }, error: null }; },
  deleteUser: async id => { users.delete(id); return { error: null }; },
  generateLink: async ({ email }) => ({ data: { properties: { hashed_token: `tok:${email}` } }, error: null }),
};
const db = { from, auth: { admin }, rpc: async () => ({ data: 1, error: null }) };
let who = null;
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => db } });
mock.module(F('_auth.js'), { namedExports: {
  requireUser: async () => (who ? { userId: who, claims: { sub: who, email: users.get(who)?.email } } : { error: 'Not signed in' }),
  json: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) }),
} });

// --- the browser side: supabase client stand-in, fetch routed to handlers ----
let sessionUser = null;
mock.module(W('supabase.ts'), { namedExports: { supabase: { auth: {
  verifyOtp: async ({ token_hash }) => {
    const email = token_hash.replace(/^tok:/, '');
    sessionUser = [...users.values()].find(u => u.email === email) ?? null;
    return { error: sessionUser ? null : { message: 'bad token' } };
  },
  getSession: async () => ({ data: { session: sessionUser ? { access_token: 'jwt', user: sessionUser } : null } }),
  getUser: async () => ({ data: { user: sessionUser } }),
} } } });
mock.module(W('key-account.ts'), { namedExports: { recordKeySession: async () => true } });

const handlers = {
  'wallet-signin-challenge': (await import(F('wallet-signin-challenge.js'))).handler,
  'key-signup': (await import(F('key-signup.js'))).handler,
  'wallet-signin-verify': (await import(F('wallet-signin-verify.js'))).handler,
  'wallet-link': (await import(F('wallet-link.js'))).handler,
  'account-email': (await import(F('account-email.js'))).handler,
};
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  const name = url.replace(/^\/api\//, '').split('?')[0];
  const body = init.body ? JSON.parse(init.body) : {};
  sent.push({ name, body });
  who = init.headers?.Authorization ? sessionUser?.id ?? null : null;
  const r = await handlers[name]({ httpMethod: init.method ?? 'GET', headers: { ...(init.headers ?? {}), 'x-nf-client-connection-ip': '9.9.9.9' }, body: init.body, queryStringParameters: {} });
  return { ok: r.statusCode < 300, status: r.statusCode, text: async () => r.body };
};

const pa = await import(W('passkey-account.ts'));
const { verifySignIn } = await import('tapit-attest');

/** A stand-in passkey: one fixed PRF secret per passkey, like a real one. */
const passkey = (seed) => {
  const secret = new Uint8Array(32).fill(seed);
  return { create: async () => `cred-${seed}`, secret: async (id) => ({ credentialIdB64: id ?? `cred-${seed}`, secret }) };
};

// 1. The key: deterministic per passkey, different across passkeys, never the PRF itself.
{
  const a1 = pa.signInKeyFromPrf(new Uint8Array(32).fill(7));
  const a2 = pa.signInKeyFromPrf(new Uint8Array(32).fill(7));
  const b = pa.signInKeyFromPrf(new Uint8Array(32).fill(8));
  assert.equal(a1, a2); assert.notEqual(a1, b);
  assert.notEqual(a1, '07'.repeat(32));
  assert.throws(() => pa.signInKeyFromPrf(new Uint8Array(16)), /length/);
  pass('the sign-in key is the same every time for one passkey, different for another');
}

// 2. Create an account with Face ID alone: no email, no name, a device key.
{
  await pa.createFaceIdAccount(passkey(7));
  const signup = sent.find(r => r.name === 'key-signup');
  assert.deepEqual(Object.keys(signup.body).sort(), ['grant', 'kind']);
  assert.equal(signup.body.kind, 'device');
  const att = signup.body.grant.attestation;
  assert.ok(att.screenCode, 'the sign-in number is filled in');
  assert.ok(verifySignIn({ attestation: att, expectedChallenge: att.challenge, requireScreenCode: true }).valid);
  assert.ok(sessionUser, 'signed in');
  assert.match(sessionUser.email, /@keys\.dynastytrust\.family$/, 'a never-mailed placeholder, no real email');
  assert.deepEqual(sessionUser.user_metadata, { signin: 'key' }, 'no name stored');
  assert.deepEqual(tables.wallet_identities.map(r => [r.user_id, r.kind]), [[sessionUser.id, 'device']]);
  pass('Face ID alone makes an account: no email, no name, one device key; the proof carries the sign-in number');
}

// 3. Sign out, sign back in -- on this phone, and on a "new phone" with the synced passkey.
{
  const account = sessionUser.id;
  sessionUser = null;
  await pa.signInWithFaceIdAccount(passkey(7));
  assert.equal(sessionUser?.id, account);
  sessionUser = null; localStorage.clear();
  await pa.signInWithFaceIdAccount(passkey(7));
  assert.equal(sessionUser?.id, account, 'a new device with the same synced passkey gets the same account');
  sessionUser = null;
  await assert.rejects(() => pa.signInWithFaceIdAccount(passkey(9)), /not a DynastyTrust account/);
  assert.equal(sessionUser, null);
  pass('sign in again with one Face ID prompt, also from a new device with the synced passkey; another passkey is refused clearly');
}

// 4. An email account adds Face ID, then removes its email.
{
  const { data } = await admin.createUser({ email: 'gran@example.com', user_metadata: {}, app_metadata: {} });
  sessionUser = data.user;
  // Without a key, removing the email is refused (it would lock her out).
  who = sessionUser.id;
  let r = await handlers['account-email']({ httpMethod: 'DELETE', headers: {} });
  assert.equal(r.statusCode, 409);
  await pa.addFaceIdToThisAccount(passkey(11));
  assert.ok(tables.wallet_identities.some(k => k.user_id === sessionUser.id && k.kind === 'device'));
  const link = JSON.parse((await handlers['wallet-link']({ httpMethod: 'GET', headers: {} })).body);
  assert.equal(link.device_keys, 1);
  r = await handlers['account-email']({ httpMethod: 'DELETE', headers: {} });
  assert.equal(r.statusCode, 200, r.body);
  const gran = users.get(sessionUser.id);
  assert.match(gran.email, /@keys\.dynastytrust\.family$/);
  assert.equal(gran.app_metadata.dt_made_by, 'email-removed', 'marked, so the placeholder guard lets it act');
  assert.ok(!JSON.stringify([...users.values()]).includes('gran@example.com'), 'the address is gone');
  r = await handlers['account-email']({ httpMethod: 'DELETE', headers: {} });
  assert.equal(r.statusCode, 400, 'nothing left to remove');
  // ...and she still gets in with Face ID.
  sessionUser = null; localStorage.clear();
  await pa.signInWithFaceIdAccount(passkey(11));
  assert.equal(sessionUser?.id, gran.id);
  pass('an email account adds Face ID, then removes its email (refused before a key exists); Face ID still signs her in');
}

console.log(`faceid account: ${n} checks passed`);
