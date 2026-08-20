// Round-trip proof for the Legacy Recovery crypto core (stage 1 of the
// long-horizon descriptor recovery plan). Plain node:assert, no framework,
// matching scripts/test-policy.mjs's convention. Imports the real
// apps/web/src/lib/legacy-recovery.ts directly via Node's native TS
// type-stripping -- no build step, no mocks, the exact code the app ships.
import assert from 'node:assert/strict';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import {
  deriveLegacyLockBytes,
  lockShare,
  unlockShare,
  generateLegacySecret,
  sealBundle,
  unsealBundle,
  combineLegacySecret,
  splitLegacySecretHybrid,
  recoverViaFastPath,
  recoverViaFallbackPath,
  legacyDerivationPath,
  legacyUnlockMessage,
  bitcoinMessageDigest,
  signLegacyUnlockMessage,
  verifyLegacyUnlockSignature,
  deriveLegacyLockBytesFromSignature,
  legacyIdentityPubkeyFromMnemonic,
  legacyIdentityPubkeyFromXpub,
  detectXpubNetwork,
  descriptorFingerprint,
} from '../apps/web/src/lib/legacy-recovery.ts';

const network = 'testnet';
const vaultId = 'vault-test-001';

// ── Derivation path is fixed and network-scoped, not vault-specific ───────
assert.equal(legacyDerivationPath('mainnet'), "m/9999'/0'/0'/0'");
assert.equal(legacyDerivationPath('testnet'), "m/9999'/1'/0'/0'");

// ── Lock-value determinism: same mnemonic + vault + role -> same bytes,
// every time, no signature-nonce-style variance. ──────────────────────────
const mnemonicFounder = generateMnemonic(wordlist);
const mnemonicHeir    = generateMnemonic(wordlist);
const mnemonicBackup  = generateMnemonic(wordlist);

const lockA = deriveLegacyLockBytes(mnemonicFounder, network, vaultId, 'founder_1');
const lockB = deriveLegacyLockBytes(mnemonicFounder, network, vaultId, 'founder_1');
assert.deepEqual(lockA, lockB, 'same key+vault+role must derive identical lock bytes every time');
assert.equal(lockA.length, 32);

// ── Domain separation: different vault or different role -> different
// lock bytes, even from the SAME mnemonic. ────────────────────────────────
const lockDifferentVault = deriveLegacyLockBytes(mnemonicFounder, network, 'vault-test-002', 'founder_1');
const lockDifferentRole  = deriveLegacyLockBytes(mnemonicFounder, network, vaultId, 'backup_1');
assert.notDeepEqual(lockA, lockDifferentVault, 'reusing a seed across vaults must not reuse lock bytes');
assert.notDeepEqual(lockA, lockDifferentRole, 'reusing a seed across roles must not reuse lock bytes');

// ── lock/unlockShare round-trips for share lengths that don't match the
// 32-byte lock value (exercises expandKeystream's length handling). ───────
for (const len of [16, 32, 33, 65]) {
  const fakeShare = crypto.getRandomValues(new Uint8Array(len));
  const locked = lockShare(fakeShare, lockA);
  assert.equal(locked.length, len);
  assert.notDeepEqual(locked, fakeShare, `lockShare must actually change the bytes at length ${len}`);
  const unlocked = unlockShare(locked, lockA);
  assert.deepEqual(unlocked, fakeShare, `unlockShare must invert lockShare at length ${len}`);
}

// ── Full end-to-end, hybrid split: seal a bundle, split the secret into
// a fast XOR path (5 keyholders + 1 unlocked on-chain pad) AND a Shamir
// fallback path (5 keyholders only), lock every keyholder share to its
// own key, then exercise both recovery paths. ─────────────────────────────
const bundleText = 'descriptor=tr(...); policy=or(thresh(2,pk(A),pk(B)),and(after(500000),pk(C)))';
const secret = generateLegacySecret();
assert.equal(secret.length, 32);

const sealed = await sealBundle(bundleText, secret);
const roles = ['founder_1', 'founder_2', 'backup_1', 'heir_1', 'heir_2'];
const mnemonics = [mnemonicFounder, mnemonicFounder, mnemonicBackup, mnemonicHeir, mnemonicHeir];
const lockBytesByRole = roles.map((role, i) => deriveLegacyLockBytes(mnemonics[i], network, vaultId, role));

