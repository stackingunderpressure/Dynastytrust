/**
 * psbt-signer.ts
 *
 * Browser-side PSBT signing for Taproot script path spends.
 * Implements BIP341 tapscript sighash + Schnorr signing using @noble/curves.
 *
 * Supports the tr_multileaf vault format produced by the DynastyTrust compiler.
 * Each spending path is a separate Taproot leaf; signing uses the script path.
 */

import * as btc from "@scure/btc-signer";
import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

// ── Encoding helpers ──────────────────────────────────────────────────────────

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
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

function varint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

// ── Tagged hash (BIP340/BIP341) ───────────────────────────────────────────────

function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const tagBytes = new TextEncoder().encode(tag);
  const tagHash = sha256(tagBytes);
  const preimage = concat(tagHash, tagHash, ...msgs);
  return sha256(preimage);
}

// ── PSBT parser ───────────────────────────────────────────────────────────────

interface PsbtInput {
  witnessUtxo?: { amount: bigint; scriptPubkey: Uint8Array };
  tapInternalKey?: Uint8Array;
  tapLeafScript?: Array<{ controlBlock: Uint8Array; script: Uint8Array; leafVersion: number }>;
  tapScriptSigs?: Array<{ pubkey: Uint8Array; leafHash: Uint8Array; sig: Uint8Array }>;
  partialSigs?: Array<{ pubkey: Uint8Array; sig: Uint8Array }>;
  sequence?: number;
}

interface PsbtTx {
  version: number;
  inputs: Array<{ txid: Uint8Array; vout: number; sequence: number }>;
  outputs: Array<{ amount: bigint; scriptPubkey: Uint8Array }>;
  locktime: number;
}

