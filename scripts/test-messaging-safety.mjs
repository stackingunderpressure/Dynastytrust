/**
 * Threat model item E: messaging safety codes and key pins
 * (apps/web/src/lib/messaging-safety.ts). Wired into npm test.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-messaging-safety.mjs
 */
import assert from 'node:assert/strict';
import { x25519 } from '@noble/curves/ed25519';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const s = await import('../apps/web/src/lib/messaging-safety.ts');
let n = 0; const pass = l => { n++; console.log(`  [ok] ${l}`); };
const hex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const pub = () => hex(x25519.getPublicKey(x25519.utils.randomPrivateKey()));

const dad = pub(), mom = pub(), attacker = pub();

// 1. Both phones show the same code; the format is speakable.
const code = s.safetyCode(dad, mom);
assert.equal(code, s.safetyCode(mom, dad), 'order must not matter');
assert.equal(code, s.safetyCode(dad.toUpperCase(), ` ${mom} `), 'case and spaces must not matter');
assert.match(code, /^\d{4} \d{4} \d{4}$/);
pass(`same code on both phones, three groups of four digits (${code.length} chars)`);

// 2. A swapped key gives a different code, every time, for 200 tries.
for (let i = 0; i < 200; i++) assert.notEqual(s.safetyCode(dad, pub()), code);
assert.notEqual(s.safetyCode(dad, attacker), code);
pass('a swapped key never gives the same code (200 random keys)');

// 3. Known answer, so a change to the derivation is caught: both phones
//    must keep computing exactly this.
const A = '11'.repeat(32), B = '22'.repeat(32);
const fixed = s.safetyCode(A, B);
assert.equal(fixed, s.safetyCode(B, A));
assert.equal(fixed, '0633 3438 5720', 'derivation changed: both phones must agree');
console.log(`    known answer for 11..11 / 22..22: ${fixed}`);
pass('known-answer pair computed');

// 4. First sight pins, not yet compared; same key stays; a change is caught.
assert.equal(s.peerKeyStatus('v1', 'mom', mom), 'not_compared');
assert.equal(s.peerKeyStatus('v1', 'mom', mom), 'not_compared');
assert.equal(s.peerKeyStatus('v1', 'mom', attacker), 'changed');
assert.equal(s.peerKeyStatus('v1', 'mom', attacker), 'changed', 'a changed key is never silently re-pinned');
pass('first key is remembered; a swapped key reads "changed" and stays that way');

// 5. Comparing by voice accepts THAT key; messages are checked against it.
s.markPeerKeyCompared('v1', 'mom', attacker); // e.g. she really did make a new key
assert.equal(s.peerKeyStatus('v1', 'mom', attacker), 'compared');
assert.equal(s.peerKeyStatus('v1', 'mom', mom), 'changed');
assert.equal(s.senderKeyMatches('v1', 'mom', attacker), true);
assert.equal(s.senderKeyMatches('v1', 'mom', mom), false);
assert.equal(s.senderKeyMatches('v1', 'nobody', mom), null);
pass('accepting a key after comparing it replaces the remembered one; senders are checked against it');

// 6. Pins are per vault.
assert.equal(s.peerKeyStatus('v2', 'mom', mom), 'not_compared');
pass('each vault remembers its own keys');

console.log(`messaging-safety tests passed (${n} cases)`);
