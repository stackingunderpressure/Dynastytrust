/**
 * @dynastytrust/bip341-psbt-signer
 *
 * The BIP341 tapscript-sighash core, extracted from DynastyTrust's
 * apps/web/src/lib/psbt-signer.ts (Cut B, stage B0 --
 * docs/integration-phase1-signin-and-bridge.md). This is the money-touching
 * primitive both DynastyTrust (browser-side wallet signing) and, once
 * vendored, Tapit Wallet (Cut B's B1, the psbt-cosign intent) need: parse a
 * PSBT, compute the exact BIP341 tapscript sighash for a given input +
 * leaf, and re-serialize a PSBT with new tap_script_sig entries injected.
 *
 * Pure. No mnemonic derivation, no network I/O, no app-specific policy --
 * that stays in each app (DynastyTrust's signPsbtWithMnemonic derives the
 * key then calls into this module; Tapit's B1 intent will do the same with
 * its own key source, wallet.signDigest, on the sighash this module
 * produces).
 *
 * THE PARITY GATE (per the plan's own words: "This test is the gate. No
 * signing bridge ships until it is green."): this module is vendored
 * byte-identically into every repo that needs it, the same way
 * tapit-attest is (see tapit-attest/STANDARDIZATION.md for the precedent
 * this follows). test/parity.test.mjs asserts a fixed golden vector --
 * a known PSBT + leaf script produces an exact, hardcoded sighash. The
 * same test file, vendored identically, run in each repo's own CI, proves
 * each repo's copy produces the same bytes without needing the two repos
 * to talk to each other at test time.
 *
 * To change this module: edit it here (DynastyTrust is the source of
 * truth for THIS module, since psbt-signer.ts is where it was extracted
 * from and where the original production Bitcoin-signing logic has run
 * the longest), run the parity test, then mirror src/, test/, package.json,
 * and tsconfig.json byte-for-byte into every vendoring repo, and run each
 * downstream repo's full gates before pushing. Never hand-edit a
 * downstream copy.
 */

// ── Encoding helpers ────────────────────────────────────────────────────

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function readUint16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function readInt64LE(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(buf[offset + i]) << BigInt(8 * i);
  }
  return result;
}

function writeUint32LE(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = n & 0xff;
  buf[1] = (n >> 8) & 0xff;
  buf[2] = (n >> 16) & 0xff;
  buf[3] = (n >> 24) & 0xff;
  return buf;
}

function writeUint64LE(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  }
  return buf;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}

export function varint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

// ── Tagged hash (BIP340/BIP341) ─────────────────────────────────────────

import { sha256 } from "@noble/hashes/sha256";

export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const tagBytes = new TextEncoder().encode(tag);
  const tagHash = sha256(tagBytes);
  const preimage = concat(tagHash, tagHash, ...msgs);
  return sha256(preimage);
}

// ── PSBT parser ──────────────────────────────────────────────────────────

export interface PsbtInput {
  witnessUtxo?: { amount: bigint; scriptPubkey: Uint8Array };
  tapInternalKey?: Uint8Array;
  tapLeafScript?: Array<{ controlBlock: Uint8Array; script: Uint8Array; leafVersion: number }>;
  tapScriptSigs?: Array<{ pubkey: Uint8Array; leafHash: Uint8Array; sig: Uint8Array }>;
  partialSigs?: Array<{ pubkey: Uint8Array; sig: Uint8Array }>;
  sequence?: number;
}

export interface PsbtTx {
  version: number;
  inputs: Array<{ txid: Uint8Array; vout: number; sequence: number }>;
  outputs: Array<{ amount: bigint; scriptPubkey: Uint8Array }>;
  locktime: number;
}

export interface ParsedPsbt {
  raw: Uint8Array;
  tx: PsbtTx;
  inputs: PsbtInput[];
}

function readVarInt(buf: Uint8Array, offset: number): [number, number] {
  const first = buf[offset];
  if (first < 0xfd) return [first, offset + 1];
  if (first === 0xfd) return [readUint16LE(buf, offset + 1), offset + 3];
  if (first === 0xfe) return [readUint32LE(buf, offset + 1), offset + 5];
  throw new Error("64-bit varint not supported");
}

