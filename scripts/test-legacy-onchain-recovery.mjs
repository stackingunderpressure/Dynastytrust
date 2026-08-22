// Round-trip proof for the on-chain publish/scan orchestration (see
// apps/web/src/lib/legacy-onchain-recovery.ts). Imports the real app
// source via Node's native TS type-stripping, same convention as the
// other test-*.mjs scripts. Proves the FULL loop end to end: seal a
// bundle for a keyholder (sealOnChainPayload -- picks its own random
// nonce, signs it, no transaction), build + sign a REAL publish
// transaction paid for by a totally separate key (buildAndSignPublishTx's
// payTo option -- the identity key never signs a transaction, only ever
// a message over that nonce), simulate what mempool.space would hand
// back for the identity address (parsed straight from the actual signed
// tx, not a hand-typed fixture), extract the payload the way a real
// scanner would, and recover the exact original bundle text using an
// INDEPENDENTLY re-derived signature over the found nonce (not the one
// used to seal) -- exactly what a real recovery does decades later with
// nothing but a seed and the chain. No vault index anywhere in this
// flow any more -- one seed, one fixed address, the nonce alone
// separates one seal from the next.
import assert from 'node:assert/strict';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import {
  legacyOnChainLookupAddress,
  sealOnChainPayload,
  sealOnChainPayloadExternal,
  extractOnChainCandidates,
  toPublishNetwork,
} from '../apps/web/src/lib/legacy-onchain-recovery.ts';
import {
  legacyOnChainIdentity,
  legacyOnChainIdentityFromXpub,
  legacyOnChainDerivationPath,
  legacyOnChainNonceMessage,
  signLegacyOnChainNonce,
  verifyLegacyOnChainNonceSignature,
  recoverViaOnChainPath,
  bitcoinMessageDigest,
  unb64,
} from '../apps/web/src/lib/legacy-recovery.ts';
import { p2wpkhAddressForPubkey, buildAndSignPublishTx } from '../apps/web/src/lib/onchain-publish.ts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { networkVersions } from '../apps/web/src/lib/keystore.ts';

const network = 'testnet';
const mnemonic = generateMnemonic(wordlist); // the keyholder whose vault descriptor this seals
const payerMnemonic = generateMnemonic(wordlist); // a totally unrelated key that just pays the fee
const payerDerivationPath = "m/86'/1'/0'";
const bundleText = 'descriptor=tr(...); policy=or(thresh(2,pk(A),pk(B)),and(after(500000),pk(C)))';

// ── legacyOnChainLookupAddress matches the address independently derived
// from the same hardened identity keypair -- the recovering keyholder and
// the sealing keyholder (same person, different moments) must land on
// the identical address every time, with no index of any kind involved.
const { publicKey: identityPubkey } = legacyOnChainIdentity(mnemonic, network);
const expectedAddress = p2wpkhAddressForPubkey(
  Array.from(identityPubkey).map(b => b.toString(16).padStart(2, '0')).join(''),
  toPublishNetwork(network),
);
const lookupAddress = legacyOnChainLookupAddress(mnemonic, network);
assert.equal(lookupAddress, expectedAddress, 'lookup address must match the identity keypair\'s own P2WPKH address');
assert.equal(lookupAddress, legacyOnChainLookupAddress(mnemonic, network), 'the lookup address must be the exact same every time -- no index to vary it');
assert.ok(lookupAddress.startsWith('tb1q'), `expected a testnet P2WPKH address, got ${lookupAddress}`);

// ── Seal the payload -- no transaction involved, no keypair beyond the
// identity's own signature over a freshly-generated random nonce. ───────
const { payloadHex, address, identityPubkeyHex } = await sealOnChainPayload({ bundleText, mnemonic, network });
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

// ── Recover by reading the nonce straight off the found candidate and
// INDEPENDENTLY re-signing it -- not reused from sealing -- exactly what
// a real recovery does. Nothing here needed a vault index at any point.
const foundNonce = unb64(candidates[0].sealed.nonceB64);
const recoverySignature = signLegacyOnChainNonce(mnemonic, network, foundNonce);
assert.equal(
  verifyLegacyOnChainNonceSignature(recoverySignature, identityPubkey, foundNonce),
  true,
  'the independently re-derived recovery signature must verify against the identity pubkey found on-chain',
);
const recoveredBundle = await recoverViaOnChainPath(recoverySignature, candidates[0].sealed);
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

