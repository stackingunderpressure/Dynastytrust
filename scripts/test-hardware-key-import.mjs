/**
 * test-hardware-key-import.mjs -- bringing a hardware wallet's key in on
 * the join page (components/HardwareKeyImport.tsx, 2026-11-13).
 *
 * Proves, on a real key: a SeedSigner static key QR's text
 * ([fingerprint/48h/1h/0h/2h]tpub...) yields the key, fingerprint and
 * path; a bare key yields no fingerprint or path (nothing guessed); a key
 * for the other network is refused with a plain message; and the saved
 * key's signing pubkey is the /0/0 child the vault's script will name --
 * the same one the server's checkClaimedKey derives.
 */
import assert from 'node:assert/strict';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { parseXpubText, importXpub, listKeys } from '../apps/web/src/lib/keystore.ts';
import { pubkeyFromXpub } from '../netlify/functions/_xpub.js';
import { networkProblem } from '../apps/web/src/lib/key-network.ts';

globalThis.localStorage ??= (() => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })();

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const hex = (b) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const root = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), { private: 0x04358394, public: 0x043587cf });
const fp = hex(root.identifier.slice(0, 4));
const acct = root.derive("m/48'/1'/0'/2'");
const tpub = acct.publicExtendedKey;

// 1. What a SeedSigner static key QR carries.
const seedsigner = `[${fp}/48h/1h/0h/2h]${tpub}`;
const parsed = parseXpubText(seedsigner);
assert.equal(parsed.xpub, tpub);
assert.equal(parsed.fingerprint, fp);
assert.match(parsed.path, /^m\/48'\/1'\/0'\/2'$/);
// a bare key: nothing guessed
const bare = parseXpubText(tpub);
assert.deepEqual([bare.xpub, bare.path, bare.fingerprint], [tpub, null, null]);
pass('a SeedSigner static key QR gives the key, its fingerprint and its path; a bare key gives neither, so nothing is guessed');

// 2. Network.
{
  assert.equal(networkProblem(tpub, 'signet'), null);
  assert.equal(networkProblem(tpub, 'testnet'), null);
  assert.match(networkProblem(tpub, 'bitcoin'), /holds real bitcoin, so the key should start with xpub/);
  const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/48'/0'/0'/2'").publicExtendedKey;
  assert.equal(networkProblem(xpub, 'bitcoin'), null);
  assert.match(networkProblem(xpub, 'signet'), /holds test coins, so the key should start with tpub/);
  pass('a test-coin key is refused for a real-bitcoin vault and the other way round, with a plain message');
}

// 3. The saved key is the key the vault will name.
const key = importXpub({ label: `Hardware wallet ${fp}`, persona: 'x', network: 'signet', xpub: tpub, derivationPath: parsed.path, masterFingerprint: fp });
assert.equal(key.origin, 'imported_xpub');
assert.equal(key.masterFingerprint, fp);
assert.equal(key.pubkey, hex(acct.deriveChild(0).deriveChild(0).publicKey));
assert.equal(key.pubkey, pubkeyFromXpub(key.xpub), 'the browser and the server derive the same signing key');
assert.ok(!JSON.stringify(listKeys()).match(/prv/), 'nothing private is stored');
pass('the saved key is public-only, and its signing key is the /0/0 child both the browser and the server derive');

console.log(`hardware-key-import tests passed (${n} cases)`);
