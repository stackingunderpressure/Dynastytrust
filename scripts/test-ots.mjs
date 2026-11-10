/**
 * test-ots.mjs -- proves our dependency-free OpenTimestamps reader
 * (netlify/functions/_ots.js) against the REFERENCE client's own
 * published proof and the real Bitcoin block it points at. Wired into
 * `npm test`; runs offline (the block's merkle root is recorded below,
 * fetched from blockstream.info on 2026-11-10).
 *
 * Run:  node scripts/test-ots.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readOtsFile, readAttestations, matchesBlock, toOtsFile, anchorDigest } from '../netlify/functions/_ots.js';

const here = dirname(fileURLToPath(import.meta.url));
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// The reference client's example: "Hello World!\n", timestamped in Bitcoin block 358,391 (May 2015).
const file = readFileSync(join(here, 'vectors', 'ots-hello-world.txt.ots'));
const BLOCK_358391_MERKLE_ROOT = '8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00';
const { digest, proof } = readOtsFile(file);
assert.equal(digest.toString('hex'), createHash('sha256').update('Hello World!\n').digest('hex'));
const atts = readAttestations(digest, proof);
assert.equal(atts.length, 1);
assert.equal(atts[0].kind, 'bitcoin');
assert.equal(atts[0].height, 358391);
assert.equal(matchesBlock(atts[0], BLOCK_358391_MERKLE_ROOT), true);
pass('the reference proof replays from sha256("Hello World!\\n") to the merkle root of Bitcoin block 358,391');

// The proof binds THAT digest to THAT block and nothing else.
const other = createHash('sha256').update('Hello World?\n').digest();
assert.equal(matchesBlock(readAttestations(other, proof)[0], BLOCK_358391_MERKLE_ROOT), false, 'a different document must not fit the proof');
assert.equal(matchesBlock(atts[0], '00'.repeat(32)), false, 'a different block must not fit the proof');
const flipped = Buffer.from(proof); flipped[40] ^= 1;
let stillFits = false;
try { stillFits = matchesBlock(readAttestations(digest, flipped)[0], BLOCK_358391_MERKLE_ROOT); } catch { /* unparseable is also a refusal */ }
assert.equal(stillFits, false, 'a proof with one bit changed must not fit');
pass('a different document, a different block, or one flipped bit in the proof all fail');

// Hostile input is refused, never looped on or crashed by.
assert.throws(() => readOtsFile(Buffer.from('not a proof')), /not an OpenTimestamps proof/);
assert.throws(() => readAttestations(digest, proof.subarray(0, proof.length - 5)), /truncated/);
assert.throws(() => readAttestations(digest, Buffer.concat([proof, Buffer.from([0x00])])), /trailing|truncated/);
assert.throws(() => readAttestations(digest, Buffer.from([0x67, 0x00])), /unsupported operation/);
assert.throws(() => readAttestations(digest, Buffer.alloc(5000, 0x08)), /too many operations|nests too deeply|truncated/);
pass('garbage, truncated, padded, unsupported and runaway proofs are refused');

// Round trip through the standard file format, and a real calendar reply captured 2026-11-10.
assert.deepEqual(readOtsFile(toOtsFile(digest, proof)).proof, proof);
const d = createHash('sha256').update('x').digest();
const calendarReply = Buffer.from('f008d701720aa32d884708f120c9b2ba70571c0caf03a849439a4f792b27014dc128f6cdcf0875b23bd905176508f010eca2f48c40d832a4e463d074912669e308f1209cc64c416e535005f57a0e71b0148598c6f680340f976ca5bb5732ded1c9b4c708f020c0a01e52ddd5cf39eaa93ee0894351e9052bb53ecdb0e8a9b3436e8bc3b2f10b08f1046af3ae48f008cac3e22ea420c89a0083dfe30d2ef90c8e2e2d68747470733a2f2f616c6963652e6274632e63616c656e6461722e6f70656e74696d657374616d70732e6f7267', 'hex');
const pend = readAttestations(d, calendarReply);
assert.equal(pend.length, 1);
assert.equal(pend[0].kind, 'pending');
assert.equal(pend[0].uri, 'https://alice.btc.calendar.opentimestamps.org');
assert.equal(pend[0].commitment.length, 88, 'a calendar commitment is 44 bytes: 4-byte time, 8-byte nonce, 32-byte hash');
pass('a real calendar reply parses to a pending attestation; our files round-trip in the standard format');

// What we submit is bound to the vault, the position and the entry hash.
const a = anchorDigest({ vaultId: 'v1', seq: 5, entryHash: 'ab'.repeat(32) });
assert.equal(a.length, 32);
for (const o of [{ vaultId: 'v2' }, { seq: 6 }, { entryHash: 'cd'.repeat(32) }]) {
  assert.notEqual(anchorDigest({ vaultId: 'v1', seq: 5, entryHash: 'ab'.repeat(32), ...o }).toString('hex'), a.toString('hex'));
}
pass('the anchored digest changes with the vault, the position, or the entry hash');

console.log(`ots tests passed (${n} cases)`);
