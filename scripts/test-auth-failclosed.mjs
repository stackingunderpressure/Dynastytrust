/**
 * test-auth-failclosed.mjs -- threat model item C: when the two-step
 * factor lookup fails, _auth.js must NOT treat the account as having no
 * second step (that let a password-only session through); it reports
 * "unknown" and requireUser refuses. A failure is never cached.
 * Wired into npm test.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-auth-failclosed.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
let mode = 'fail';
mock.module(new URL('../netlify/functions/_supabase.js', import.meta.url).href, { namedExports: { getSupabaseAdmin: () => ({ auth: { admin: { mfa: { listFactors: async () => {
  if (mode === 'fail') throw new Error('lookup down');
  return { data: { factors: mode === 'has' ? [{ status: 'verified' }] : [] }, error: null };
} } } } }) } });
const { hasVerifiedFactor, aalSatisfied } = await import('../netlify/functions/_auth.js');
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

assert.equal(await hasVerifiedFactor('u1'), null, 'a failed lookup is unknown, not "no factor"');
mode = 'has';
assert.equal(await hasVerifiedFactor('u1'), true, 'a failure is not cached: the next request asks again');
mode = 'none';
assert.equal(await hasVerifiedFactor('u2'), false);
pass('a failed factor lookup is "unknown" (refused), never cached; a working lookup answers');

assert.equal(aalSatisfied('aal1', true), false);
assert.equal(aalSatisfied('aal1', false), true);
pass('with an answer, the rule is unchanged');

console.log(`auth-failclosed tests passed (${n} cases)`);