// ── Hardware-wallet seal path: no mnemonic touches sealOnChainPayloadExternal
// at all -- only an account-level xpub (what a hardware wallet exports for
// legacyOnChainDerivationPath's parent account, m/84'/coin'/900000') and a
// signature "produced" externally (simulated here by signing with the same
// keypair, standing in for a hardware wallet's own "Sign Message" feature --
// the point being proven is that the LIBRARY needs nothing but the xpub and
// the signature, not that this specific signature came from real hardware).
const seed = mnemonicToSeedSync(mnemonic);
const root = HDKey.fromMasterSeed(seed, networkVersions(network));
const coin = network === 'mainnet' ? '0' : '1';
const accountXpub = root.derive(`m/84'/${coin}'/900000'`).publicExtendedKey;

// legacyOnChainIdentityFromXpub must derive the exact same child pubkey as
// the mnemonic-based legacyOnChainIdentity -- same key, two different ways
// to get there (with vs. without the seed).
const { publicKey: xpubDerivedPubkey } = legacyOnChainIdentityFromXpub(accountXpub, network);
assert.deepEqual(
  Array.from(xpubDerivedPubkey),
  Array.from(identityPubkey),
  'an xpub exported at the fixed Legacy Recovery account must derive the identical child pubkey the mnemonic-based path derives',
);

const hwNonce = crypto.getRandomValues(new Uint8Array(12));
// Stand-in for "sign this message on your hardware wallet's screen":
// the exact same classic-message-signing digest DescriptorRetrieval.tsx
// asks a real hardware wallet to sign, produced here with the identity
// keypair's own private key rather than real hardware.
const hwDigest = bitcoinMessageDigest(legacyOnChainNonceMessage(hwNonce));
const { privateKey: identityPrivateKey } = legacyOnChainIdentity(mnemonic, network);
const hwSignature = secp256k1.sign(hwDigest, identityPrivateKey).toCompactRawBytes();
assert.equal(
  verifyLegacyOnChainNonceSignature(hwSignature, xpubDerivedPubkey, hwNonce),
  true,
  'a signature produced externally over the correct nonce must verify against the xpub-derived pubkey',
);

const externalSealed = await sealOnChainPayloadExternal({
  bundleText, accountXpub, nonce: hwNonce, signature: hwSignature, network,
});
assert.equal(externalSealed.address, lookupAddress, 'the hardware-sealed payload\'s address must match the same fixed lookup address');
assert.equal(externalSealed.identityPubkeyHex, identityPubkeyHex);

// Recovery doesn't care how a share was sealed -- decode the external
// payload the same way a real scanner would and recover it with an
// independently re-signed nonce, same as the mnemonic-sealed case above.
// Uses btc.Script.encode (the exact inverse of extractOnChainCandidates'
// own btc.Script.decode) to build the OP_RETURN script, rather than
// hand-computing push-length bytes, which would risk a framing bug in
// the TEST rather than proving anything about the real code.
const externalOpReturnScript = btc.Script.encode(['RETURN', Uint8Array.from(Buffer.from(externalSealed.payloadHex, 'hex'))]);
const externalScanned = extractOnChainCandidates([{
  txid: 'd'.repeat(64),
  vout: [{ scriptpubkey_type: 'op_return', scriptpubkey: Array.from(externalOpReturnScript).map(b => b.toString(16).padStart(2, '0')).join('') }],
}]);
assert.equal(externalScanned.length, 1, 'a hardware-sealed payload must scan the same way a software-sealed one does');
const externalFoundNonce = unb64(externalScanned[0].sealed.nonceB64);
const externalRecoverySignature = signLegacyOnChainNonce(mnemonic, network, externalFoundNonce);
const externalRecovered = await recoverViaOnChainPath(externalRecoverySignature, externalScanned[0].sealed);
assert.equal(externalRecovered, bundleText, 'a bundle sealed via the hardware-wallet (xpub + external signature) path must recover byte-identical to the original');

// Sealing with a signature over the WRONG nonce must fail loudly, not
// silently produce an unrecoverable share.
const wrongNonce = crypto.getRandomValues(new Uint8Array(12));
await assert.rejects(
  sealOnChainPayloadExternal({ bundleText, accountXpub, nonce: wrongNonce, signature: hwSignature, network }),
  /does not match/,
  'sealing with a signature over a different nonce than the one being sealed must be rejected up front',
);

console.log('legacy-onchain-recovery tests passed');
