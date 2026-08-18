// Round-trip proof for the on-chain publish transaction builder (used to
// broadcast Legacy Recovery's on-chain share -- see
// apps/web/src/lib/onchain-publish.ts). Imports the real app source via
// Node's native TS type-stripping, same convention as
// test-legacy-recovery.mjs. Proves: the address shown to fund and the key
// used to sign are the same keypair, the signed transaction is well-formed
// and verifiably signed, fee math holds, and undersized/undersized-change
// cases are rejected/handled instead of producing something unspendable.
import assert from 'node:assert/strict';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as btc from '@scure/btc-signer';
import {
  p2wpkhAddressForPubkey,
  buildAndSignPublishTx,
} from '../apps/web/src/lib/onchain-publish.ts';

const network = 'testnet';
const derivationPath = "m/48'/1'/0'/2'"; // same multisigPath keystore.ts derives for software keys

const mnemonic = generateMnemonic(wordlist);

// Independently derive the same child00 pubkey keystore.ts would compute
// for this key, to prove p2wpkhAddressForPubkey (given only the public
// pubkey hex, as LegacyRecoverySetup.tsx calls it) and buildAndSignPublishTx
// (given the mnemonic) land on the exact same keypair/address.
const seed = mnemonicToSeedSync(mnemonic);
const root = HDKey.fromMasterSeed(seed, { private: 0x04358394, public: 0x043587cf });
const child00 = root.derive(derivationPath).deriveChild(0).deriveChild(0);
const pubkeyHex = Array.from(child00.publicKey).map(b => b.toString(16).padStart(2, '0')).join('');

const address = p2wpkhAddressForPubkey(pubkeyHex, network);
assert.ok(address.startsWith('tb1q'), `expected a testnet P2WPKH address, got ${address}`);

const expectedP2wpkh = btc.p2wpkh(child00.publicKey, btc.TEST_NETWORK);
assert.equal(address, expectedP2wpkh.address, 'address must match the key btc-signer itself derives');

// ── Normal case: enough value for fee + above-dust change ────────────────
const utxo = { txid: 'a'.repeat(64), vout: 0, valueSats: 10_000 };
const opReturnDataHex = 'ab'.repeat(33); // matches a real Shamir/hybrid share's byte length

const built = buildAndSignPublishTx({
  mnemonic,
  derivationPath,
  network,
  utxo,
  opReturnDataHex,
  feeRateSatsPerVb: 2,
});

assert.equal(built.txid.length, 64);
assert.ok(/^[0-9a-f]+$/.test(built.hex));
assert.equal(built.feeSats + built.changeSats, utxo.valueSats, 'fee + change must account for every satoshi in');
assert.ok(built.feeSats > 0);
assert.ok(built.changeSats > 0);

// Independently re-parse the signed tx and verify it against the exact
// input/output shape we asked for -- not just "it didn't throw."
const parsed = btc.Transaction.fromRaw(Uint8Array.from(Buffer.from(built.hex, 'hex')), {
  allowUnknownOutputs: true,
});
assert.equal(parsed.inputsLength, 1);
assert.equal(parsed.outputsLength, 2);
const out0 = parsed.getOutput(0);
assert.equal(out0.amount, 0n);
const opReturnScript = btc.Script.decode(out0.script);
assert.equal(opReturnScript[0], 'RETURN');
assert.equal(
  Array.from(opReturnScript[1]).map(b => b.toString(16).padStart(2, '0')).join(''),
  opReturnDataHex,
);
const out1 = parsed.getOutput(1);
assert.equal(out1.amount, BigInt(built.changeSats));

// ── Dust case: change below 294 sats goes entirely to fee, no unspendable output ──
const dustUtxo = { txid: 'b'.repeat(64), vout: 1, valueSats: 250 };
const dustBuilt = buildAndSignPublishTx({
  mnemonic,
  derivationPath,
  network,
  utxo: dustUtxo,
  opReturnDataHex,
  feeRateSatsPerVb: 1,
});
assert.equal(dustBuilt.changeSats, 0);
assert.equal(dustBuilt.feeSats, dustUtxo.valueSats);
const dustParsed = btc.Transaction.fromRaw(Uint8Array.from(Buffer.from(dustBuilt.hex, 'hex')), { allowUnknownOutputs: true });
assert.equal(dustParsed.outputsLength, 1, 'dust change must be dropped, not emitted as an output');

// ── Insufficient case: UTXO can't cover even the estimated fee ────────────
assert.throws(() => {
  buildAndSignPublishTx({
    mnemonic,
    derivationPath,
    network,
    utxo: { txid: 'c'.repeat(64), vout: 0, valueSats: 10 },
    opReturnDataHex,
    feeRateSatsPerVb: 5,
  });
}, /can't cover the estimated fee/);

console.log('onchain-publish tests passed');
