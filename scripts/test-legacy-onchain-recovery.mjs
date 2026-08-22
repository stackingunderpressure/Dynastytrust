// Round-trip proof for the on-chain publish/scan orchestration (see
// apps/web/src/lib/legacy-onchain-recovery.ts). Imports the real app
// source via Node's native TS type-stripping, same convention as the
// other test-*.mjs scripts. Proves the FULL loop end to end: seal a
// bundle for a keyholder (sealOnChainPayload -- no transaction), build
// + sign a REAL publish transaction paid for by a totally separate key
// (buildAndSignPublishTx's payTo option -- the identity key never signs
// a transaction, only ever a message), simulate what mempool.space would
// hand back for the identity address (parsed straight from the actual
// signed tx, not a hand-typed fixture), extract the payload the way a
// real scanner would, and recover the exact original bundle text using
// an INDEPENDENTLY re-derived signature (not the one used to seal) --
// exactly what a real recovery does decades later with nothing but a
// seed and the chain.
import assert from 'node:assert/strict';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import * as btc from '@scure/btc-signer';
import {
  legacyOnChainLookupAddress,
  sealOnChainPayload,
  extractOnChainCandidates,
  toPublishNetwork,
} from '../apps/web/src/lib/legacy-onchain-recovery.ts';
import {
  legacyOnChainIdentity,
  signLegacyOnChainUnlock,
  verifyLegacyOnChainSignature,
  recoverViaOnChainPath,
} from '../apps/web/src/lib/legacy-recovery.ts';
import { p2wpkhAddressForPubkey, buildAndSignPublishTx } from '../apps/web/src/lib/onchain-publish.ts';

const network = 'testnet';
const vaultIndex = 0;
const mnemonic = generateMnemonic(wordlist); // the keyholder whose vault descriptor this seals
const payerMnemonic = generateMnemonic(wordlist); // a totally unrelated key that just pays the fee
const payerDerivationPath = "m/86'/1'/0'";
const bundleText = 'descriptor=tr(...); policy=or(thresh(2,pk(A),pk(B)),and(after(500000),pk(C)))';

// ── legacyOnChainLookupAddress matches the address independently derived
// from the same hardened identity keypair -- the recovering keyholder and
// the sealing keyholder (same person, different moments) must land on
// the identical address every time.
const { publicKey: identityPubkey } = legacyOnChainIdentity(mnemonic, network, vaultIndex);
const expectedAddress = p2wpkhAddressForPubkey(
  Array.from(identityPubkey).map(b => b.toString(16).padStart(2, '0')).join(''),
  toPublishNetwork(network),
);
const lookupAddress = legacyOnChainLookupAddress(mnemonic, network, vaultIndex);
assert.equal(lookupAddress, expectedAddress, 'lookup address must match the identity keypair\'s own P2WPKH address');
assert.ok(lookupAddress.startsWith('tb1q'), `expected a testnet P2WPKH address, got ${lookupAddress}`);

// ── Seal the payload -- no transaction involved, no keypair beyond the
// identity's own signature. ─────────────────────────────────────────────
const { payloadHex, address, identityPubkeyHex } = await sealOnChainPayload({
  bundleText, mnemonic, network, vaultIndex,
});
assert.equal(address, lookupAddress, 'the sealed payload\'s target address must be the exact same address a recovering keyholder would derive');
assert.equal(
  identityPubkeyHex,
  Array.from(identityPubkey).map(b => b.toString(16).padStart(2, '0')).join(''),
);

// ── Build + sign the REAL publish transaction -- paid for by a totally
// separate, unrelated key (payerMnemonic), spending ITS OWN UTXO, with
// the identity address as a payTo output alongside the OP_RETURN. The
// identity key/address never appears as an input, never signs anything.
const utxo = { txid: 'a'.repeat(64), vout: 0, valueSats: 20_000 };
const billboardSats = 1000;
const built = buildAndSignPublishTx({
  mnemonic: payerMnemonic,
  derivationPath: payerDerivationPath,
  network: toPublishNetwork(network),
  utxo,
  opReturnDataHex: payloadHex,
  feeRateSatsPerVb: 2,
  payTo: { address, amountSats: billboardSats },
});
assert.equal(built.payToSats, billboardSats, 'the billboard payment amount must match what was requested');
assert.equal(built.txid.length, 64);
assert.ok(built.feeSats > 0);

// ── Simulate mempool.space's response for the IDENTITY address: parse
// the REAL signed tx (not a hand-built fixture) and reshape its outputs
// into the { scriptpubkey_type, scriptpubkey } shape mempool.space's API
// returns. This transaction touches the identity address only as an
// OUTPUT (the billboard payment) -- proving that's sufficient for a
// scanner of that address to find it, no input relationship needed.
const parsed = btc.Transaction.fromRaw(Uint8Array.from(Buffer.from(built.hex, 'hex')), {
  allowUnknownOutputs: true,
});
const vout = [];
for (let i = 0; i < parsed.outputsLength; i++) {
  const out = parsed.getOutput(i);
  const scriptHex = Array.from(out.script).map(b => b.toString(16).padStart(2, '0')).join('');
  const isOpReturn = out.script.length > 0 && out.script[0] === 0x6a;
  vout.push({ scriptpubkey_type: isOpReturn ? 'op_return' : 'v0_p2wpkh', scriptpubkey: scriptHex });
}
const mempoolShapedTxs = [{ txid: built.txid, vout }];

// ── Scan -> extract -> should find exactly this one candidate.
const candidates = extractOnChainCandidates(mempoolShapedTxs);
assert.equal(candidates.length, 1, 'must find exactly one payload at this address\'s (simulated) transaction history');
assert.equal(candidates[0].txid, built.txid);

// ── Recover using an INDEPENDENTLY re-derived signature -- not reused
// from sealing -- exactly what a real recovery does.
const recoverySignature = signLegacyOnChainUnlock(mnemonic, network, vaultIndex);
assert.equal(
  verifyLegacyOnChainSignature(recoverySignature, identityPubkey, vaultIndex),
  true,
  'the independently re-derived recovery signature must verify against the identity pubkey found on-chain',
);
const recoveredBundle = await recoverViaOnChainPath(recoverySignature, vaultIndex, candidates[0].sealed);
assert.equal(recoveredBundle, bundleText, 'bundle recovered end-to-end (seal -> publish tx -> scan -> decrypt) must byte-match the original');

// ── Negative cases: extractOnChainCandidates must cleanly skip non-
// OP_RETURN outputs and OP_RETURN outputs that aren't this payload format
// (garbage, or someone else's data sent to this now-public address),
// never throw.
const junkTxs = [
  { txid: 'b'.repeat(64), vout: [{ scriptpubkey_type: 'v0_p2wpkh', scriptpubkey: '0014' + 'ab'.repeat(20) }] },
  {
    txid: 'c'.repeat(64),
    vout: [{ scriptpubkey_type: 'op_return', scriptpubkey: '6a' + '04' + 'deadbeef' }], // valid OP_RETURN, wrong magic/format
  },
];
assert.deepEqual(extractOnChainCandidates(junkTxs), [], 'non-matching outputs must be silently skipped, not throw');

// A single scan can hold both a real payload and junk in the same list --
// only the real one should surface.
assert.deepEqual(
  extractOnChainCandidates([...junkTxs, ...mempoolShapedTxs]).map(c => c.txid),
  [built.txid],
  'a mixed list of junk and a real payload must surface only the real one',
);

console.log('legacy-onchain-recovery tests passed');
