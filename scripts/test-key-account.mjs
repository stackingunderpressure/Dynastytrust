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
const tables = { wallet_signin_challenges: [], wallet_identities: [], wallet_signins: [], key_session_claims: [], key_sessions: [] };
const users = new Map(); let failNextBind = false;
const UNIQUE = { wallet_identities: ['pubkey'], key_sessions: ['session_id'], key_session_claims: ['claim_hash'] };
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
let caller = null; let callerSession = null;
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from, auth }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => (caller ? { userId: caller, claims: { sub: caller, session_id: callerSession } } : { error: 'Not signed in' }), json: (statusCode, body) => ({ statusCode, body }) } });

mock.module(new URL('../apps/web/src/lib/supabase.ts', import.meta.url).href, { namedExports: { supabase: {} } });
const H = {};
for (const f of ['key-signup', 'wallet-signin-challenge', 'wallet-signin-verify', 'wallet-link', 'key-session']) H[f] = (await import(F(f + '.js'))).handler;
import { createHash } from 'node:crypto';
// A stand-in for a Tapit wallet's key: any secp256k1 key signs the same
// TA-1 challenge the wallet does (tapit-attest answerSignInChallenge).
const walletKey = (words) => createHash('sha256').update('tapit-test-wallet:' + words).digest('hex');
const { answerSignInChallenge, signInScreenCode } = await import('tapit-attest');
const { generateMnemonic } = await import('@scure/bip39');
const { wordlist } = await import('@scure/bip39/wordlists/english');

let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const call = (fn, body) => H[fn]({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
// As the wallet signs since threat model G: with the number the person typed
// from the screen (signInScreenCode), inside the signature. `typed` lets a
// case sign with no number (an old wallet: 'none') or the wrong one ('wrong').
const proof = async (mnemonic, typed = 'right') => {
  const { body } = await call('wallet-signin-challenge', {});
  const right = signInScreenCode(body.challenge);
  const screenCode = typed === 'right' ? right : typed === 'none' ? undefined : String((Number(right) + 1) % 100).padStart(2, '0');
  return { attestation: answerSignInChallenge({ challenge: body.challenge, signerPrivateKey: walletKey(mnemonic), ...(screenCode !== undefined ? { screenCode } : {}) }) };
};
const WORDS = generateMnemonic(wordlist, 256);

// 1. Sovereign sign-in: an account made by a Tapit key is recorded as a Tapit key.
{
  const s0 = await call('key-signup', { grant: await proof('tapit-only') , display_name: 'Gran' });
  assert.equal(s0.statusCode, 200, JSON.stringify(s0.body));
  const row = tables.wallet_identities.at(-1);
  assert.equal(row.kind, 'tapit'); assert.equal(row.label, 'Tapit wallet');
  tables.wallet_identities.pop(); users.clear(); tables.wallet_signins.length = 0;
}
pass('a Tapit-made account is bound as its Tapit key (no email, no words)');

// 2. Sign up with no email: confirmed placeholder account, key bound, session token.
const s1 = await call('key-signup', { grant: await proof(WORDS), display_name: '  Dad\u0007 ', kind: 'device' });
assert.equal(s1.statusCode, 200, JSON.stringify(s1.body));
const user = users.get(tokens.get(s1.body.token_hash));
assert.ok(user, 'the token logs into the new account');
assert.match(user.email, /^k-[0-9a-f]{24}@keys\.dynastytrust\.family$/);
assert.equal(user.email_confirm, true);
assert.deepEqual(user.user_metadata, { display_name: 'Dad', signin: 'key' });
assert.equal(tables.wallet_identities.length, 1);
assert.equal(tables.wallet_identities[0].kind, 'device');
assert.equal(tables.wallet_signins.length, 1);
pass('sign up: no email, never-mailed placeholder, key bound with the kind asked, name cleaned');

// 3. The same words sign in to the same account, on any phone.
const s2 = await call('wallet-signin-verify', { grant: await proof(WORDS) });
assert.equal(s2.statusCode, 200);
assert.equal(tokens.get(s2.body.token_hash), user.id);
pass('the same key signs in to the same account');

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

// 4b. Threat model G: a proof without the sign-in number (an old wallet that
//     never asked), or with the wrong one, is refused at all three doors.
for (const typed of ['none', 'wrong']) {
  const grantFor = () => proof(WORDS, typed);
  const v = await call('wallet-signin-verify', { grant: await grantFor() });
  assert.equal(v.statusCode, 401, `sign-in took a proof with ${typed} number`);
  assert.match(v.body.error, typed === 'none' ? /number missing/ : /number does not match/);
  assert.equal((await call('key-signup', { grant: await grantFor() })).statusCode, 401, `sign-up took ${typed}`);
}
pass('refused: a proof with no sign-in number or the wrong one, at sign-in and sign-up');

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
assert.equal((await call('wallet-signin-verify', { grant: await proof(WORDS) })).statusCode, 200, 'still signs in with the key');
pass('Tapit link and unlink touch only the Tapit key');

// 7. Key-made sessions (slice 3): a key login comes with a one-time claim;
//    only the same account's new session can redeem it, once, in time.
{
  const { isKeySession } = await import(F('_key-account.js'));
  const db = { from };
  const login = await call('wallet-signin-verify', { grant: await proof(WORDS) });
  const claim = login.body.key_session_claim;
  assert.match(claim, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(tables.key_session_claims).includes(claim), 'only the hash is stored');
  const SID = '0000aaaa-1111-2222-3333-444455556666';
  caller = 'u-intruder'; callerSession = SID;
  assert.equal((await call('key-session', { claim })).statusCode, 403, "another account cannot redeem it");
  caller = user.id; callerSession = SID;
  assert.equal((await call('key-session', { claim })).statusCode, 200);
  assert.equal(await isKeySession(db, { sub: user.id, session_id: SID }), true);
  assert.equal(await isKeySession(db, { sub: 'u-intruder', session_id: SID }), false);
  assert.equal(await isKeySession(db, { sub: user.id, session_id: '9999aaaa-1111-2222-3333-444455556666' }), false);
  callerSession = '1111bbbb-1111-2222-3333-444455556666';
  assert.equal((await call('key-session', { claim })).statusCode, 409, 'a claim works once');
  const late = (await call('wallet-signin-verify', { grant: await proof(WORDS) })).body.key_session_claim;
  tables.key_session_claims.at(-1).expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call('key-session', { claim: late })).statusCode, 410, 'an expired claim is refused');
  assert.equal((await call('key-session', { claim: 'zz' })).statusCode, 400);
  callerSession = undefined;
  const fresh = (await call('wallet-signin-verify', { grant: await proof(WORDS) })).body.key_session_claim;
  assert.equal((await call('key-session', { claim: fresh })).statusCode, 400, 'a session with no id cannot be recorded');
  const signup = await call('key-signup', { grant: await proof(generateMnemonic(wordlist, 256)) });
  assert.match(signup.body.key_session_claim, /^[0-9a-f]{64}$/, 'sign-up hands one out too');
  caller = null;
}
pass('key-made sessions: one-time claim, own account only, once, in time, hashed at rest');

console.log(`key-account tests passed (${n} cases)`);