export function parsePsbt(hex: string): ParsedPsbt {
  const buf = fromHex(hex);
  let pos = 0;

  // Magic
  if (buf[0] !== 0x70 || buf[1] !== 0x73 || buf[2] !== 0x62 || buf[3] !== 0x74 || buf[4] !== 0xff) {
    throw new Error("Invalid PSBT magic");
  }
  pos = 5;

  // Parse key-value pairs, stop at separator
  function readKV(): { key: Uint8Array; value: Uint8Array } | null {
    const [keyLen, newPos] = readVarInt(buf, pos);
    pos = newPos;
    if (keyLen === 0) return null;
    const key = buf.slice(pos, pos + keyLen);
    pos += keyLen;
    const [valLen, newPos2] = readVarInt(buf, pos);
    pos = newPos2;
    const value = buf.slice(pos, pos + valLen);
    pos += valLen;
    return { key, value };
  }

  // Global section - get unsigned tx
  let txBytes: Uint8Array | null = null;
  while (true) {
    const kv = readKV();
    if (!kv) break;
    if (kv.key[0] === 0x00) txBytes = kv.value; // PSBT_GLOBAL_UNSIGNED_TX
  }
  if (!txBytes) throw new Error("No unsigned tx in PSBT");

  // Parse the raw transaction
  const tx = parseRawTx(txBytes);

  // Parse input sections
  const inputs: PsbtInput[] = tx.inputs.map(() => {
    const inp: PsbtInput = {};
    while (true) {
      const kv = readKV();
      if (!kv) break;
      const keyType = kv.key[0];
      if (keyType === 0x01) {
        // PSBT_IN_WITNESS_UTXO
        const amount = readInt64LE(kv.value, 0);
        const [scriptLen, scriptPos] = readVarInt(kv.value, 8);
        const scriptPubkey = kv.value.slice(scriptPos, scriptPos + scriptLen);
        inp.witnessUtxo = { amount, scriptPubkey };
      } else if (keyType === 0x17) {
        // PSBT_IN_TAP_INTERNAL_KEY (BIP 371)
        inp.tapInternalKey = kv.value;
      } else if (keyType === 0x15) {
        // PSBT_IN_TAP_LEAF_SCRIPT
        // key: [0x15, control_block...], value: [script..., leaf_version]
        const controlBlock = kv.key.slice(1);
        const leafVersion = kv.value[kv.value.length - 1];
        const script = kv.value.slice(0, kv.value.length - 1);
        if (!inp.tapLeafScript) inp.tapLeafScript = [];
        inp.tapLeafScript.push({ controlBlock, script, leafVersion });
      } else if (keyType === 0x14) {
        // PSBT_IN_TAP_SCRIPT_SIG (BIP 371)
        // key: [0x14, xonly_pubkey(32), leaf_hash(32)]
        const pubkey = kv.key.slice(1, 33);
        const leafHash = kv.key.slice(33, 65);
        if (!inp.tapScriptSigs) inp.tapScriptSigs = [];
        inp.tapScriptSigs.push({ pubkey, leafHash, sig: kv.value });
      }
    }
    return inp;
  });

  // Skip output sections
  for (let i = 0; i < tx.outputs.length; i++) {
    while (true) {
      const kv = readKV();
      if (!kv) break;
    }
  }

  return { raw: buf, tx, inputs };
}

