// Round-trip proof for the Legacy Recovery crypto core (stage 1 of the
// long-horizon descriptor recovery plan). Plain node:assert, no framework,
// matching scripts/test-policy.mjs's convention. Imports the real
// apps/web/src/lib/legacy-recovery.ts directly via Node's native TS
// type-stripping -- no build step, no mocks, the exact code the app ships.
import assert from 'node:assert/strict';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
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

console.log('legacy-recovery tests passed');