const { onChainShare, fastPathShare, fallbackShares } = await splitLegacySecretHybrid(secret, roles.length);
assert.equal(fallbackShares.length, roles.length);
assert.notDeepEqual(fastPathShare, secret, 'the fast-path share must not equal the secret before XORing with the on-chain pad');

const lockedFastPathShares = lockBytesByRole.map(lock => lockShare(fastPathShare, lock));
const lockedFallbackShares = fallbackShares.map((share, i) => lockShare(share, lockBytesByRole[i]));

// ── Fast path: one surviving key (heir_2) + the on-chain pad. Pure XOR,
// no Shamir call at all -- this is the common case. ────────────────────────
const fastRecovered = recoverViaFastPath(lockedFastPathShares[4], lockBytesByRole[4], onChainShare);
assert.deepEqual(fastRecovered, secret, 'fast path (one key + on-chain pad) must reconstruct the exact secret via XOR alone');

const recoveredBundle = await unsealBundle(sealed, fastRecovered);
assert.equal(recoveredBundle, bundleText, 'unsealed bundle must byte-match the original');

// ── Fallback path: two different surviving keyholders (founder_1,
// backup_1), on-chain pad never touched. Real Shamir reconstruction. ──────
const fallbackRecovered = await recoverViaFallbackPath(
  lockedFallbackShares[0], lockBytesByRole[0],
  lockedFallbackShares[2], lockBytesByRole[2],
);
assert.deepEqual(fallbackRecovered, secret, 'fallback path (two keyholders, no on-chain pad) must also reconstruct the exact secret');

// A single fallback share alone must NOT reconstruct the secret (threshold enforced).
await assert.rejects(
  () => combineLegacySecret([unlockShare(lockedFallbackShares[0], lockBytesByRole[0])]),
  undefined,
  'a single fallback share below the threshold must fail to reconstruct',
);

// A single fast-path share alone (no on-chain pad) must NOT reveal the secret.
const fastShareAloneXorZero = unlockShare(lockedFastPathShares[0], lockBytesByRole[0]);
assert.notDeepEqual(fastShareAloneXorZero, secret, 'a fast-path share alone, without the on-chain pad, must not equal the secret');

// ── Edge case: a vault with only one keyholder has no second person for
// the fallback path -- this must fail with a clear message, not the
// underlying Shamir library's opaque "shares must be at least 2" error. ──
await assert.rejects(
  () => splitLegacySecretHybrid(secret, 1),
  /fallback path needs at least 2 keyholders/,
  'a single-keyholder vault must fail clearly, not with the library\'s raw error',
);

// ── Signature-based lock (hardware-wallet-compatible sibling) ─────────────
// The whole point of this scheme is that a hardware wallet can reproduce
// the SAME lock value later using only a signature, never a raw key
// export. Proves: (1) determinism -- same key+message always signs
// identically, no random nonce; (2) the account xpub alone -- no
// mnemonic -- derives the identical identity pubkey the mnemonic side
// derives, which is what makes "look it up by xpub" possible at all;
// (3) full round trip through lock/unlock and bundle sealing, same as
// the mnemonic-based scheme above.
const testAccountPath = "m/86'/1'/0'";
const founderSigMnemonic = generateMnemonic(wordlist);

const sigA = signLegacyUnlockMessage(founderSigMnemonic, network, testAccountPath, vaultId, 'founder_1');
const sigB = signLegacyUnlockMessage(founderSigMnemonic, network, testAccountPath, vaultId, 'founder_1');
assert.deepEqual(sigA, sigB, 'signing the same message with the same key must be deterministic (RFC 6979), not vary run to run');
assert.equal(sigA.length, 64, 'compact ECDSA signature must be 64 bytes (r || s)');

// A different vaultId or keyRole changes the signed message, so the
// signature -- and so the derived lock bytes -- must differ too.
const sigDifferentVault = signLegacyUnlockMessage(founderSigMnemonic, network, testAccountPath, 'vault-test-002', 'founder_1');
assert.notDeepEqual(sigA, sigDifferentVault, 'signing for a different vault must produce a different signature');
assert.notEqual(legacyUnlockMessage(vaultId, 'founder_1'), legacyUnlockMessage('vault-test-002', 'founder_1'));

const sigLockA = deriveLegacyLockBytesFromSignature(sigA, vaultId, 'founder_1');
const sigLockB = deriveLegacyLockBytesFromSignature(sigB, vaultId, 'founder_1');
assert.deepEqual(sigLockA, sigLockB, 'identical signatures must derive identical lock bytes');
assert.equal(sigLockA.length, 32);
assert.notDeepEqual(sigLockA, deriveLegacyLockBytesFromSignature(sigA, vaultId, 'founder_2'), 'different keyRole tag must change the lock bytes even from the same signature');

