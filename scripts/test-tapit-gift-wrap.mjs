/**
 * Phase 1 of tapit-wallet docs/NOSTR_METADATA_PLAN.md: Tapit's answers to
 * DynastyTrust arrive gift-wrapped so relays can't see which wallet answered.
 * Opens a REAL wrapped answer built by tapit-wallet's own code
 * (scripts/fixtures/tapit-gift-wrapped-answer.json, byte-identical in both
 * repos) with apps/web/src/lib/tapit-gift-wrap.ts. Wired into npm test.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-tapit-gift-wrap.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decryptFrom } from '@dynastytrust/nip44';

const f = JSON.parse(readFileSync(new URL('./fixtures/tapit-gift-wrapped-answer.json', import.meta.url), 'utf8'));
const { openTapitAnswer } = await import('../apps/web/src/lib/tapit-gift-wrap.ts');
let n = 0; const pass = l => { n++; console.log(`  [ok] ${l}`); };
const keyFor = p => (p === f.replyPublicKey ? f.replyPrivateKey : undefined);

// 1. Relays see a throwaway key, not the wallet.
assert.equal(f.wrapped.kind, 1059);
assert.notEqual(f.wrapped.pubkey, f.walletPubkey);
assert.ok(!JSON.stringify(f.wrapped).includes(f.walletPubkey), 'wallet key must not appear on the outside');
pass('the wrapped answer shows no wallet key to relays');

// 2. Opening it gives back the exact signed answer from the wallet.
const inner = await openTapitAnswer(f.wrapped, f.innerKind, keyFor);
assert.ok(inner, 'wrapped answer must open');
assert.deepEqual(inner, f.plain);
assert.equal(inner.pubkey, f.walletPubkey);
assert.equal(decryptFrom(inner.content, inner.pubkey, f.replyPrivateKey), f.payload);
pass('opens to the identical signed answer, still decryptable as before');

// 3. A plain (old-form) answer passes straight through.
assert.deepEqual(await openTapitAnswer(f.plain, f.innerKind, keyFor), f.plain);
pass('plain answers still accepted');

// 4. A stolen answer re-sealed by another wallet is refused.
assert.equal(await openTapitAnswer(f.forgedReseal, f.innerKind, keyFor), null);
pass('re-sealed stolen answer refused');

// 5. Not our reply key, wrong kind, or a tampered wrap: refused.
assert.equal(await openTapitAnswer(f.wrapped, f.innerKind, () => undefined), null);
assert.equal(await openTapitAnswer(f.wrapped, 9582, keyFor), null);
assert.equal(await openTapitAnswer({ ...f.wrapped, content: f.wrapped.content.slice(0, -4) + 'AAAA' }, f.innerKind, keyFor), null);
assert.equal(await openTapitAnswer({ ...f.plain, kind: 1 }, f.innerKind, keyFor), null);
pass('wrong key, wrong kind, tampered or unrelated events refused');

// 6. Through the real spend channel: it listens for both forms and reports
//    the wallet (not the throwaway key) as the signer.
const { subscribePsbtCosignResponses } = await import('../apps/web/src/lib/psbt-cosign-response-channel.ts');
let filter, handler;
const fake = { subscribe: (fl, h) => { filter = fl; handler = h; return { close() {} }; } };
const got = [];
subscribePsbtCosignResponses(fake, f.replyPrivateKey, r => got.push(r));
assert.deepEqual(filter.kinds, [9579, 1059]);
handler(f.wrapped);
handler(f.forgedReseal);
await new Promise(r => setTimeout(r, 50));
assert.equal(got.length, 1);
assert.equal(got[0].signerPubkey, f.walletPubkey);
assert.equal(got[0].psbtHex, '70736274ff');
assert.equal(got[0].eventId, f.plain.id);
pass('spend channel takes the wrapped answer, reports the wallet as signer, drops the forgery');

console.log(`tapit gift wrap: ${n} checks passed`);
