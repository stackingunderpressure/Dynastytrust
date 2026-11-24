/**
 * test-membership-ranged-keys.mjs -- the xpub keys a vault-membership
 * request carries for a fresh-address vault (circle-membership-delivery.ts
 * rangedKeysForScripts; docs/tapit-fresh-address-cosign-build-note.md).
 * A real vault from the compiler wasm: path "everyday" = 1-of-2 [a Tapit
 * key, k1], path "later" = 1-of-2 [k1, k2]. The request for "everyday"
 * must carry k1 (and only k1), as the key it is at the first address --
 * the same list Tapit's own test fixture (tapit-wallet
 * src/features/sign-request/fixtures/fresh-address-vault.json, made by
 * scripts/make-tapit-fresh-fixture.mjs) signs with.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-membership-ranged-keys.mjs
 */
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const { callWasm } = await import(new URL('../netlify/functions/_ranged-wasm.js', import.meta.url).href);
const { rangedKeysForScripts } = await import(new URL('../apps/web/src/lib/circle-membership-delivery.ts', import.meta.url).href);
const { HDKey } = await import('@scure/bip32');
const { mnemonicToSeedSync } = await import('@scure/bip39');
const hex = (b) => Buffer.from(b).toString('hex');
const TESTNET = { private: 0x04358394, public: 0x043587cf };
const PATH = "m/48'/1'/0'/2'";
const key = (m) => { const root = HDKey.fromMasterSeed(mnemonicToSeedSync(m), TESTNET); const acct = root.derive(PATH);
  return { fingerprint: root.fingerprint.toString(16).padStart(8, '0'), xpub: acct.publicExtendedKey, pubkey: hex(acct.deriveChild(0).deriveChild(0).publicKey) }; };
const k1 = key('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const k2 = key('legal winner thank year wave sausage worth useful legal winner thank yellow');
const TAPIT = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const leaves = [
  { id: 'everyday', label: 'everyday', keys: [TAPIT, k1.pubkey], quorum: 1, unlock: { type: 'immediate' } },
  { id: 'later', label: 'later', keys: [k1.pubkey, k2.pubkey], quorum: 1, unlock: { type: 'after', blocks: 900_000 } },
];
const compiled = callWasm('/compile-leaves', { network: 'signet', leaves }).body;
const ranged = callWasm('/ranged-compile', { template: compiled.descriptor, network: 'signet', origins: [k1, k2].map(k => ({ fingerprint: k.fingerprint, account_path: PATH, xpub: k.xpub })) }).body;
assert.ok(ranged.ok, JSON.stringify(ranged));

const everyday = rangedKeysForScripts(ranged.multipath, [compiled.leaf_scripts.everyday]);
assert.deepEqual(everyday, [{ xpub: k1.xpub, key00: k1.pubkey.slice(2) }]);
console.log('  [ok] the everyday request carries k1 only, as its first-address key');

const later = rangedKeysForScripts(ranged.multipath, [compiled.leaf_scripts.later]);
assert.deepEqual(later.map(k => k.xpub).sort(), [k1.xpub, k2.xpub].sort());
console.log('  [ok] the later request carries both of its xpub keys');

assert.deepEqual(rangedKeysForScripts(null, [compiled.leaf_scripts.everyday]), []);
assert.deepEqual(rangedKeysForScripts(compiled.descriptor, [compiled.leaf_scripts.everyday]), []);
console.log('  [ok] a one-address vault sends none');
console.log('membership-ranged-keys tests passed (3 cases)');
