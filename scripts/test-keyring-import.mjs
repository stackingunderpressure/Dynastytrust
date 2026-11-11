/**
 * test-keyring-import.mjs -- proves the keyring file and the stored seed
 * blobs cannot be used to slip a wrong key or a wrong seed into this
 * browser (apps/web/src/lib/keystore.ts). These are the attacks the
 * 2026-11-10 adversarial review demonstrated. Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-keyring-import.mjs
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const ks = await import('../apps/web/src/lib/keystore.ts');
const all = () => JSON.parse([...store.values()][0] ?? '[]');
const put = (keys) => store.set([...store.keys()][0], JSON.stringify(keys));

let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// Alice's real public key data, and an attacker's.
const alice = ks.generateTestKey({ label: 'Alice', network: 'signet', persona: 'Alice' }).key;
const mallory = ks.generateTestKey({ label: 'Mallory', network: 'signet', persona: 'Mallory' });
const exported = JSON.parse(ks.exportKeyring());
store.clear(); ks.generateTestKey({ label: 'me', network: 'signet', persona: 'me' }); // a fresh browser

// 1. The headline attack: Alice's xpub and name, the attacker's pubkey.
const aliceEntry = exported.keys.find(k => k.label === 'Alice');
const tampered = { ...aliceEntry, pubkey: mallory.key.pubkey, fingerprint: 'deadbeef' };
assert.equal(ks.importKeyringJson(JSON.stringify({ keys: [tampered] })), 1);
const got = ks.getKey(alice.keyId);
assert.equal(got.xpub, alice.xpub);
assert.equal(got.pubkey, alice.pubkey, 'the vault would have been built with the ATTACKER\'S key');
assert.equal(got.fingerprint, alice.fingerprint);
assert.equal(got.origin, 'imported_xpub', 'no seed came with it, so it is a public key here');
pass('a swapped pubkey in the file is ignored: the signing key is recomputed from the xpub');

// 2. No form of seed is accepted from a file; marks survive; flags are not taken from the file.
const planted = { ...exported.keys.find(k => k.label === 'Mallory'), keyId: 'planted-1', origin: 'software',
  testMnemonic: mallory.mnemonic, encryptedMnemonic: { version: 1, saltB64: 'AA==', nonceB64: 'AA==', ciphertextB64: 'AA==' },
  passkeyMnemonic: { version: 1, credentialIdB64: 'AA==', prfSaltB64: 'AA==', nonceB64: 'AA==', ciphertextB64: 'AA==' },
  status: 'compromised', evil: { nested: true }, __proto__: { polluted: true } };
assert.equal(ks.importKeyringJson(JSON.stringify({ keys: [planted] })), 1);
const p1 = all().find(k => k.keyId === 'planted-1');
for (const f of ['testMnemonic', 'encryptedMnemonic', 'passkeyMnemonic', 'evil']) assert.equal(f in p1, false, `${f} came in from a file`);
assert.equal(p1.status, 'compromised', 'a compromised mark must survive import');
assert.equal(({}).polluted, undefined);
await assert.rejects(ks.revealMnemonic('planted-1'), /no mnemonic stored|No mnemonic/i);
pass('planted seeds and unknown fields are dropped; a compromised mark is kept');

// 3. Junk is skipped, duplicates inside one file are added once, existing keys are never overwritten.
const before = all().length;
const good = { ...exported.keys.find(k => k.label === 'Mallory'), keyId: 'dup-1' };
const added = ks.importKeyringJson(JSON.stringify({ keys: [
  good, { ...good, label: 'second copy' },                       // same keyId twice
  { ...good, keyId: 'bad-xpub', xpub: 'tpubNOTREAL' },
  { ...good, keyId: 'wrong-net', network: 'mainnet' },           // tpub claimed as mainnet
  { ...good, keyId: 'bad-path', derivationPath: "m/48'/1'/../x" },
  { ...good, keyId: 'no-label', label: 42 },
  { ...aliceEntry, label: 'OVERWRITE' },                         // existing keyId
  null, 'string', 7,
  { keyId: 't1', label: 'tap', network: 'signet', origin: 'tapit', pubkey: '02' + 'ab'.repeat(32) },
  { keyId: 't2', label: 'tap bad', network: 'signet', origin: 'tapit', pubkey: 'zz' },
] }));
assert.equal(added, 2, 'exactly the one valid xpub key and the one valid Tapit key');
assert.equal(all().length, before + 2);
assert.equal(ks.getKey('dup-1').label, 'Mallory');
assert.equal(ks.getKey(alice.keyId).label, 'Alice', 'an existing key was overwritten');
assert.equal(ks.getKey('t1').tapitXOnlyPubkey, 'ab'.repeat(32));
pass('invalid xpubs, wrong networks, bad paths, duplicates and overwrites are all refused');

// 4. The export never carries a seed in any form.
store.clear();
const sec = await ks.generateSoftwareKey({ label: 's', network: 'signet', password: 'maple-ridge-lantern-42', persona: 's' });
const tst = ks.generateTestKey({ label: 't', network: 'signet', persona: 't' });
ks.markBackedUp(tst.key.keyId);
const fake = { async create() { return { credentialIdB64: 'AAAA' }; }, async evaluate() { return new Uint8Array(32).fill(9); } };
await ks.protectKeyWithPasskey(tst.key.keyId, { prf: fake });
const out = ks.exportKeyring();
for (const f of ['testMnemonic', 'encryptedMnemonic', 'passkeyMnemonic', 'ciphertextB64']) assert.equal(out.includes(f), false, `export contains ${f}`);
pass('export strips plaintext, password-wrapped and passkey-wrapped seeds');

// 5. A seed blob moved onto another key is refused at unlock.
const other = await ks.generateSoftwareKey({ label: 'o', network: 'signet', password: 'maple-ridge-lantern-42', persona: 'o' });
const keys = all();
const a = keys.find(k => k.keyId === sec.key.keyId), b = keys.find(k => k.keyId === other.key.keyId);
a.encryptedMnemonic = b.encryptedMnemonic;
put(keys);
await assert.rejects(ks.revealMnemonic(sec.key.keyId, 'maple-ridge-lantern-42'), /does not belong to it/);
assert.equal(await ks.revealMnemonic(other.key.keyId, 'maple-ridge-lantern-42'), other.mnemonic, 'the untouched key must still unlock');
// ... and a planted plaintext seed on a real key is refused the same way.
const keys2 = all(); const c = keys2.find(k => k.keyId === other.key.keyId);
c.testMnemonic = tst.mnemonic; delete c.encryptedMnemonic; put(keys2);
await assert.rejects(ks.revealMnemonic(other.key.keyId), /does not belong to it/);
pass('a seed swapped or planted under another key is refused instead of signed with');

// 6. Password stretching: new blobs record 600,000 rounds; a pre-existing 210,000-round blob still opens.
const fresh = await ks.encryptText('hello', 'pw');
assert.equal(fresh.iterations, 600_000);
assert.equal(await ks.decryptBlob(fresh, 'pw'), 'hello');
const salt = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12));
const k210 = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' },
  await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveKey']),
  { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k210, new TextEncoder().encode('old blob')));
const b64 = (u) => Buffer.from(u).toString('base64');
const legacy = { version: 1, saltB64: b64(salt), nonceB64: b64(nonce), ciphertextB64: b64(ct) };
assert.equal(await ks.decryptBlob(legacy, 'pw'), 'old blob', 'keys saved before this change must still unlock');
await assert.rejects(ks.decryptBlob({ ...fresh, iterations: 1 }, 'pw'));
pass('new password blobs use 600,000 rounds; blobs saved before still open; a downgraded count is refused');

console.log(`keyring-import tests passed (${n} cases)`);
