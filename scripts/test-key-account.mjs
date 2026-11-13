/**
 * test-key-account.mjs -- email-free sign-in, slice 1
 * (docs/key-signin-build-note.md). The REAL handlers (key-signup,
 * wallet-signin-challenge, wallet-signin-verify, wallet-link) with REAL key
 * proofs made by the browser's own code (apps/web/src/lib/key-account.ts +
 * tapit-attest). Only the database and Supabase's admin auth are in-memory
 * stand-ins; the live Supabase steps were proven separately by
 * key-signin-placeholder-test.yml. Wired into npm test.
 *
 * Run:  node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/register-ts-resolver.mjs scripts/test-key-account.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;

// ---- in-memory tables + Supabase admin auth
const tables = { wallet_signin_challenges: [], wallet_identities: [], wallet_signins: [] };
const users = new Map(); let failNextBind = false;
const UNIQUE = { wallet_identities: ['pubkey'] };
function from(t) {
  const rows = tables[t]; const f = []; let op = 'select', payload;
  const match = (r) => f.every(x => x(r));
  const run = () => {
    if (op === 'insert') {
      const list = Array.isArray(payload) ? payload : [payload];
      for (const r of list) {
        if (t === 'wallet_identities' && failNextBind) { failNextBind = false; return { error: { code: '23505', message: 'duplicate' } }; }
        for (const u of UNIQUE[t] ?? []) if (rows.some(x => x[u] === r[u])) return { error: { code: '23505', message: `duplicate ${u}` } };
        if (t === 'wallet_identities' && r.kind === 'tapit' && rows.some(x => x.user_id === r.user_id && x.kind === 'tapit')) return { error: { code: '23505', message: 'one tapit' } };
        rows.push({ kind: 'tapit', ...r });
      }
      return { data: list, error: null };
    }
    if (op === 'update') { const hit = rows.filter(match); hit.forEach(r => Object.assign(r, payload)); return { data: hit.map(r => ({ ...r })), error: null }; }
    if (op === 'delete') { const hit = rows.filter(match); hit.forEach(r => rows.splice(rows.indexOf(r), 1)); return { data: hit, error: null }; }
    return { data: rows.filter(match).map(r => ({ ...r })), error: null };
  };
  const q = { select: () => q, insert: (r) => { op = 'insert'; payload = r; return q; }, update: (o) => { op = 'update'; payload = o; return q; }, delete: () => { op = 'delete'; return q; }, upsert: () => { throw new Error('upsert must not be used on wallet_identities any more'); },
    eq: (k, v) => { f.push(r => r[k] === v); return q; }, is: (k, v) => { f.push(r => (r[k] ?? null) === v); return q; },
    maybeSingle: async () => { const r = run(); if (r.error) return r; if (r.data.length > 1) return { data: null, error: { message: 'multiple rows' } }; return { data: r.data[0] ?? null, error: null }; },
    then: (res) => res(run()) };
  return q;
}
let tokenSeq = 0; const tokens = new Map();
const auth = { admin: {
  createUser: async ({ email, email_confirm, user_metadata }) => { const id = `u-${users.size + 1}`; users.set(id, { id, email, email_confirm, user_metadata }); return { data: { user: { id } }, error: null }; },
  deleteUser: async (id) => { users.delete(id); return { error: null }; },
  getUserById: async (id) => ({ data: { user: users.get(id) ?? null }, error: users.has(id) ? null : { message: 'no user' } }),
  generateLink: async ({ email }) => { const u = [...users.values()].find(x => x.email === email); if (!u) return { data: null, error: { message: 'no user' } }; const h = `t${++tokenSeq}`; tokens.set(h, u.id); return { data: { properties: { hashed_token: h } }, error: null }; },
} };
let caller = null;
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from, auth }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => (caller ? { userId: caller } : { error: 'Not signed in' }), json: (statusCode, body) => ({ statusCode, body }) } });

mock.module(new URL('../apps/web/src/lib/supabase.ts', import.meta.url).href, { namedExports: { supabase: {} } });
const H = {};
for (const f of ['key-signup', 'wallet-signin-challenge', 'wallet-signin-verify', 'wallet-link']) H[f] = (await import(F(f + '.js'))).handler;
const ka = await import('../apps/web/src/lib/key-account.ts');
const { answerSignInChallenge } = await import('tapit-attest');
const { generateMnemonic } = await import('@scure/bip39');
const { wordlist } = await import('@scure/bip39/wordlists/english');

let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const call = (fn, body) => H[fn]({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
const proof = async (mnemonic) => {
  const { body } = await call('wallet-signin-challenge', {});
  return { attestation: answerSignInChallenge({ challenge: body.challenge, signerPrivateKey: ka.signInPrivateKey(mnemonic) }) };
};
const WORDS = generateMnemonic(wordlist, 256);

// 1. The sign-in key: same words -> same key; never a vault key; one per words.
const pkA = ka.signInPrivateKey(WORDS);
assert.equal(pkA, ka.signInPrivateKey(WORDS));
assert.notEqual(pkA, ka.signInPrivateKey(generateMnemonic(wordlist, 256)));
assert.equal(ka.SIGN_IN_PATH, "m/86'/0'/900001'/0/0");
pass("sign-in key: same words, same key; its own hardened path");

// 2. Sign up with no email: confirmed placeholder account, key bound, session token.
const s1 = await call('key-signup', { grant: await proof(WORDS), display_name: '  Dad\u0007 ' });
assert.equal(s1.statusCode, 200, JSON.stringify(s1.body));
const user = users.get(tokens.get(s1.body.token_hash));
assert.ok(user, 'the token logs into the new account');
assert.match(user.email, /^k-[0-9a-f]{24}@keys\.dynastytrust\.family$/);
assert.equal(user.email_confirm, true);
assert.deepEqual(user.user_metadata, { display_name: 'Dad', signin: 'key' });
assert.equal(tables.wallet_identities.length, 1);
assert.equal(tables.wallet_identities[0].kind, 'device');
assert.equal(tables.wallet_signins.length, 1);
pass('sign up: no email, never-mailed placeholder, key bound as this phone, name cleaned');

// 3. The same words sign in to the same account, on any phone.
const s2 = await call('wallet-signin-verify', { grant: await proof(WORDS) });
assert.equal(s2.statusCode, 200);
assert.equal(tokens.get(s2.body.token_hash), user.id);
pass('the same 24 words sign in to the same account');

// 4. Refusals.
const again = await call('key-signup', { grant: await proof(WORDS) });
assert.equal(again.statusCode, 409);
assert.equal(users.size, 1, 'no second account for the same key');
const p = await proof(WORDS);
assert.equal((await call('wallet-signin-verify', { grant: p })).statusCode, 200);
assert.equal((await call('wallet-signin-verify', { grant: p })).statusCode, 401, 'a used proof cannot be replayed');
const other = generateMnemonic(wordlist, 256);
const unknown = await call('wallet-signin-verify', { grant: await proof(other) });
assert.equal(unknown.statusCode, 403);
assert.match(unknown.body.error, /no DynastyTrust account yet/);
const forged = await proof(other);
forged.attestation.signer = (await proof(WORDS)).attestation.signer; // claim someone else's key
assert.equal((await call('key-signup', { grant: forged })).statusCode, 401);
assert.equal((await call('wallet-signin-verify', { grant: forged })).statusCode, 401);
pass('refused: a second sign-up, a replayed proof, a key with no account, a forged signer');

// 5. A failed bind deletes the account it just made.
const before = users.size;
failNextBind = true;
const orphan = await call('key-signup', { grant: await proof(generateMnemonic(wordlist, 256)) });
assert.equal(orphan.statusCode, 409);
assert.equal(users.size, before, 'no orphan account left behind');
pass('a failed key bind leaves no account behind');

// 6. A Tapit link sits beside the phone key and never removes it.
caller = user.id;
const tapitWords = generateMnemonic(wordlist, 256);
const linked = await call('wallet-link', { grant: await proof(tapitWords) });
assert.equal(linked.statusCode, 200, JSON.stringify(linked.body));
assert.deepEqual(tables.wallet_identities.filter(r => r.user_id === user.id).map(r => r.kind).sort(), ['device', 'tapit']);
const got = await H['wallet-link']({ httpMethod: 'GET', headers: {} });
assert.equal(got.statusCode, 200, 'reading the Tapit link works with two keys on the account');
await H['wallet-link']({ httpMethod: 'DELETE', headers: {} });
assert.deepEqual(tables.wallet_identities.filter(r => r.user_id === user.id).map(r => r.kind), ['device'], 'unlinking Tapit keeps the phone key');
assert.equal((await call('wallet-signin-verify', { grant: await proof(WORDS) })).statusCode, 200, 'still signs in with the words');
pass('Tapit link and unlink touch only the Tapit key');

console.log(`key-account tests passed (${n} cases)`);
