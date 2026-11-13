/**
 * Threat model item I (docs/threat-model-2026-11-13.md): secrets stored on
 * the server under a human password -- saved circle phrases (including the
 * duress phrase) and the messaging-key backup -- must be locked with the
 * real-bitcoin password rule, because a database leak allows offline
 * guessing at the attacker's own speed. Blobs locked earlier with a weaker
 * password must still open.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-secret-passphrase.mjs
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

let n = 0;
const pass = l => { n++; console.log(`  [ok] ${l}`); };

const ss = await import('../apps/web/src/lib/sent-secrets.ts');
const msg = await import('../apps/web/src/lib/messaging.ts');
const ks = await import('../apps/web/src/lib/keystore.ts');

// 1. Weak passwords are refused before anything is encrypted or sent.
for (const weak of ['short1', 'eightchr', 'password1234', 'aaaaaaaaaaaaaaa', '123456789012']) {
  await assert.rejects(ss.wrapSentSecret({ normalPhrase: 'a', duressPhrase: 'b' }, weak), /needs a password|repeats itself|simple run|first words/, `saved secret took "${weak}"`);
  await assert.rejects(msg.wrapMessagingKeyForBackup(weak), /needs a password|repeats itself|simple run|first words/, `messaging backup took "${weak}"`);
}
pass('weak passwords refused for saved secrets and the messaging backup (5 each)');

// 2. A strong password works, and round-trips.
const PW = 'harbor lantern quiet mule';
const blob = await ss.wrapSentSecret({ normalPhrase: 'blue heron', duressPhrase: 'red fox' }, PW);
assert.deepEqual(await ss.unwrapSentSecret(blob, PW), { normalPhrase: 'blue heron', duressPhrase: 'red fox' });
const { blob: mb, pubkey } = await msg.wrapMessagingKeyForBackup(PW);
assert.equal((await msg.unwrapMessagingKeyFromBackup(mb, PW)).pub, pubkey);
pass('a strong password locks and opens both');

// 3. An older blob made under a weak password still opens (made directly
//    through keystore, as the app did before this rule).
const old = await ks.encryptText(JSON.stringify({ normalPhrase: 'old' }), 'eightchr');
assert.deepEqual(await ss.unwrapSentSecret(old, 'eightchr'), { normalPhrase: 'old' });
pass('a secret saved earlier under a weaker password still opens');

console.log(`secret-passphrase tests passed (${n} cases)`);
