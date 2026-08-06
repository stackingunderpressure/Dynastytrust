// Parity gate for Cut B stage B0 (docs/integration-phase1-signin-and-bridge.md):
// "This test is the gate. No signing bridge ships until it is green."
//
// This module is vendored byte-identically into every repo that needs it
// (same pattern as tapit-attest, see ../src/index.ts's header comment and
// tapit-attest/STANDARDIZATION.md for the precedent). This file is mirrored
// identically alongside it. The fixture below is a hand-built, deterministic
// PSBT (fixed placeholder bytes, not real chain data) run through
// tapLeafHash + tapscriptSighash once against the canonical copy; the
// resulting hex was captured and hardcoded as the expected values here.
// Because the test is vendored byte-for-byte, running it in each repo's own
// CI against that repo's own copy of src/index.ts proves the two copies
// compute identical bytes for identical input -- without the two repos
// needing to talk to each other at test time, the same way INTEGRITY.sha256
// proves tapit-attest is unchanged by comparing hashes rather than running
// cross-repo. If ANY repo's copy of index.ts has drifted -- even by one
// byte, even a "harmless" refactor -- this test fails there and only there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromHex,
  toHex,
  varint,
  parsePsbt,
  serializePsbt,
  tapLeafHash,
  tapscriptSighash,
} from '../dist/index.js';

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
function w32(n) {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >> 8) & 0xff;
  b[2] = (n >> 16) & 0xff;
  b[3] = (n >> 24) & 0xff;
  return b;
}
function w64(n) {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
}
function kv(key, value) {
  return concat(varint(key.length), key, varint(value.length), value);
}

// Deterministic fixture: one taproot script-path input, one output.
// Every byte is a fixed placeholder pattern -- not real chain data, never
// meant to be. Only determinism matters here.
function buildFixturePsbt() {
  const txid = fromHex('11'.repeat(32));
  const vout = 0;
  const sequence = 0xfffffffd;
  const scriptPubkey = concat(new Uint8Array([0x51, 0x20]), fromHex('22'.repeat(32)));
  const outAmount = 100000n;
  const locktime = 0;

  const rawTx = concat(
    w32(2),
    varint(1),
    txid,
    w32(vout),
    varint(0),
    w32(sequence),
    varint(1),
    w64(outAmount),
    varint(scriptPubkey.length),
    scriptPubkey,
    w32(locktime),
  );

  const witnessAmount = 150000n;
  const witnessUtxoValue = concat(
    w64(witnessAmount),
    varint(scriptPubkey.length),
    scriptPubkey,
  );

  const leafScript = fromHex('51'); // placeholder script body
  const leafVersion = 0xc0;
  const controlBlock = fromHex('c0' + '33'.repeat(32));
  const tapLeafScriptKey = concat(new Uint8Array([0x15]), controlBlock);
  const tapLeafScriptValue = concat(leafScript, new Uint8Array([leafVersion]));

  const psbtBytes = concat(
    fromHex('70736274ff'),
    kv(new Uint8Array([0x00]), rawTx),
    new Uint8Array([0x00]),
    kv(new Uint8Array([0x01]), witnessUtxoValue),
    kv(tapLeafScriptKey, tapLeafScriptValue),
    new Uint8Array([0x00]),
    new Uint8Array([0x00]),
  );

  return { psbtHex: toHex(psbtBytes), leafScript, leafVersion };
}

const EXPECTED_PSBT_HEX =
  '70736274ff01005e020000000111111111111111111111111111111111111111111111111111111111111111110000000000fdffffff01a0860100000000002251202222222222222222222222222222222222222222222222222222222222222222000000000001012bf04902000000000022512022222222222222222222222222222222222222222222222222222222222222222215c033333333333333333333333333333333333333333333333333333333333333330251c00000';
const EXPECTED_LEAF_HASH =
  'a85b2107f791b26a84e7586c28cec7cb61202ed3d01944d832500f363782d675';
const EXPECTED_SIGHASH =
  '52d162745e69a591373c736ab1eae370d60290dac934c8d01fcb89c965491195';

test('fixture PSBT is byte-identical to the captured golden hex', () => {
  const { psbtHex } = buildFixturePsbt();
  assert.equal(psbtHex, EXPECTED_PSBT_HEX);
});

test('tapLeafHash matches the golden leaf hash for this leaf', () => {
  const { leafScript, leafVersion } = buildFixturePsbt();
  const leafHash = toHex(tapLeafHash(leafScript, leafVersion));
  assert.equal(leafHash, EXPECTED_LEAF_HASH);
});

test('tapscriptSighash matches the golden sighash -- THE PARITY GATE', () => {
  const { psbtHex, leafScript, leafVersion } = buildFixturePsbt();
  const parsed = parsePsbt(psbtHex);
  const leafHash = tapLeafHash(leafScript, leafVersion);
  const sighash = toHex(tapscriptSighash(parsed, 0, leafHash, 0x00));
  assert.equal(sighash, EXPECTED_SIGHASH);
});

test('serializePsbt round-trips an injected tap_script_sig', () => {
  const { psbtHex, leafScript, leafVersion } = buildFixturePsbt();
  const parsed = parsePsbt(psbtHex);
  const leafHash = tapLeafHash(leafScript, leafVersion);
  parsed.inputs[0].tapScriptSigs = [
    { pubkey: fromHex('44'.repeat(32)), leafHash, sig: fromHex('55'.repeat(64)) },
  ];
  const resigned = serializePsbt(parsed);
  const reparsed = parsePsbt(resigned);
  assert.equal(reparsed.inputs[0].tapScriptSigs.length, 1);
  assert.equal(toHex(reparsed.inputs[0].tapScriptSigs[0].sig), '55'.repeat(64));
});
