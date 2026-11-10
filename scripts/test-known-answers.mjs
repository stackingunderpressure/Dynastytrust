/**
 * test-known-answers.mjs -- runs the cryptography DynastyTrust depends on
 * against published known answers, so a wrong signature, hash or sighash
 * coming from a library bug or a bad dependency update is caught here and
 * not on a real spend. Wired into `npm test`.
 *
 * 1. BIP 340 (Schnorr): every official test vector, through the SAME
 *    @noble/curves `schnorr` the browser signs with -- sign must
 *    reproduce the published signature byte for byte, verify must agree
 *    with the published verdict (including every vector that must FAIL).
 * 2. BIP 341 (Taproot): the official wallet vectors -- our own
 *    `tapLeafHash` and `taggedHash` (packages/bip341-psbt-signer) must
 *    reproduce each published leaf hash, merkle root, tweak and output key.
 * 3. BIP 341 script-path sighash: there is no official script-path
 *    vector, so OUR `tapscriptSighash` is compared against an
 *    INDEPENDENT implementation (@scure/btc-signer's preimageWitnessV1)
 *    on the official 9-input vector transaction, for every input and
 *    both sighash types we support. Two implementations that have never
 *    seen each other's code must agree.
 *
 * Vectors are vendored under scripts/vectors/ (from github.com/bitcoin/bips,
 * fetched 2026-11-10) so this runs offline and cannot drift silently.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-known-answers.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { tapLeafHash, taggedHash, tapscriptSighash, fromHex, toHex, varint } from '../packages/bip341-psbt-signer/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vec = (f) => readFileSync(join(here, 'vectors', f), 'utf8');
let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// ── 1. BIP 340 ───────────────────────────────────────────────────────────
{
  const rows = vec('bip-0340-test-vectors.csv').trim().split('\n').slice(1).map(l => l.split(','));
  let signed = 0, verifiedTrue = 0, verifiedFalse = 0;
  for (const [idx, sk, pk, aux, msg, sig, result] of rows) {
    const expect = result === 'TRUE';
    const m = fromHex(msg.toLowerCase());
    if (sk) {
      assert.equal(toHex(schnorr.getPublicKey(fromHex(sk.toLowerCase()))), pk.toLowerCase(), `vector ${idx}: public key`);
      const got = schnorr.sign(m, fromHex(sk.toLowerCase()), fromHex(aux.toLowerCase()));
      assert.equal(toHex(got), sig.toLowerCase(), `vector ${idx}: signature differs from the published one`);
      signed++;
    }
    let ok;
    try { ok = schnorr.verify(fromHex(sig.toLowerCase()), m, fromHex(pk.toLowerCase())); } catch { ok = false; }
    assert.equal(ok, expect, `vector ${idx}: verify returned ${ok}, the standard says ${expect}`);
    if (expect) verifiedTrue++; else verifiedFalse++;
  }
  assert.equal(rows.length, 19, 'expected the 19 official BIP 340 vectors');
  assert.ok(signed >= 8 && verifiedFalse >= 8);
  pass(`BIP 340: ${rows.length} official vectors -- ${signed} signatures reproduced byte for byte, ${verifiedTrue} accepted, ${verifiedFalse} correctly refused`);
}

const V341 = JSON.parse(vec('bip-0341-wallet-test-vectors.json'));

// ── 2. BIP 341 leaf hashes, merkle root, tweak, output key ───────────────
{
  const leaves = (t) => (Array.isArray(t) ? t.flatMap(leaves) : t ? [t] : []);
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const branch = (a, b) => (cmp(a, b) <= 0 ? taggedHash('TapBranch', a, b) : taggedHash('TapBranch', b, a));
  const root = (t) => (Array.isArray(t) ? branch(root(t[0]), root(t[1])) : tapLeafHash(fromHex(t.script), t.leafVersion));
  let leafCount = 0;
  for (const c of V341.scriptPubKey) {
    const internal = fromHex(c.given.internalPubkey);
    const tree = c.given.scriptTree;
    const ls = leaves(tree);
    ls.forEach((l, i) => {
      assert.equal(toHex(tapLeafHash(fromHex(l.script), l.leafVersion)), c.intermediary.leafHashes[i], 'leaf hash');
      leafCount++;
    });
    const merkle = tree ? root(tree) : new Uint8Array(0);
    if (tree) assert.equal(toHex(merkle), c.intermediary.merkleRoot, 'merkle root');
    const tweak = taggedHash('TapTweak', internal, merkle);
    assert.equal(toHex(tweak), c.intermediary.tweak, 'tweak');
    const P = secp256k1.ProjectivePoint.fromHex('02' + c.given.internalPubkey);
    const Q = P.add(secp256k1.ProjectivePoint.BASE.multiply(BigInt('0x' + toHex(tweak))));
    assert.equal(toHex(Q.toRawBytes(true)).slice(2), c.intermediary.tweakedPubkey, 'output key');
    assert.equal('5120' + c.intermediary.tweakedPubkey, c.expected.scriptPubKey, 'scriptPubKey');
  }
  pass(`BIP 341: ${V341.scriptPubKey.length} official cases -- ${leafCount} leaf hashes, every merkle root, tweak and output key reproduced by our own hashing code`);
}

// ── 3. script-path sighash: ours vs an independent implementation ────────
{
  const kp = V341.keyPathSpending[0];
  const raw = fromHex(kp.given.rawUnsignedTx);
  // Minimal non-witness tx parse into the shape our signer uses.
  let p = 0;
  const u32 = () => { const v = new DataView(raw.buffer, raw.byteOffset + p, 4).getUint32(0, true); p += 4; return v; };
  const u64 = () => { const v = new DataView(raw.buffer, raw.byteOffset + p, 8).getBigUint64(0, true); p += 8; return v; };
  const vi = () => { const f = raw[p++]; assert.ok(f < 0xfd); return f; };
  const version = u32();
  const inputs = Array.from({ length: vi() }, () => {
    const txid = raw.slice(p, p + 32); p += 32;
    const vout = u32(); const sl = vi(); p += sl; const sequence = u32();
    return { txid, vout, sequence };
  });
  const outputs = Array.from({ length: vi() }, () => { const amount = u64(); const l = vi(); const scriptPubkey = raw.slice(p, p + l); p += l; return { amount, scriptPubkey }; });
  const locktime = u32();
  assert.equal(p, raw.length, 'vector tx fully parsed');
  const utxos = kp.given.utxosSpent.map(u => ({ amount: BigInt(u.amountSats), scriptPubkey: fromHex(u.scriptPubKey) }));
  const ours = { raw, tx: { version, inputs, outputs, locktime }, inputs: utxos.map(witnessUtxo => ({ witnessUtxo })) };

  const theirs = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true, allowLegacyWitnessUtxo: true });
  const prevScripts = utxos.map(u => u.scriptPubkey), amounts = utxos.map(u => u.amount);
  // A real 2-of-3 multi_a style leaf and a second, different one.
  const k = (i) => toHex(schnorr.getPublicKey(new Uint8Array(32).fill(i)));
  const leafScripts = [
    fromHex(`20${k(1)}ac20${k(2)}ba20${k(3)}ba529c`),
    fromHex(`03a0bb0db17520${k(4)}ac`),
  ];
  let compared = 0;
  for (const script of leafScripts) {
    const leafHash = tapLeafHash(script, 0xc0);
    assert.equal(toHex(leafHash), toHex(taggedHash('TapLeaf', new Uint8Array([0xc0]), varint(script.length), script)));
    for (let i = 0; i < inputs.length; i++) {
      for (const type of [0x00, 0x01]) {
        const a = tapscriptSighash(ours, i, leafHash, type);
        const b = theirs.preimageWitnessV1(i, prevScripts, type, amounts, undefined, script, 0xc0);
        assert.equal(toHex(a), toHex(b), `input ${i} sighash type ${type}: ours differs from the independent implementation`);
        compared++;
      }
    }
  }
  // And it must move when anything it commits to moves.
  const base = toHex(tapscriptSighash(ours, 0, tapLeafHash(leafScripts[0], 0xc0), 0));
  const bumped = structuredClone(ours); bumped.inputs[3].witnessUtxo.amount += 1n;
  assert.notEqual(toHex(tapscriptSighash(bumped, 0, tapLeafHash(leafScripts[0], 0xc0), 0)), base, 'another input\'s amount must change the sighash');
  assert.notEqual(toHex(tapscriptSighash(ours, 0, tapLeafHash(leafScripts[1], 0xc0), 0)), base, 'a different leaf must change the sighash');
  assert.throws(() => tapscriptSighash(ours, 0, tapLeafHash(leafScripts[0], 0xc0), 0x81), /not supported/);
  pass(`BIP 341 script-path sighash: ${compared} digests (${inputs.length} inputs x 2 leaves x 2 sighash types) identical to an independent implementation`);
}

console.log(`known-answer tests passed (${n} groups)`);
