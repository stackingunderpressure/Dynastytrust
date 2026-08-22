// Round-trip proof for the Legacy Recovery crypto core. Plain
// node:assert, no framework, matching scripts/test-policy.mjs's
// convention. Imports the real apps/web/src/lib/legacy-recovery.ts
// directly via Node's native TS type-stripping -- no build step, no
// mocks, the exact code the app ships.
import assert from 'node:assert/strict';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  legacyOnChainDerivationPath,
  legacyOnChainUnlockMessage,
  legacyOnChainIdentity,
  signLegacyOnChainUnlock,
  verifyLegacyOnChainSignature,
  deriveLegacyOnChainKey,
  sealBundleOnChain,
  recoverViaOnChainPath,
  bitcoinMessageDigest,
} from '../apps/web/src/lib/legacy-recovery.ts';

const network = 'testnet';

// ── Path is fixed for a given (network, vaultIndex); different index ->
// different path. ───────────────────────────────────────────────────────
const pathA = legacyOnChainDerivationPath(network, 0);
assert.equal(pathA, legacyOnChainDerivationPath(network, 0), 'same (network, vaultIndex) must always derive the same path');
assert.notEqual(pathA, legacyOnChainDerivationPath(network, 1), 'different vaultIndex must derive a different path');
assert.equal(pathA, "m/84'/1'/900000'/1/0");
assert.equal(legacyOnChainDerivationPath('mainnet', 0), "m/84'/0'/900000'/1/0");
assert.equal(legacyOnChainDerivationPath(network, 1), "m/84'/1'/900001'/1/0");
assert.throws(() => legacyOnChainDerivationPath(network, -1), /non-negative/, 'negative vaultIndex must be rejected');
assert.throws(() => legacyOnChainDerivationPath(network, 1.5), /whole number/, 'non-integer vaultIndex must be rejected');

// ── The signed message is fixed per vaultIndex, human-readable, and
// ASCII. ───────────────────────────────────────────────────────────────
assert.equal(legacyOnChainUnlockMessage(0), legacyOnChainUnlockMessage(0));
assert.notEqual(legacyOnChainUnlockMessage(0), legacyOnChainUnlockMessage(1));

// bitcoinMessageDigest must be a plain function of the message text.
assert.deepEqual(
  bitcoinMessageDigest(legacyOnChainUnlockMessage(0)),
  bitcoinMessageDigest(legacyOnChainUnlockMessage(0)),
);

// ── Deterministic signature: same mnemonic + network + vaultIndex -> the
// exact same signature every time (RFC 6979, no random nonce) -- this is
// what lets the signature itself double as a reproducible decryption
// key. ────────────────────────────────────────────────────────────────
const mnemonic = generateMnemonic(wordlist);
const vaultIndex = 0;
const sigA = signLegacyOnChainUnlock(mnemonic, network, vaultIndex);
const sigB = signLegacyOnChainUnlock(mnemonic, network, vaultIndex);
assert.deepEqual(sigA, sigB, 'signing the same message with the same key twice must produce byte-identical signatures');
assert.equal(sigA.length, 64, 'compact ECDSA signature must be 64 bytes (r || s)');
const sigDifferentIndex = signLegacyOnChainUnlock(mnemonic, network, 1);
assert.notDeepEqual(sigA, sigDifferentIndex, 'a different vaultIndex must sign a different message and produce a different signature');

// ── verifyLegacyOnChainSignature: true only for the right signature,
// pubkey, and index all matching -- a hardware wallet reproducing the
// signature later must verify against the same identity pubkey derived
// at seal time. ──────────────────────────────────────────────────────
const { publicKey: identityPubkey } = legacyOnChainIdentity(mnemonic, network, vaultIndex);
assert.equal(verifyLegacyOnChainSignature(sigA, identityPubkey, vaultIndex), true, 'the real signature must verify against its own identity pubkey');
assert.equal(verifyLegacyOnChainSignature(sigDifferentIndex, identityPubkey, vaultIndex), false, 'a signature over the WRONG vaultIndex message must not verify');
const wrongMnemonic = generateMnemonic(wordlist);
const sigWrongKey = signLegacyOnChainUnlock(wrongMnemonic, network, vaultIndex);
assert.equal(verifyLegacyOnChainSignature(sigWrongKey, identityPubkey, vaultIndex), false, 'a signature from a DIFFERENT key must not verify against this identity pubkey');

// ── deriveLegacyOnChainKey: deterministic, and domain-separated by
// vaultIndex so the same signature-producing key reused across a
// person's different vaults never derives the same encryption key
// twice. ──────────────────────────────────────────────────────────────
const keyA = deriveLegacyOnChainKey(sigA, vaultIndex);
const keyB = deriveLegacyOnChainKey(sigA, vaultIndex);
assert.deepEqual(keyA, keyB, 'the same signature + vaultIndex must always derive the same key');
assert.equal(keyA.length, 32, 'derived key must be 32 bytes (AES-256)');
const keyDifferentIndex = deriveLegacyOnChainKey(sigA, 1);
assert.notDeepEqual(keyA, keyDifferentIndex, 'the same signature under a different vaultIndex tag must derive a different key');

// ── Full round trip: seal, then INDEPENDENTLY re-derive the signature
// (as a real recovery would -- sign again, don't reuse the seal-time
// value) and recover. Proves this is genuinely reproducible from just
// the key, not only internally self-consistent within one call. ────────
const bundleText = 'descriptor=tr(...); policy=or(thresh(2,pk(A),pk(B)),and(after(500000),pk(C)))';
const { sealed, identityPubkey: sealedIdentityPubkey } =
  await sealBundleOnChain(bundleText, mnemonic, network, vaultIndex);
assert.deepEqual(sealedIdentityPubkey, identityPubkey, 'sealBundleOnChain must expose the same identity pubkey legacyOnChainIdentity derives');

const recoverySignature = signLegacyOnChainUnlock(mnemonic, network, vaultIndex); // re-derived independently, not reused
assert.equal(verifyLegacyOnChainSignature(recoverySignature, sealedIdentityPubkey, vaultIndex), true, 'recovery-time signature must verify before attempting to decrypt');
const recoveredBundle = await recoverViaOnChainPath(recoverySignature, vaultIndex, sealed);
assert.equal(recoveredBundle, bundleText, 'bundle recovered via the on-chain path must byte-match the original');

// ── Wrong key must fail closed (AEAD failure), never produce a
// wrong-but-plausible plaintext. ─────────────────────────────────────
const wrongKeySignature = signLegacyOnChainUnlock(wrongMnemonic, network, vaultIndex);
await assert.rejects(
  recoverViaOnChainPath(wrongKeySignature, vaultIndex, sealed),
  'decrypting with a signature from the wrong key must fail, not silently succeed',
);

// ── Tamper detection: a mutated ciphertext must fail to decrypt even
// with the RIGHT signature -- AES-GCM is authenticated, not just
// confidential. ──────────────────────────────────────────────────────
const tampered = { ...sealed, ciphertextB64: sealed.ciphertextB64.slice(0, -4) + 'AAAA' };
await assert.rejects(
  recoverViaOnChainPath(recoverySignature, vaultIndex, tampered),
  'a tampered ciphertext must fail AEAD verification, never decrypt to a different valid plaintext',
);

console.log('legacy-recovery tests passed');