interface ParsedPsbt {
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

function parsePsbt(hex: string): ParsedPsbt {
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

// ── BIP341 Tapscript sighash ──────────────────────────────────────────────────

function tapLeafHash(script: Uint8Array, leafVersion: number): Uint8Array {
  return taggedHash("TapLeaf", new Uint8Array([leafVersion]), varint(script.length), script);
}

function tapscriptSighash(
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

// ── PSBT serializer ───────────────────────────────────────────────────────────

function serializePsbt(parsed: ParsedPsbt): string {
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

// ── Public API ────────────────────────────────────────────────────────────────

export interface SignResult {
  psbt_hex: string;
  signaturesAdded: number;
}

/**
 * LEGACY hand-rolled Taproot script-path signer. Retained as an automatic
 * fallback behind the audited @scure/btc-signer path (see signPsbtWithMnemonic
 * below) so a quirk in a compiler-produced PSBT can never REGRESS the working
 * path. Signs all inputs where the key's /0/0 pubkey appears in tap_leaf_script.
 */
async function signPsbtLegacy(
  psbtHex: string,
  mnemonic: string,
  derivationPath: string,
  network: "testnet" | "bitcoin"
): Promise<SignResult> {
  const networkVersions = network === "bitcoin"
    ? { private: 0x0488ade4, public: 0x0488b21e }
    : { private: 0x04358394, public: 0x043587cf };

  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed, networkVersions);
  // The keystore's `derivationPath` is the account path (xpub level).
  // The pubkey embedded in the leaf script lives one step deeper at
  // /0/0 (first receive-chain child). Sign with that private key so
  // the signature matches the leaf's pubkey.
  const account = root.derive(derivationPath);
  const child00 = account.deriveChild(0).deriveChild(0);

  if (!child00.privateKey) throw new Error("Could not derive private key");

  const privKey = child00.privateKey;
  const pubKey = secp256k1.getPublicKey(privKey, true); // compressed
  const xOnlyPubKey = pubKey.slice(1); // x-only (32 bytes)

  const parsed = parsePsbt(psbtHex);
  let signaturesAdded = 0;

  for (let i = 0; i < parsed.inputs.length; i++) {
    const inp = parsed.inputs[i];
    if (!inp.tapLeafScript || inp.tapLeafScript.length === 0) continue;

    for (const leaf of inp.tapLeafScript) {
      // Check if our pubkey is in this leaf script
      const scriptHex = toHex(leaf.script);
      if (!scriptHex.includes(toHex(xOnlyPubKey))) continue;

      // Compute leaf hash
      const leafHash = tapLeafHash(leaf.script, leaf.leafVersion);

      // Compute sighash
      let sighash: Uint8Array;
      try {
        sighash = tapscriptSighash(parsed, i, leafHash, 0x00);
      } catch (e) {
        console.warn("Sighash failed for input " + i + ":", e);
        continue;
      }

      // Sign with Schnorr
      const sig = schnorr.sign(sighash, privKey);

      // Add to parsed input
      if (!inp.tapScriptSigs) inp.tapScriptSigs = [];
      // Remove existing sig for this pubkey+leaf if any
      inp.tapScriptSigs = inp.tapScriptSigs.filter(
        s => !(toHex(s.pubkey) === toHex(xOnlyPubKey) && toHex(s.leafHash) === toHex(leafHash))
      );
      inp.tapScriptSigs.push({ pubkey: xOnlyPubKey, leafHash, sig });
      signaturesAdded++;
    }
  }

  if (signaturesAdded === 0) {
    throw new Error("This key is not a signer for any input in this PSBT. Make sure the key matches the vault.");
  }

  const signedHex = serializePsbt(parsed);
  return { psbt_hex: signedHex, signaturesAdded };
}

/**
 * LEGACY signature counter (tap_script_sig only). Fallback behind the
 * btc-signer countSignatures below.
 */
function countSignaturesLegacy(psbtHex: string): number {
  try {
    const parsed = parsePsbt(psbtHex);
    return parsed.inputs.reduce((sum, inp) => sum + (inp.tapScriptSigs?.length ?? 0), 0);
  } catch {
    return 0;
  }
}

/**
 * LEGACY merge (tap_script_sig only). Fallback behind the btc-signer mergePsbts
 * below.
 */
function mergePsbtsLegacy(psbtHexes: string[]): string {
  if (psbtHexes.length === 0) throw new Error("No PSBTs to merge");
  const first = parsePsbt(psbtHexes[0]);
  for (let p = 1; p < psbtHexes.length; p++) {
    const other = parsePsbt(psbtHexes[p]);
    for (let i = 0; i < first.inputs.length; i++) {
      const otherSigs = other.inputs[i].tapScriptSigs ?? [];
      if (!first.inputs[i].tapScriptSigs) first.inputs[i].tapScriptSigs = [];
      for (const sig of otherSigs) {
        const exists = first.inputs[i].tapScriptSigs!.some(
          s => toHex(s.pubkey) === toHex(sig.pubkey) && toHex(s.leafHash) === toHex(sig.leafHash)
        );
        if (!exists) first.inputs[i].tapScriptSigs!.push(sig);
      }
    }
  }
  return serializePsbt(first);
}

// ── Audited signer (@scure/btc-signer) -- primary path ──────────────────────────
//
// The public API below prefers @scure/btc-signer, the reviewed library from the
// same author as @noble/curves + @scure/bip32 (already dependencies). It signs
// Taproot script-path AND P2WSH, so this signer is compatible with every vault
// shape the compiler can emit (the "all vaults" requirement), and we stop
// depending on hand-rolled sighash math for money.
//
// SAFETY: each public function tries the audited library first and falls back to
// the proven legacy implementation ONLY when the library declines the PSBT, so a
// compiler-PSBT quirk can never regress today's working Taproot flow. Both paths
// are fail-closed -- zero signatures throws rather than returning an empty/bad
// PSBT. The library path is proven end-to-end (build -> sign -> combine ->
// finalize -> extract, Taproot single/multi-leaf + P2WSH) by
// scripts/test-psbt-signer.mjs, which runs in `npm test`. The one boundary that
// still needs a live signet round-trip -- that a PSBT built by OUR Rust compiler
// finalizes through rust-miniscript after btc-signer signs it -- is why the
// legacy fallback stays until that run confirms the library on real vault PSBTs.

const BTC_PSBT_OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true } as const;

// Derive the /0/0 receive-chain child private key -- the key whose pubkey is
// embedded in the leaf scripts (Nunchuk parity). Same derivation the legacy
// path uses.
function deriveSigningKey(
  mnemonic: string,
  derivationPath: string,
  network: "testnet" | "bitcoin",
): Uint8Array {
  const networkVersions = network === "bitcoin"
    ? { private: 0x0488ade4, public: 0x0488b21e }
    : { private: 0x04358394, public: 0x043587cf };
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed, networkVersions);
  const account = root.derive(derivationPath);
  const child00 = account.deriveChild(0).deriveChild(0);
  if (!child00.privateKey) throw new Error("Could not derive private key");
  return child00.privateKey;
}

/**
 * Sign a PSBT with the /0/0 key derived from a mnemonic. Prefers the audited
 * @scure/btc-signer (Taproot script-path + P2WSH); falls back to the proven
 * legacy Taproot signer only if the library signs nothing. Fail-closed: throws
 * if neither path can sign.
 */
export async function signPsbtWithMnemonic(
  psbtHex: string,
  mnemonic: string,
  derivationPath: string,
  network: "testnet" | "bitcoin",
): Promise<SignResult> {
  try {
    const privKey = deriveSigningKey(mnemonic, derivationPath, network);
    const tx = btc.Transaction.fromPSBT(fromHex(psbtHex), BTC_PSBT_OPTS);
    let added = 0;
    try {
      // Allow Taproot SIGHASH_DEFAULT and P2WSH SIGHASH_ALL.
      added = tx.sign(privKey, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
    } catch {
      // "No inputs signed" (this key isn't in the PSBT) or any library refusal.
      added = 0;
    }
    if (added > 0) {
      return { psbt_hex: toHex(tx.toPSBT()), signaturesAdded: added };
    }
  } catch {
    // Library couldn't parse this PSBT -- fall through to the legacy signer so
    // the working Taproot path is never regressed.
  }
  return signPsbtLegacy(psbtHex, mnemonic, derivationPath, network);
}

/**
 * Count signatures present in a PSBT (Taproot tap_script_sig / tap_key_sig and
 * P2WSH partial sigs). Falls back to the legacy tap_script_sig counter.
 */
export function countSignatures(psbtHex: string): number {
  try {
    const tx = btc.Transaction.fromPSBT(fromHex(psbtHex), BTC_PSBT_OPTS);
    let n = 0;
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      n += inp.tapScriptSig?.length ?? 0;
      n += inp.partialSig?.length ?? 0;
      if (inp.tapKeySig) n += 1;
    }
    return n;
  } catch {
    return countSignaturesLegacy(psbtHex);
  }
}

/**
 * Merge partially-signed PSBTs into one (combines Taproot AND P2WSH partial
 * sigs). Falls back to the legacy tap_script_sig-only merge.
 */
export function mergePsbts(psbtHexes: string[]): string {
  if (psbtHexes.length === 0) throw new Error("No PSBTs to merge");
  try {
    return toHex(btc.PSBTCombine(psbtHexes.map(fromHex)));
  } catch {
    return mergePsbtsLegacy(psbtHexes);
  }
}
