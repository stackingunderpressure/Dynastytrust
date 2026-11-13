/**
 * test-ur-account.mjs -- reading a hardware wallet's ANIMATED key QR
 * (BC-UR crypto-account), apps/web/src/lib/ur-account.ts, 2026-11-13.
 *
 * The fixture scripts/fixtures-seedsigner-ur.json was produced by
 * SeedSigner's OWN encoder (the fork's models/encode_qr.py
 * UrXpubQrEncoder, run against known seeds), with the xpub, fingerprint
 * and path the fork derives directly. So this checks our decoder against
 * the real device's output, not against our own idea of the format.
 * Public keys only: the seeds are the well-known test phrases.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// The ES build the browser bundle uses (its CommonJS build cannot load
// cborg under Node).
import { URDecoder } from '@gandlaf21/bc-ur/dist/lib/es6/index.js';
import { encode } from 'cborg';
import { keysFromUr, pickVaultKey, keyOriginString } from '../apps/web/src/lib/ur-account.ts';
import { parseXpubText } from '../apps/web/src/lib/keystore.ts';
import { pubkeyFromXpub } from '../netlify/functions/_xpub.js';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const cases = JSON.parse(readFileSync(new URL('./fixtures-seedsigner-ur.json', import.meta.url), 'utf8'));

function scan(parts, order = parts) {
  const dec = new URDecoder();
  for (const p of order) { dec.receivePart(p); if (dec.isComplete()) break; }
  assert.ok(dec.isComplete() && dec.isSuccess(), 'the frames reassemble');
  const ur = dec.resultUR();
  return { type: ur.type, cbor: new Uint8Array(ur.cbor) };
}

// 1. Every SeedSigner export decodes to exactly the key the device derives.
for (const c of cases) {
  const { type, cbor } = scan(c.parts);
  assert.equal(type, 'crypto-account');
  const keys = keysFromUr(type, cbor);
  const k = pickVaultKey(keys);
  assert.equal(k.xpub, c.expect.xpub, `${c.path}: xpub`);
  assert.equal(k.fingerprint, c.expect.fingerprint, `${c.path}: fingerprint`);
  assert.equal(k.path, c.expect.path, `${c.path}: path`);
  assert.equal(k.testnet, c.net !== 'M', `${c.path}: network`);
  // ...and reads exactly like the static QR would, through the same parser.
  const viaStatic = parseXpubText(keyOriginString(k));
  assert.deepEqual([viaStatic.xpub, viaStatic.fingerprint, viaStatic.path], [c.expect.xpub, c.expect.fingerprint, c.expect.path]);
  assert.match(pubkeyFromXpub(k.xpub), /^0[23][0-9a-f]{64}$/);
}
const ms = cases.filter(c => c.sig === 'ms').length;
pass(`${cases.length} animated key QRs made by SeedSigner's own encoder (${ms} multisig, testnet and mainnet; single-sig segwit and taproot) decode to the exact xpub, fingerprint and path the device derives`);

// 2. Frames arrive in any order, with repeats, as a camera sees them.
{
  const c = cases[0];
  const shuffled = [...c.parts].reverse().concat(c.parts);
  const k = pickVaultKey(keysFromUr(...Object.values(scan(c.parts, shuffled))));
  assert.equal(k.xpub, c.expect.xpub);
}
pass('frames in any order, with repeats, decode to the same key');

// 3. Damaged or foreign data is refused, never guessed.
{
  const c = cases[0];
  const { type, cbor } = scan(c.parts);
  const bad = cbor.slice(); bad[bad.length - 5] ^= 0xff;
  let refused = false; try { pickVaultKey(keysFromUr(type, bad)); } catch { refused = true; }
  assert.ok(refused, 'a flipped byte in the key is refused (the rebuilt xpub must read back to the same key)');
  assert.throws(() => keysFromUr('crypto-psbt', cbor), /not a key export/);
  assert.throws(() => keysFromUr('crypto-account', encode(new Map([[1, 1]]))), /does not contain any keys/);
  assert.throws(() => keysFromUr('crypto-account', encode(new Map([[2, []]]))), /master fingerprint/);
}
pass('a damaged key, a non-key QR and a record with no keys or no fingerprint are refused with a reason');

console.log(`ur-account tests passed (${n} cases)`);