function parseRawTx(buf: Uint8Array): PsbtTx {
  let pos = 0;
  const version = readUint32LE(buf, pos); pos += 4;
  const [inCount, inPos] = readVarInt(buf, pos); pos = inPos;
  const inputs = [];
  for (let i = 0; i < inCount; i++) {
    const txid = buf.slice(pos, pos + 32); pos += 32;
    const vout = readUint32LE(buf, pos); pos += 4;
    const [scriptLen, scriptPos] = readVarInt(buf, pos); pos = scriptPos + scriptLen;
    const sequence = readUint32LE(buf, pos); pos += 4;
    inputs.push({ txid, vout, sequence });
  }
  const [outCount, outPos] = readVarInt(buf, pos); pos = outPos;
  const outputs = [];
  for (let i = 0; i < outCount; i++) {
    const amount = readInt64LE(buf, pos); pos += 8;
    const [scriptLen, scriptPos] = readVarInt(buf, pos); pos = scriptPos + scriptLen;
    const scriptPubkey = buf.slice(scriptPos, scriptPos + scriptLen);
    outputs.push({ amount, scriptPubkey });
  }
  const locktime = readUint32LE(buf, pos);
  return { version, inputs, outputs, locktime };
}

// ── BIP341 Tapscript sighash ────────────────────────────────────────────

export function tapLeafHash(script: Uint8Array, leafVersion: number): Uint8Array {
  return taggedHash("TapLeaf", new Uint8Array([leafVersion]), varint(script.length), script);
}

export function tapscriptSighash(
  psbt: ParsedPsbt,
  inputIndex: number,
  leafHash: Uint8Array,
  sighashType: number = 0x00
): Uint8Array {
  // BIP 341 tapscript sighash. The inner sha_* components are
  // PLAIN SHA256 (not tagged). Only the outer wrapping is tagged
  // with "TapSighash". Missing sha_prevouts or using taggedHash
  // for the inner pieces produces a sighash that rust-miniscript's
  // finalizer rejects as "bad schnorr signature".
  const tx = psbt.tx;
  const input = psbt.inputs[inputIndex];
  if (!input.witnessUtxo) throw new Error("Input " + inputIndex + " missing witness_utxo");

  const allUtxos = psbt.inputs.map(inp => {
    if (!inp.witnessUtxo) throw new Error("All inputs must have witness_utxo for tapscript signing");
    return inp.witnessUtxo;
  });

  // sha_prevouts: SHA256 of all input outpoints (36 bytes each).
  // Required for any sighash type that is NOT SIGHASH_ANYONECANPAY.
  const prevoutsData = concat(
    ...tx.inputs.map(i => concat(i.txid, writeUint32LE(i.vout))),
  );
  const shaPrevouts = sha256(prevoutsData);

  // sha_amounts: SHA256 of all spent amounts (8 bytes LE each).
  const amountsData = concat(...allUtxos.map(u => writeUint64LE(u.amount)));
  const shaAmounts = sha256(amountsData);

  // sha_scriptpubkeys: SHA256 of all spent scriptPubKeys (varint len + bytes).
  const spkData = concat(...allUtxos.map(u => concat(varint(u.scriptPubkey.length), u.scriptPubkey)));
  const shaScriptpubkeys = sha256(spkData);

  // sha_sequences: SHA256 of all input nSequence fields.
  const seqData = concat(...tx.inputs.map(i => writeUint32LE(i.sequence)));
  const shaSequences = sha256(seqData);

  // sha_outputs: SHA256 of all outputs (amount + script serialized as CTxOut).
  const outData = concat(...tx.outputs.map(out => concat(writeUint64LE(out.amount), varint(out.scriptPubkey.length), out.scriptPubkey)));
  const shaOutputs = sha256(outData);

  // spend_type: script path (ext_flag=1), no annex -> 0x02.
  const spendType = new Uint8Array([0x02]);
  const inputIndexBytes = writeUint32LE(inputIndex);

  // Per BIP 341: tapleaf_hash (32) + key_version (1, 0x00) +
  // codesep_pos (4, UINT_MAX when no OP_CODESEPARATOR in leaf).
  const leafData = concat(
    leafHash,
    new Uint8Array([0x00]),                             // key_version
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),           // codesep_pos = UINT_MAX
  );

  // sigMsg assembly for SIGHASH_DEFAULT (0x00):
  //   hash_type . nVersion . nLockTime
  //   sha_prevouts . sha_amounts . sha_scriptpubkeys . sha_sequences
  //   sha_outputs
  //   spend_type
  //   input_index                     (anyonecanpay NOT set)
  //   tapleaf_hash . key_version . codesep_pos   (ext for script path)
  const sigMsg = concat(
    new Uint8Array([sighashType]),
    writeUint32LE(tx.version),
    writeUint32LE(tx.locktime),
    shaPrevouts,
    shaAmounts,
    shaScriptpubkeys,
    shaSequences,
    shaOutputs,
    spendType,
    inputIndexBytes,
    leafData,
  );

  // Outer TapSighash tag per BIP 341: hash( tag_hash || tag_hash || 0x00 || sigMsg ).
  // Our taggedHash helper already computes tag_hash || tag_hash || msg, and we
  // prepend the epoch byte 0x00 via the first varg.
  return taggedHash("TapSighash", new Uint8Array([0x00]), sigMsg);
}

