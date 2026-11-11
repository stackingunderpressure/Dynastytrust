/**
 * test-keystore-restore.mjs -- proves a key can be brought back from its
 * written recovery phrase (apps/web/src/lib/keystore.ts,
 * restoreKeyFromWords), and that it comes back as EXACTLY the key that
 * was lost: same xpub, same signing pubkey, same fingerprints. Until
 * 2026-11-11 the app had no way to do this at all. Wired into `npm test`.
 *
 * keystore.ts is browser code; the only browser global it touches is
 * localStorage, shimmed here with an in-memory map.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-keystore-restore.mjs
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const ks = await import('../apps/web/src/lib/keystore.ts');

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const identity = (k) => ({ xpub: k.xpub, pubkey: k.pubkey, fingerprint: k.fingerprint, masterFingerprint: k.masterFingerprint, derivationPath: k.derivationPath, network: k.network });
const wipe = () => store.clear();

// 1. The lost-phone case, real coins: make a key, lose the browser, type
//    the words on a new one. It must be the same key in every respect.
const made = await ks.generateSoftwareKey({ label: 'Dad', network: 'mainnet', password: 'first-password', persona: 'Dad' });
const lost = identity(made.key);
wipe();
assert.equal(ks.listAllKeys().length, 0);
const back = await ks.restoreKeyFromWords({ label: 'Dad (restored)', network: 'mainnet', persona: 'Dad', words: made.mnemonic, password: 'a-new-password' });
assert.deepEqual(identity(back.key), lost);
assert.equal(back.upgraded, false);
assert.equal(back.key.origin, 'software');
assert.equal(back.key.backedUp, true);
assert.equal(back.key.testMnemonic, undefined, 'a real-bitcoin seed is never stored in plain text');
assert.equal(await ks.revealMnemonic(back.key.keyId, 'a-new-password'), made.mnemonic);
await assert.rejects(ks.revealMnemonic(back.key.keyId, 'first-password'));
assert.equal(ks.keySigningBlockedReason(back.key), null);
pass('a mainnet key restored from its words on an empty browser is the same key: xpub, signing pubkey and both fingerprints');

// 2. A publicly known answer, independent of our own generator: the
//    standard BIP39 test phrase has master fingerprint 73c5da0a.
wipe();
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const known = await ks.restoreKeyFromWords({ label: 'vector', network: 'signet', persona: 'v', words: ABANDON });
assert.equal(known.key.masterFingerprint, '73c5da0a');
assert.equal(known.key.derivationPath, "m/48'/1'/0'/2'");
assert.equal(known.key.testMnemonic, ABANDON);
pass('the standard BIP39 test phrase restores to its published master fingerprint 73c5da0a');

// 3. How people actually type: capitals, line breaks, a numbered list.
wipe();
const messy = made.mnemonic.split(' ').map((w, i) => `${i + 1}. ${i % 3 === 0 ? w.toUpperCase() : w}`).join(',\n  ');
const tidy = await ks.restoreKeyFromWords({ label: 'Dad', network: 'mainnet', persona: 'Dad', words: `\n ${messy} \n`, password: 'a-new-password' });
assert.deepEqual(identity(tidy.key), lost);
const seen = ks.inspectRecoveryWords('Apple  aple\nzoo');
assert.deepEqual(seen.unknown, [{ position: 2, word: 'aple' }]);
assert.equal(seen.words.length, 3); assert.equal(seen.lengthOk, false); assert.equal(seen.valid, false);
assert.equal(ks.inspectRecoveryWords(made.mnemonic).valid, true);
pass('capitals, extra spaces, line breaks and a pasted numbered list are all read as the same words');

// 4. Wrong words are refused with a message that says which and why,
//    and nothing is stored.
wipe();
const w = made.mnemonic.split(' ');
const attempt = (words, extra = {}) => ks.restoreKeyFromWords({ label: 'x', network: 'mainnet', persona: 'x', words, password: 'a-new-password', ...extra });
await assert.rejects(attempt([...w.slice(0, 4), 'aple', ...w.slice(5)].join(' ')), /Word 5 \("aple"\) is not a recovery word/);
await assert.rejects(attempt(w.slice(0, 23).join(' ')), /12 or 24 words\. This has 23/);
// Two words in the wrong order: about 1 swap in 256 still passes the
// phrase's built-in checksum, so pick one that does not.
let swapped = null;
for (let i = 0; i < 23 && !swapped; i++) {
  const c = [...w]; [c[i], c[i + 1]] = [c[i + 1], c[i]];
  if (c[i] !== c[i + 1] && !ks.inspectRecoveryWords(c.join(' ')).valid) swapped = c;
}
assert.ok(swapped);
await assert.rejects(attempt(swapped.join(' ')), /not a valid phrase/);
await assert.rejects(attempt(''), /This has 0/);
await assert.rejects(attempt(made.mnemonic, { password: '' }), /must be protected with a password/);
await assert.rejects(attempt(made.mnemonic, { password: 'short' }), /at least 8 characters/);
assert.equal(ks.listAllKeys().length, 0, 'a refused restore must leave nothing behind');
pass('a misspelt word, a missing word, swapped words, no password on mainnet and a short password are refused; nothing is stored');

// 5. Already here: no duplicate.
await attempt(made.mnemonic);
await assert.rejects(attempt(made.mnemonic), /already in this browser as "x"/);
assert.equal(ks.listAllKeys().length, 1);
pass('restoring a key that already holds its seed here is refused rather than duplicated');

// 6. The new-phone path: "Import JSON" brings public keys only; typing
//    the words upgrades THAT row in place and keeps its name -- even when
//    the person picks the wrong network in the form.
wipe();
const orig = await ks.generateSoftwareKey({ label: "Mum's key", network: 'mainnet', password: 'first-password', persona: 'Mum' });
const file = ks.exportKeyring();
assert.ok(!file.includes(orig.mnemonic.split(' ')[0] + ' ' + orig.mnemonic.split(' ')[1]), 'the export never carries the words');
wipe();
assert.equal(ks.importKeyringJson(file), 1);
const publicOnly = ks.listAllKeys()[0];
assert.equal(publicOnly.origin, 'imported_xpub');
await assert.rejects(ks.restoreKeyFromWords({ label: 'whatever', network: 'signet', persona: 'w', words: orig.mnemonic }), /belong to your real-bitcoin key "Mum's key".*password/);
const up = await ks.restoreKeyFromWords({ label: 'whatever', network: 'signet', persona: 'w', words: orig.mnemonic, password: 'a-new-password' });
assert.equal(up.upgraded, true);
assert.equal(up.key.keyId, orig.key.keyId);
assert.equal(up.key.label, "Mum's key");
assert.deepEqual(identity(up.key), identity(orig.key));
assert.equal(ks.listAllKeys().length, 1);
assert.equal(await ks.revealMnemonic(up.key.keyId, 'a-new-password'), orig.mnemonic);
pass('a public-only row from Import JSON is upgraded in place with its name kept, on its own network, not duplicated');

// 7. Test coins need no password; the same words on real coins are a
//    DIFFERENT key; and one set of words is kept in a browser only once,
//    so a real-money seed can never sit in plain text beside a test twin.
wipe();
const t = await ks.restoreKeyFromWords({ label: 't', network: 'testnet', persona: 't', words: ABANDON });
await assert.rejects(ks.restoreKeyFromWords({ label: 't2', network: 'signet', persona: 't', words: ABANDON }), /already in this browser as "t"\. Nothing to restore/);
await assert.rejects(ks.restoreKeyFromWords({ label: 'm', network: 'mainnet', persona: 'm', words: ABANDON, password: 'a-new-password' }), /already in this browser as "t", a test-coin key/);
assert.equal(ks.listAllKeys().length, 1);
wipe();
const m = await ks.restoreKeyFromWords({ label: 'm', network: 'mainnet', persona: 'm', words: ABANDON, password: 'a-new-password' });
assert.notEqual(t.key.pubkey, m.key.pubkey);
assert.equal(t.key.masterFingerprint, m.key.masterFingerprint);
await assert.rejects(ks.restoreKeyFromWords({ label: 't', network: 'signet', persona: 't', words: ABANDON }), /already in this browser as "m", a real-bitcoin key/);
assert.equal(ks.listAllKeys().length, 1);
pass('test coins need no password; the same words are a different key on real coins; one set of words is kept only once');

console.log(`keystore-restore tests passed (${n} cases)`);
