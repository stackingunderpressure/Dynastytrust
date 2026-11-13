/**
 * test-tapit-binding.mjs -- threat model item G, browser side
 * (apps/web/src/lib/wallet-signin.ts; docs/tapit-signin-binding-build-note.md):
 * the number this page shows is the one Tapit asks for, it is never put in
 * the request sent to the wallet, and an approval for a sign-in this browser
 * did not start (the login trap) is refused before it reaches the server.
 * The server half is in test-key-account.mjs. Wired into npm test.
 *
 * Run:  node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/register-ts-resolver.mjs scripts/test-tapit-binding.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.window = { location: { origin: 'https://dynastytrust.family', href: '' } };
const L = (f) => new URL(`../apps/web/src/lib/${f}`, import.meta.url).href;
let verified = 0;
mock.module(L('supabase.ts'), { namedExports: { supabase: { auth: { verifyOtp: async () => { verified++; return { error: null }; }, getSession: async () => ({ data: { session: null } }) } } } });
mock.module(L('key-account.ts'), { namedExports: { recordKeySession: async () => {} } });

const { buildSignInChallenge, answerSignInChallenge, signInScreenCode } = await import('tapit-attest');
const posts = [];
let issued = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).endsWith('/wallet-signin-challenge')) {
    const challenge = buildSignInChallenge({ audience: 'dynastytrust.family' });
    issued.push(challenge);
    return new Response(JSON.stringify({ ok: true, challenge }), { status: 200 });
  }
  posts.push({ url: String(url), body: init.body });
  return new Response(JSON.stringify({ ok: true, token_hash: 't', key_session_claim: 'c' }), { status: 200 });
};
const ws = await import(L('wallet-signin.ts'));
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const KEY = '22'.repeat(32);
const approve = (challenge, code = signInScreenCode(challenge)) => ({ signIn: answerSignInChallenge({ challenge, signerPrivateKey: KEY, screenCode: code }) });
const decodeReq = (url) => JSON.parse(Buffer.from(new URL(url).searchParams.get('req'), 'base64url').toString());

// 1. Same-device start: the number shown is Tapit's number for this request,
//    and the request handed to the wallet does not carry it.
const start = await ws.prepareTapitFlow('signin');
const ch = issued.at(-1);
assert.equal(start.screenCode, signInScreenCode(ch));
assert.match(start.screenCode, /^\d{2}$/);
const req = decodeReq(start.url);
assert.equal(req.challenge.nonce, ch.nonce);
assert.equal(JSON.stringify(req).includes('screenCode'), false, 'the wallet must not be told the number');
pass('the page shows the number Tapit asks for, and never sends it to the wallet');

// 2. QR and pushed starts carry their own number too.
const qr = await ws.startTapitConnectRequest('signin');
assert.equal(qr.screenCode, signInScreenCode(issued.at(-1)));
pass('the QR start shows its own request\'s number');

// 3. The login trap: an approval for a challenge this browser never started
//    is refused, and nothing is sent to the server.
const foreign = buildSignInChallenge({ audience: 'dynastytrust.family' });
await assert.rejects(ws.completeTapitCallback({ mode: 'signin', grant: approve(foreign) }), /not started in this browser/);
assert.equal(posts.length, 0, 'a foreign approval reached the server');
pass('an approval for a sign-in started elsewhere is refused before the server sees it');

// 4. Our own start completes once; the same approval cannot be used twice here.
await ws.completeTapitCallback({ mode: 'signin', grant: approve(ch) });
assert.equal(posts.length, 1);
assert.match(posts[0].url, /wallet-signin-verify$/);
assert.equal(JSON.parse(posts[0].body).grant.attestation.screenCode, start.screenCode);
assert.equal(verified, 1);
await assert.rejects(ws.completeTapitCallback({ mode: 'signin', grant: approve(ch) }), /not started in this browser/);
assert.equal(posts.length, 1);
pass('our own start completes, carrying the typed number, and only once');

// 5. A start older than ten minutes is forgotten.
const old = await ws.prepareTapitFlow('signin');
const oldCh = issued.at(-1);
const pend = JSON.parse(store.get('dt:tapitPending:v1'));
store.set('dt:tapitPending:v1', JSON.stringify(pend.map(p => p.nonce === oldCh.nonce ? { ...p, at: Date.now() - 11 * 60 * 1000 } : p)));
await assert.rejects(ws.completeTapitCallback({ mode: 'signin', grant: approve(oldCh) }), /not started in this browser/);
assert.ok(old.screenCode);
pass('a sign-in started more than ten minutes ago is not finished');

console.log(`tapit-binding tests passed (${n} cases)`);
