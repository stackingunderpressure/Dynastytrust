/**
 * test-mfa.mjs -- proves the two-step sign-in rules: the browser's
 * decision (apps/web/src/lib/mfa-rules.ts) and the server's
 * (netlify/functions/_auth.js aalSatisfied). Wired into `npm test`.
 *
 * These are the rules only. The Supabase MFA calls themselves (enroll,
 * challenge, verify, the admin factor lookup) are NOT exercised here --
 * they need a real account on the live project.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-mfa.mjs
 */
import assert from 'node:assert/strict';
import { mfaDecision, normalizeTotpCode } from '../apps/web/src/lib/mfa-rules.ts';

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
const { aalSatisfied } = await import('../netlify/functions/_auth.js');

let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// browser: challenge only when the account has a factor and the session has not used it
assert.equal(mfaDecision('aal1', 'aal2'), 'challenge');
assert.equal(mfaDecision('aal2', 'aal2'), 'ok');
assert.equal(mfaDecision('aal1', 'aal1'), 'ok');
assert.equal(mfaDecision(null, 'aal2'), 'challenge');
assert.equal(mfaDecision(undefined, undefined), 'ok');
pass('browser asks for the code exactly when a factor exists and the session has not proven it');

assert.equal(normalizeTotpCode('123456'), '123456');
assert.equal(normalizeTotpCode(' 123 456 '), '123456');
for (const bad of ['12345', '1234567', '12345a', '', 'abcdef']) assert.equal(normalizeTotpCode(bad), null, bad);
pass('only a 6-digit code is ever sent');

// server: a password-only token is refused once the account has a factor
assert.equal(aalSatisfied('aal2', true), true);
assert.equal(aalSatisfied('aal2', false), true);
assert.equal(aalSatisfied('aal1', false), true);
assert.equal(aalSatisfied('aal1', true), false, 'password-only token must be refused');
assert.equal(aalSatisfied(undefined, true), false, 'a token with no aal claim must be refused');
assert.equal(aalSatisfied('aal3-made-up', true), false);
pass('server refuses a password-only session for an account with a verified factor');

console.log(`mfa tests passed (${n} cases)`);
