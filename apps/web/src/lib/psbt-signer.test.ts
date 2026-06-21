/**
 * psbt-signer.test.ts — the money-touching path. These prove the browser
 * signer produces a valid BIP340 Schnorr signature over the BIP341 tapscript
 * sighash, bound to the exact spend (change the payout and the signature no
 * longer verifies), plus merge/count/negative behavior.
 *
 * The PSBT fixture is built with encoders independent of the module under test,
 * so the parser/sighash are checked against bytes the module did not produce.
 *
 * Note on the sighash regression pin: the implementation's BIP341 correctness
 * was established by round-tripping through rust-miniscript's finalizer (see
 * the comment in tapscriptSighash). This pin guards against future drift in
 * that algorithm; it is not an independent re-derivation of BIP341.
 */
import { describe, it, expect } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import {
  signPsbtWithMnemonic,
  countSignatures,
  mergePsbts,
  parsePsbt,
  tapLeafHash,
  tapscriptSighash,
} from './psbt-signer';

// ── independent encoders (NOT the module's) ──
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};
const varint = (n: number) =>
  n < 0xfd
    ? new Uint8Array([n])
    : n <= 0xffff
      ? new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff])
      : new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
const cat = (...a: Uint8Array[]) => {
  const t = a.reduce((s, x) => s + x.length, 0);
  const r = new Uint8Array(t);
  let o = 0;
  for (const x of a) {
    r.set(x, o);
    o += x.length;
  }
  return r;
};
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

const PATH = "m/48'/1'/0'/2'";
const TESTNET_V = { private: 0x04358394, public: 0x043587cf };
// Two valid, distinct BIP39 test mnemonics.
const MNEMONIC_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_B =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

function xonlyOf(mnemonic: string): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed, TESTNET_V);
  const child00 = root.derive(PATH).deriveChild(0).deriveChild(0);
  return secp256k1.getPublicKey(child00.privateKey as Uint8Array, true).slice(1); // x-only (32)
}

const LEAF_VERSION = 0xc0;

/** Minimal 1-in/1-out Taproot script-path PSBT. `pubkeys` are embedded in the
 * leaf so the signer's substring match selects them. */
function buildPsbt(pubkeys: Uint8Array[], outAmount = 9000n, inAmount = 10000n) {
  const txid = new Uint8Array(32).fill(0x11);
  const spk = cat(new Uint8Array([0x51, 0x20]), new Uint8Array(32).fill(0x22)); // OP_1 <32>
  const rawTx = cat(
    u32(2),
    varint(1),
    txid,
    u32(0),
    varint(0),
    u32(0xfffffffd),
    varint(1),
    u64(outAmount),
    varint(spk.length),
    spk,
    u32(0),
  );
  // leaf: ( <32> push pubkey, OP_CHECKSIG ) repeated — only substring presence
  // and the full-script leaf hash matter for these tests.
  const leafScript = cat(
    ...pubkeys.flatMap((pk) => [new Uint8Array([0x20]), pk, new Uint8Array([0xac])]),
  );
  const controlBlock = cat(new Uint8Array([0xc0]), new Uint8Array(32).fill(0x33));
  const kv = (key: Uint8Array, val: Uint8Array) => cat(varint(key.length), key, varint(val.length), val);
  const SEP = new Uint8Array([0x00]);
  const magic = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]);
  const global = cat(kv(new Uint8Array([0x00]), rawTx), SEP);
  const witnessUtxo = cat(u64(inAmount), varint(spk.length), spk);
  const input = cat(
    kv(new Uint8Array([0x01]), witnessUtxo),
    kv(cat(new Uint8Array([0x15]), controlBlock), cat(leafScript, new Uint8Array([LEAF_VERSION]))),
    SEP,
  );
  return { hex: hex(cat(magic, global, input, SEP)), leafScript };
}

