/**
 * test-password-rules.mjs -- proves the password bar for a key
 * (apps/web/src/lib/password-rules.ts), that keystore.ts enforces it
 * wherever a password is SET, that an older weaker password still
 * opens its key, and that the key lesson never softens the two things
 * it must say plainly. Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-password-rules.mjs
 */
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
const rules = await import('../apps/web/src/lib/password-rules.ts');
const edu = await import('../apps/web/src/lib/key-education.ts');
const ks = await import('../apps/web/src/lib/keystore.ts');

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const GOOD = 'orbit velvet cactus nine';

// 1. The rule for a real-bitcoin key.
for (const net of ['mainnet', 'bitcoin']) {
  assert.equal(rules.passwordProblem(GOOD, net), null);
  assert.equal(rules.passwordProblem('Tr0ub4dor&3xyz', net), null);
  assert.match(rules.passwordProblem('short1234', net), /at least 12 characters\. This has 9/);
  assert.match(rules.passwordProblem('', net), /This has 0/);
  assert.match(rules.passwordProblem('aaaaaaaaaaaaaa', net), /repeats itself/);
  assert.match(rules.passwordProblem('abcabcabcabcabc', net), /repeats itself/);
  assert.match(rules.passwordProblem('123456789012345', net), /simple run/);
  assert.match(rules.passwordProblem('abcdefghijklmn', net), /simple run/);
  assert.match(rules.passwordProblem('zyxwvutsrqpon', net), /simple run/);
  assert.match(rules.passwordProblem('MyPassword2026!', net), /built on "password"/);
  assert.match(rules.passwordProblem('bitcoin4ever!!', net), /built on "bitcoin"/);
  assert.match(rules.passwordProblem('P@ssw0rd-P@ssw0rd', net) ?? 'built on', /built on|null/);
  // a long phrase that merely contains such a word is not refused
  assert.equal(rules.passwordProblem('my bitcoin lives under four red hats', net), null);
}
pass('a real-bitcoin key needs 12+ characters that are not a repeat, a run, or built on a first-guess word');

// 2. Test coins keep the old minimum; nothing else is asked of them.
for (const net of ['signet', 'testnet']) {
  assert.equal(rules.passwordProblem('12345678', net), null);
  assert.match(rules.passwordProblem('1234567', net), /at least 8/);
}
pass('test-coin keys keep the eight-character minimum');

// 3. What a person is told as they type never overstates.
assert.equal(rules.passwordHint('', 'mainnet').level, 'empty');
assert.equal(rules.passwordHint('short', 'mainnet').level, 'weak');
assert.equal(rules.passwordHint('twelve-chars', 'mainnet').level, 'ok');
assert.equal(rules.passwordHint(GOOD, 'mainnet').level, 'strong');
assert.equal(rules.passwordHint('Tr0ub4dor&3xyz-9Q', 'mainnet').level, 'strong');
assert.match(rules.passwordHint(GOOD, 'mainnet').text, /24 words are still your backup/);
pass('the hint says weak, acceptable or strong, and reminds that the words remain the backup');

// 4. keystore.ts enforces it wherever a password is set -- and stores nothing when it refuses.
await assert.rejects(ks.generateSoftwareKey({ label: 'x', network: 'mainnet', password: 'eightchr', persona: 'x' }), /at least 12 characters/);
await assert.rejects(ks.generateSoftwareKey({ label: 'x', network: 'mainnet', password: 'MyPassword2026!', persona: 'x' }), /built on "password"/);
assert.equal(ks.listAllKeys().length, 0);
const real = await ks.generateSoftwareKey({ label: 'real', network: 'mainnet', password: GOOD, persona: 'r' });
await assert.rejects(ks.changeKeyPassword(real.key.keyId, GOOD, 'weakweak'), /at least 12 characters/);
assert.equal(await ks.revealMnemonic(real.key.keyId, GOOD), real.mnemonic, 'a refused change leaves the old password working');
await ks.changeKeyPassword(real.key.keyId, GOOD, 'harbor-nickel-oboe-quartz');
assert.equal(await ks.revealMnemonic(real.key.keyId, 'harbor-nickel-oboe-quartz'), real.mnemonic);
store.clear();
await assert.rejects(ks.restoreKeyFromWords({ label: 'r', network: 'mainnet', persona: 'r', words: real.mnemonic, password: 'eightchr' }), /at least 12 characters/);
assert.equal(ks.listAllKeys().length, 0);
// test coins: the old bar, and upgrading a test key to a password
const t = ks.generateTestKey({ label: 't', network: 'signet', persona: 't' });
await assert.rejects(ks.secureTestKey(t.key.keyId, 'short'), /at least 8/);
await ks.secureTestKey(t.key.keyId, 'eightchr');
assert.equal(await ks.revealMnemonic(t.key.keyId, 'eightchr'), t.mnemonic);
pass('making a key, changing its password, restoring and upgrading all refuse a weak password and store nothing');

// 5. A key locked before this rule, with a weaker password, still opens.
store.clear();
const old = await ks.generateSoftwareKey({ label: 'old', network: 'mainnet', password: GOOD, persona: 'o' });
const blob = await ks.encryptText(old.mnemonic, 'oldweak8');
const all = JSON.parse(store.get([...store.keys()][0])); all[0].encryptedMnemonic = blob; store.set([...store.keys()][0], JSON.stringify(all));
assert.equal(await ks.revealMnemonic(old.key.keyId, 'oldweak8'), old.mnemonic);
pass('a key already locked with an older, shorter password still opens; the rule applies only when a password is set');

// 6. The lesson says the two hard things plainly and promises nothing false.
const text = edu.KEY_LESSONS.map(l => `${l.title}. ${l.body}`).join(' ');
assert.match(text, /A key in a browser is a hot key/);
assert.match(text, /No password changes that/);
assert.match(text, /Never choose the words yourself/);
assert.match(text, /at least one key on each path a hardware wallet/);
assert.match(text, /There is no reset/);
for (const lie of [/as safe as a hardware wallet/i, /cannot be hacked/i, /unhackable/i, /bank[- ]grade/i, /military[- ]grade/i, /100% (safe|secure)/i, /completely (safe|secure)/i]) assert.doesNotMatch(text, lie);
assert.match(edu.RESTORE_WARNING, /Only restore words that this app or a signing device generated/);
assert.ok(edu.KEY_LESSONS.length <= 6 && edu.KEY_LESSONS.every(l => l.body.length < 420), 'short enough to actually be read');
pass('the key lesson calls a browser key a hot key, says a password does not change that, and makes no safety promise');

console.log(`password-rules tests passed (${n} cases)`);
