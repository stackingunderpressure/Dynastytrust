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
  splitLegacySecret,
  combineLegacySecret,
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

// ── Full end-to-end: seal a bundle, split the secret across 6 shares
// (5 keyholders + 1 unlocked on-chain share), lock the 5 keyholder shares
// to their own keys, then reconstruct from only 2 of the 6 -- simulating
// "everyone else's key is gone, only two survived." ────────────────────────
const bundleText = 'descriptor=tr(...); policy=or(thresh(2,pk(A),pk(B)),and(after(500000),pk(C)))';
const secret = generateLegacySecret();
assert.equal(secret.length, 32);

const sealed = await sealBundle(bundleText, secret);
const shares = await splitLegacySecret(secret, 6, 2);
assert.equal(shares.length, 6);

const roles = ['founder_1', 'founder_2', 'backup_1', 'heir_1', 'heir_2'];
const mnemonics = [mnemonicFounder, mnemonicFounder, mnemonicBackup, mnemonicHeir, mnemonicHeir];
const lockedKeyholderShares = roles.map((role, i) =>
  lockShare(shares[i], deriveLegacyLockBytes(mnemonics[i], network, vaultId, role)),
);
const onChainShare = shares[5]; // unlocked by design -- no key needed to read it

// Scenario: only heir_2's key survived, plus the on-chain share.
const heir2Lock = deriveLegacyLockBytes(mnemonicHeir, network, vaultId, 'heir_2');
const recoveredHeir2Share = unlockShare(lockedKeyholderShares[4], heir2Lock);
const reconstructedSecret = await combineLegacySecret([recoveredHeir2Share, onChainShare]);
assert.deepEqual(reconstructedSecret, secret, '2-of-6 (one surviving key + on-chain share) must reconstruct the exact secret');

const recoveredBundle = await unsealBundle(sealed, reconstructedSecret);
assert.equal(recoveredBundle, bundleText, 'unsealed bundle must byte-match the original');

// Scenario: two different keyholders survived, no on-chain share needed.
const founder1Lock = deriveLegacyLockBytes(mnemonicFounder, network, vaultId, 'founder_1');
const backup1Lock  = deriveLegacyLockBytes(mnemonicBackup, network, vaultId, 'backup_1');
const recoveredFounder1 = unlockShare(lockedKeyholderShares[0], founder1Lock);
const recoveredBackup1  = unlockShare(lockedKeyholderShares[2], backup1Lock);
const reconstructedFromTwoKeyholders = await combineLegacySecret([recoveredFounder1, recoveredBackup1]);
assert.deepEqual(reconstructedFromTwoKeyholders, secret, '2-of-6 (two surviving keyholders, no on-chain share) must also reconstruct the exact secret');

// A single share alone must NOT reconstruct the secret (threshold enforced).
await assert.rejects(
  () => combineLegacySecret([onChainShare]),
  undefined,
  'a single share below the threshold must fail to reconstruct',
);

console.log('legacy-recovery tests passed');
