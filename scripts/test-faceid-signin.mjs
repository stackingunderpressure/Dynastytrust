/**
 * test-faceid-signin.mjs -- Face ID sign-in on this phone
 * (apps/web/src/lib/faceid-signin.ts) with a SIMULATED passkey and
 * Supabase's password sign-in stood in. The real Face ID prompt is NOT
 * exercised here (the browser walk uses a virtual authenticator).
 * Wired into npm test.
 *
 * Run:  node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/register-ts-resolver.mjs scripts/test-faceid-signin.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { PublicKeyCredential: function () {} };
Object.defineProperty(globalThis, 'navigator', { value: { credentials: { create() {} } }, configurable: true });
let realPassword = 'river-copper-lantern-58';
const signIns = [];
mock.module(new URL('../apps/web/src/lib/supabase.ts', import.meta.url).href, { namedExports: { supabase: { auth: {
  signInWithPassword: async ({ email, password }) => { signIns.push({ email, password }); return { error: password === realPassword ? null : { message: 'Invalid login credentials' } }; },
} } } });
const f = await import('../apps/web/src/lib/faceid-signin.ts');
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
function fakePasskey() {
  const creds = new Map();
  return { async create() { const id = randomBytes(16).toString('base64'); creds.set(id, randomBytes(32)); return { credentialIdB64: id }; },
    async evaluate(id, salt) { if (!creds.has(id)) throw new Error('unknown credential'); return new Uint8Array(createHmac('sha256', creds.get(id)).update(Buffer.from(salt, 'base64')).digest()); } };
}
const ADDR = 'grandpa.joe@users.dynastytrust.family';

// 1. Decline: nothing kept.
f.offerFaceIdFor(ADDR, 'grandpa.joe', realPassword);
assert.deepEqual(f.pendingFaceIdOffer(), { label: 'grandpa.joe' });
f.declineFaceIdOffer();
assert.equal(f.pendingFaceIdOffer(), null);
await assert.rejects(f.acceptFaceIdOffer(fakePasskey()), /again/);
assert.equal(f.savedFaceIdSignIn(), null);
pass('"Not now" keeps nothing, not even in memory');

// 2. Accept: only a locked copy is stored; Face ID signs in with it.
const pk = fakePasskey();
f.offerFaceIdFor(ADDR, 'grandpa.joe', realPassword);
await f.acceptFaceIdOffer(pk);
assert.equal(f.pendingFaceIdOffer(), null, 'the password leaves memory once answered');
assert.deepEqual(f.savedFaceIdSignIn(), { address: ADDR, label: 'grandpa.joe' });
assert.equal([...store.values()].some(v => v.includes(realPassword)), false, 'password readable in storage');
await f.signInWithFaceId(pk);
assert.deepEqual(signIns.at(-1), { email: ADDR, password: realPassword });
pass('"Use Face ID": nothing readable stored; one prompt signs in with the saved password');

// 3. Already on for this account: no second offer.
f.offerFaceIdFor(ADDR, 'grandpa.joe', realPassword);
assert.equal(f.pendingFaceIdOffer(), null);
pass('no repeat offer once Face ID sign-in is on for that account');

// 4. Another passkey cannot open it; a changed password turns it off with a plain reason.
await assert.rejects(f.signInWithFaceId(fakePasskey()), /unknown credential/);
await assert.rejects(f.signInWithFaceId({ async evaluate() { return new Uint8Array(randomBytes(32)); } }), /could not open/);
realPassword = 'a-brand-new-password-77';
await assert.rejects(f.signInWithFaceId(pk), /password has changed/);
assert.equal(f.savedFaceIdSignIn(), null, 'a stale saved password is forgotten');
pass('a different passkey cannot open it; a changed password turns it off with a plain reason');

// 5. Turn off.
f.offerFaceIdFor(ADDR, 'grandpa.joe', realPassword);
await f.acceptFaceIdOffer(pk);
f.forgetFaceIdSignIn();
assert.equal(f.savedFaceIdSignIn(), null);
await assert.rejects(f.signInWithFaceId(pk), /not set up/);
pass('turning it off deletes the locked copy');

console.log(`faceid-signin tests passed (${n} cases)`);
