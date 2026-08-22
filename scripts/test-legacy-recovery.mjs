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
  legacyOnChainNonceMessage,
  legacyOnChainIdentity,
  signLegacyOnChainNonce,
  verifyLegacyOnChainNonceSignature,
  deriveLegacyOnChainKey,
  sealBundleOnChain,
  recoverViaOnChainPath,
  bitcoinMessageDigest,
  unb64,
} from '../apps/web/src/lib/legacy-recovery.ts';

const network = 'testnet';

// ── The path is one fixed constant per network -- no vault index at all
// any more, so the same seed always lands on the same single address
// regardless of how many vaults it publishes Legacy Recovery for. ───────
const path = legacyOnChainDerivationPath(network);
assert.equal(path, legacyOnChainDerivationPath(network), 'the path must always be the exact same string for a given network');
assert.equal(path, "m/84'/1'/900000'/1/0");
assert.equal(legacyOnChainDerivationPath('mainnet'), "m/84'/0'/900000'/1/0");

// ── The signed message is a function of the nonce, not anything
// memorized -- different nonces produce different messages, and the
// same nonce always produces the exact same message. ────────────────────
const nonceA = new Uint8Array(12).fill(1);
const nonceB = new Uint8Array(12).fill(2);
assert.equal(legacyOnChainNonceMessage(nonceA), legacyOnChainNonceMessage(nonceA));
assert.notEqual(legacyOnChainNonceMessage(nonceA), legacyOnChainNonceMessage(nonceB));

// bitcoinMessageDigest must be a plain function of the message text.
assert.deepEqual(
  bitcoinMessageDigest(legacyOnChainNonceMessage(nonceA)),
  bitcoinMessageDigest(legacyOnChainNonceMessage(nonceA)),
);

// ── Deterministic signature: same mnemonic + network + nonce -> the
// exact same signature every time (RFC 6979, no random nonce) -- this is
// what lets the signature itself double as a reproducible decryption
// key. ────────────────────────────────────────────────────────────────
const mnemonic = generateMnemonic(wordlist);
const sigA = signLegacyOnChainNonce(mnemonic, network, nonceA);
const sigB = signLegacyOnChainNonce(mnemonic, network, nonceA);
assert.deepEqual(sigA, sigB, 'signing the same message with the same key twice must produce byte-identical signatures');
assert.equal(sigA.length, 64, 'compact ECDSA signature must be 64 bytes (r || s)');
const sigDifferentNonce = signLegacyOnChainNonce(mnemonic, network, nonceB);
assert.notDeepEqual(sigA, sigDifferentNonce, 'a different nonce must sign a different message and produce a different signature');

// ── verifyLegacyOnChainNonceSignature: true only for the right
// signature, pubkey, and nonce all matching -- a hardware wallet
// reproducing the signature later must verify against the same identity
// pubkey derived at seal time. ──────────────────────────────────────────
const { publicKey: identityPubkey } = legacyOnChainIdentity(mnemonic, network);
assert.equal(verifyLegacyOnChainNonceSignature(sigA, identityPubkey, nonceA), true, 'the real signature must verify against its own identity pubkey');
assert.equal(verifyLegacyOnChainNonceSignature(sigDifferentNonce, identityPubkey, nonceA), false, 'a signature over the WRONG nonce message must not verify');
const wrongMnemonic = generateMnemonic(wordlist);
const sigWrongKey = signLegacyOnChainNonce(wrongMnemonic, network, nonceA);
assert.equal(verifyLegacyOnChainNonceSignature(sigWrongKey, identityPubkey, nonceA), false, 'a signature from a DIFFERENT key must not verify against this identity pubkey');

// ── deriveLegacyOnChainKey: deterministic. Domain separation now comes
// from the nonce baked into the SIGNATURE itself (a different nonce
// signs a different message and so produces a different signature),
// not from a separate index tag. ────────────────────────────────────────
const keyA = deriveLegacyOnChainKey(sigA);
const keyB = deriveLegacyOnChainKey(sigA);
assert.deepEqual(keyA, keyB, 'the same signature must always derive the same key');
assert.equal(keyA.length, 32, 'derived key must be 32 bytes (AES-256)');
const keyFromDifferentNonceSig = deriveLegacyOnChainKey(sigDifferentNonce);
assert.notDeepEqual(keyA, keyFromDifferentNonceSig, 'a signature over a different nonce must derive a different key');

// ── Full round trip: seal (which picks its own random nonce, signs it,
// and encrypts with the resulting key), then find that SAME nonce in
// the sealed bundle, INDEPENDENTLY re-sign it (as a real recovery would
// -- sign again, don't reuse the seal-time signature) and recover.
// Proves this is genuinely reproducible from just the key and the
// on-chain data, not only internally self-consistent within one call. ──
const bundleText = 'descriptor=tr(...); policy=or(thresh(2,pk(A),pk(B)),and(after(500000),pk(C)))';
const { sealed, identityPubkey: sealedIdentityPubkey } = await sealBundleOnChain(bundleText, mnemonic, network);
assert.deepEqual(sealedIdentityPubkey, identityPubkey, 'sealBundleOnChain must expose the same identity pubkey legacyOnChainIdentity derives');

const sealedNonce = unb64(sealed.nonceB64);
assert.equal(sealedNonce.length, 12, 'the AES-GCM nonce must be 12 bytes');
const recoverySignature = signLegacyOnChainNonce(mnemonic, network, sealedNonce); // re-derived independently, not reused
assert.equal(verifyLegacyOnChainNonceSignature(recoverySignature, sealedIdentityPubkey, sealedNonce), true, 'recovery-time signature must verify before attempting to decrypt');
const recoveredBundle = await recoverViaOnChainPath(recoverySignature, sealed);
assert.equal(recoveredBundle, bundleText, 'bundle recovered via the on-chain path must byte-match the original');

// ── Wrong key must fail closed (AEAD failure), never produce a
// wrong-but-plausible plaintext. ─────────────────────────────────────
const wrongKeySignature = signLegacyOnChainNonce(wrongMnemonic, network, sealedNonce);
await assert.rejects(
  recoverViaOnChainPath(wrongKeySignature, sealed),
  'decrypting with a signature from the wrong key must fail, not silently succeed',
);

// ── Tamper detection: a mutated ciphertext must fail to decrypt even
// with the RIGHT signature -- AES-GCM is authenticated, not just
// confidential. ──────────────────────────────────────────────────────
const tampered = { ...sealed, ciphertextB64: sealed.ciphertextB64.slice(0, -4) + 'AAAA' };
await assert.rejects(
  recoverViaOnChainPath(recoverySignature, tampered),
  'a tampered ciphertext must fail AEAD verification, never decrypt to a different valid plaintext',
);

console.log('legacy-recovery tests passed');