describe('psbt-signer — taproot script-path signing', () => {
  const xonlyA = xonlyOf(MNEMONIC_A);

  it('signs the input for the matching key and adds one tap_script_sig', async () => {
    const { hex: psbt } = buildPsbt([xonlyA]);
    expect(countSignatures(psbt)).toBe(0);
    const { psbt_hex, signaturesAdded } = await signPsbtWithMnemonic(psbt, MNEMONIC_A, PATH, 'testnet');
    expect(signaturesAdded).toBe(1);
    expect(countSignatures(psbt_hex)).toBe(1);
  });

  it('produces a Schnorr signature that verifies against the BIP341 sighash', async () => {
    const { hex: psbt, leafScript } = buildPsbt([xonlyA]);
    const { psbt_hex } = await signPsbtWithMnemonic(psbt, MNEMONIC_A, PATH, 'testnet');
    const tss = parsePsbt(psbt_hex).inputs[0].tapScriptSigs?.find((s) => hex(s.pubkey) === hex(xonlyA));
    expect(tss).toBeTruthy();
    const leafHash = tapLeafHash(leafScript, LEAF_VERSION);
    const sighash = tapscriptSighash(parsePsbt(psbt), 0, leafHash, 0);
    expect(schnorr.verify(tss!.sig, sighash, xonlyA)).toBe(true);
  });

  it('binds the signature to the spend — a rewritten payout invalidates it', async () => {
    const A = buildPsbt([xonlyA], 9000n);
    const { psbt_hex } = await signPsbtWithMnemonic(A.hex, MNEMONIC_A, PATH, 'testnet');
    const sig = parsePsbt(psbt_hex).inputs[0].tapScriptSigs![0].sig;
    const leafHash = tapLeafHash(A.leafScript, LEAF_VERSION);
    // attacker changes the output amount → different sighash → old sig is void
    const B = buildPsbt([xonlyA], 1n);
    const sighashB = tapscriptSighash(parsePsbt(B.hex), 0, leafHash, 0);
    expect(schnorr.verify(sig, sighashB, xonlyA)).toBe(false);
  });

  it('Schnorr nonce is randomized but every signature verifies', async () => {
    const { hex: psbt, leafScript } = buildPsbt([xonlyA]);
    const s1 = await signPsbtWithMnemonic(psbt, MNEMONIC_A, PATH, 'testnet');
    const s2 = await signPsbtWithMnemonic(psbt, MNEMONIC_A, PATH, 'testnet');
    const sig1 = parsePsbt(s1.psbt_hex).inputs[0].tapScriptSigs![0].sig;
    const sig2 = parsePsbt(s2.psbt_hex).inputs[0].tapScriptSigs![0].sig;
    expect(hex(sig1)).not.toBe(hex(sig2)); // aux-rand → non-deterministic
    const sighash = tapscriptSighash(parsePsbt(psbt), 0, tapLeafHash(leafScript, LEAF_VERSION), 0);
    expect(schnorr.verify(sig1, sighash, xonlyA)).toBe(true);
    expect(schnorr.verify(sig2, sighash, xonlyA)).toBe(true);
  });

  it('throws when the key signs no input in the PSBT', async () => {
    const { hex: psbt } = buildPsbt([xonlyA]);
    await expect(signPsbtWithMnemonic(psbt, MNEMONIC_B, PATH, 'testnet')).rejects.toThrow(
      /not a signer/i,
    );
  });

  it('merges partial sigs from two signers without duplication', async () => {
    const xonlyB = xonlyOf(MNEMONIC_B);
    const { hex: psbt } = buildPsbt([xonlyA, xonlyB]);
    const a = await signPsbtWithMnemonic(psbt, MNEMONIC_A, PATH, 'testnet');
    const b = await signPsbtWithMnemonic(psbt, MNEMONIC_B, PATH, 'testnet');
    const merged = mergePsbts([a.psbt_hex, b.psbt_hex]);
    expect(countSignatures(merged)).toBe(2);
    // merge is idempotent
    expect(countSignatures(mergePsbts([merged, a.psbt_hex]))).toBe(2);
  });

  it('sighash is stable (regression guard against BIP341 drift)', () => {
    const { hex: psbt, leafScript } = buildPsbt([xonlyA]);
    const leafHash = tapLeafHash(leafScript, LEAF_VERSION);
    const sighash = hex(tapscriptSighash(parsePsbt(psbt), 0, leafHash, 0));
    expect(sighash).toBe('934badb4b023369fa5343189af92731d968ac27208293fef8e94b57433287723');
  });
});