// bitcoinMessageDigest must be a plain function of the message text, not
// of anything else -- same message, same digest.
assert.deepEqual(
  bitcoinMessageDigest(legacyUnlockMessage(vaultId, 'founder_1')),
  bitcoinMessageDigest(legacyUnlockMessage(vaultId, 'founder_1')),
);

// The identity pubkey derived from the mnemonic must byte-match the one
// derivable from JUST that account's xpub -- no private key involved on
// the xpub side at all. This is the actual claim the retrieval page
// depends on: "give me an xpub, I can find what a signature would unlock."
const seed = mnemonicToSeedSync(founderSigMnemonic);
const accountXpub = HDKey.fromMasterSeed(seed).derive(testAccountPath).publicExtendedKey;
const identityFromMnemonic = legacyIdentityPubkeyFromMnemonic(founderSigMnemonic, network, testAccountPath);
const identityFromXpub = legacyIdentityPubkeyFromXpub(accountXpub);
assert.deepEqual(identityFromMnemonic, identityFromXpub, 'identity pubkey must be derivable identically from the mnemonic or from just the account xpub');

// detectXpubNetwork must correctly identify a mainnet-encoded xpub (the
// test above default-encodes as mainnet since it doesn't pass version
// bytes to HDKey.fromMasterSeed) even though the mnemonic-side
// derivation used testnet version bytes -- version bytes are pure
// serialization metadata and must never affect the derived key itself.
assert.equal(detectXpubNetwork(accountXpub), 'mainnet');

// A real hardware wallet's signature comes back as BIP-137: a 1-byte
// header prefixed to the 64-byte compact signature, base64-encoded --
// not bare hex. Retrieval must verify a signature against the identity
// pubkey it claims to match, and reject one that doesn't.
assert.equal(verifyLegacyUnlockSignature(sigA, identityFromXpub, vaultId, 'founder_1'), true, 'a genuine signature by the matching key must verify');
assert.equal(verifyLegacyUnlockSignature(sigA, identityFromXpub, vaultId, 'founder_2'), false, 'the same signature checked against the wrong keyRole tag must fail verification');
const wrongMnemonic = generateMnemonic(wordlist);
const wrongSig = signLegacyUnlockMessage(wrongMnemonic, network, testAccountPath, vaultId, 'founder_1');
assert.equal(verifyLegacyUnlockSignature(wrongSig, identityFromXpub, vaultId, 'founder_1'), false, 'a signature from a DIFFERENT key must fail verification against this identity pubkey');

// Full round trip: lock the SAME fast-path share used above with the
// signature-derived lock instead of the mnemonic-derived one, and
// recover the same secret via the fast path.
const lockedFastShareSig = lockShare(fastPathShare, sigLockA);
const sigRecovered = recoverViaFastPath(lockedFastShareSig, sigLockA, onChainShare);
assert.deepEqual(sigRecovered, secret, 'signature-locked fast-path share + on-chain pad must reconstruct the exact same secret');
const sigRecoveredBundle = await unsealBundle(sealed, sigRecovered);
assert.equal(sigRecoveredBundle, bundleText, 'bundle recovered via the signature-based lock must byte-match the original');

// ── descriptorFingerprint: stale-seal detection label ─────────────────────
// (2026-08-20, operator thinking through a 20-year-out edge case: a vault
// recompiles -- same shape, different keys -- after Legacy Recovery was
// already sealed and an on-chain pad already published. The crypto itself
// already fails safely there; this label is purely so a stale seal can be
// detected and warned about instead of silently trusted.)
const descA = 'tr([abc12345/86h/1h/0h]xpub_placeholder_A/0/0)';
const descB = 'tr([def67890/86h/1h/0h]xpub_placeholder_B/0/0)';
assert.equal(descriptorFingerprint(descA), descriptorFingerprint(descA), 'same descriptor must always fingerprint identically');
assert.notEqual(descriptorFingerprint(descA), descriptorFingerprint(descB), 'different descriptors must fingerprint differently');
assert.equal(descriptorFingerprint(descA).length, 16, 'fingerprint is 8 bytes of SHA-256 as hex (16 chars)');
assert.match(descriptorFingerprint(descA), /^[0-9a-f]{16}$/, 'fingerprint must be lowercase hex');

console.log('legacy-recovery tests passed');