// ── PSBT serializer ──────────────────────────────────────────────────────

export function serializePsbt(parsed: ParsedPsbt): string {
  // Re-serialize with tap_script_sigs added
  // Strategy: parse raw bytes and inject new key-value pairs into each input section

  const buf = parsed.raw;
  let pos = 5; // skip magic

  const sections: Uint8Array[] = [];
  sections.push(buf.slice(0, 5)); // magic

  function readRawKVSection(): { rawBytes: Uint8Array; endPos: number } {
    const start = pos;
    while (true) {
      const [keyLen, newPos] = readVarInt(buf, pos);
      pos = newPos;
      if (keyLen === 0) break;
      pos += keyLen;
      const [valLen, newPos2] = readVarInt(buf, pos);
      pos = newPos2 + valLen;
    }
    return { rawBytes: buf.slice(start, pos), endPos: pos };
  }

  // Global section (copy as-is)
  const globalSection = readRawKVSection();
  sections.push(globalSection.rawBytes);

  // Strip entries of the given key-type from a raw PSBT KV section
  // (without the trailing 0x00 separator). Used to scrub existing
  // tap_script_sig (0x14) entries so our tapScriptSigs array can be
  // the single source of truth; otherwise raw bytes + array entries
  // both get written and rust-bitcoin rejects duplicate keys.
  function stripKeyType(raw: Uint8Array, type: number): Uint8Array {
    const out: Uint8Array[] = [];
    let p = 0;
    while (p < raw.length) {
      const [keyLen, afterKeyLen] = readVarInt(raw, p);
      const keyStart = afterKeyLen;
      const keyEnd = keyStart + keyLen;
      const [valLen, afterValLen] = readVarInt(raw, keyEnd);
      const valEnd = afterValLen + valLen;
      const keyType = keyLen > 0 ? raw[keyStart] : -1;
      if (keyType !== type) out.push(raw.slice(p, valEnd));
      p = valEnd;
    }
    return concat(...out);
  }

  // Input sections - inject tap_script_sigs
  for (let i = 0; i < parsed.inputs.length; i++) {
    const start = pos;
    const inputSectionRaw = readRawKVSection();
    const rawNoSep = inputSectionRaw.rawBytes.slice(0, inputSectionRaw.rawBytes.length - 1); // strip separator
    const existing = stripKeyType(rawNoSep, 0x14);

    const extra: Uint8Array[] = [];
    const inp = parsed.inputs[i];
    if (inp.tapScriptSigs) {
      for (const tss of inp.tapScriptSigs) {
        // PSBT_IN_TAP_SCRIPT_SIG (BIP 371)
        // Key: [0x14, xonly_pubkey(32), leaf_hash(32)]
        const key = concat(new Uint8Array([0x14]), tss.pubkey, tss.leafHash);
        const kv = concat(varint(key.length), key, varint(tss.sig.length), tss.sig);
        extra.push(kv);
      }
    }

    sections.push(existing, ...extra, new Uint8Array([0x00])); // separator
    pos = start + inputSectionRaw.rawBytes.length;
  }

  // Output sections (copy as-is)
  for (let i = 0; i < parsed.tx.outputs.length; i++) {
    const outputSection = readRawKVSection();
    sections.push(outputSection.rawBytes);
  }

  return toHex(concat(...sections));
}
