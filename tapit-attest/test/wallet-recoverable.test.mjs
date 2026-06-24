import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, splitSecret, combineShares } from '../dist/index.js';

// Phase 5e wallet methods for the v2 recoverable backup format.
// exportRecoverable returns the blob plus K_data so the caller can
// Shamir-split + distribute across cohort peers. restoreRecoverable
// is the passphrase path (equivalent to restore for v1).
// restoreFromKData is the recovery path — K_data reconstructed from
// M cohort peer shares.

test('exportRecoverable produces a v2 blob plus a 32-byte K_data', async () => {
  const w = Wallet.generate();
  const { blob, kData } = await w.exportRecoverable('correct horse');
  assert.equal(blob.v, 2);
  assert.equal(kData.length, 32);
});

test('restoreRecoverable round-trips the wallet via the passphrase', async () => {
  const w = Wallet.generate();
  w.attest({
    kind: 'identity',
    tier: 'routine',
    subject: 'did:example:ada',
    fields: { label: 'Ada' },
  });
  const { blob } = await w.exportRecoverable('pw');
  const restored = await Wallet.restoreRecoverable(blob, 'pw');
  assert.equal(restored.publicKey, w.publicKey);
  assert.equal(restored.identity, w.identity);
});

test('restoreFromKData round-trips the wallet via the recovery path', async () => {
  const w = Wallet.generate();
  const a = w.attest({
    kind: 'identity',
    tier: 'routine',
    subject: 'did:example:bob',
    fields: { label: 'Bob' },
  });
  await w.hold(a);
  const { blob, kData } = await w.exportRecoverable('pw');
  const restored = await Wallet.restoreFromKData(blob, kData);
  assert.equal(restored.publicKey, w.publicKey);
  const heldRestored = await restored.holdings();
  assert.equal(heldRestored.length, 1);
  assert.equal(heldRestored[0].subject, 'did:example:bob');
});

test('passphrase path and kData path produce identical wallets', async () => {
  const w = Wallet.generate();
  w.attest({ kind: 'identity', tier: 'routine', subject: 'x', fields: {} });
  const { blob, kData } = await w.exportRecoverable('pw');
  const a = await Wallet.restoreRecoverable(blob, 'pw');
  const b = await Wallet.restoreFromKData(blob, kData);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(a.identity, b.identity);
});

test('the wrong passphrase on restoreRecoverable throws', async () => {
  const w = Wallet.generate();
  const { blob } = await w.exportRecoverable('right');
  await assert.rejects(
    () => Wallet.restoreRecoverable(blob, 'wrong'),
    /wrong passphrase/,
  );
});

test('exportRecoverableReuseKData keeps K_data stable across saves', async () => {
  // Load-bearing for Phase 5e cascade: once shares are distributed
  // to the cohort, future saves must NOT rotate K_data — otherwise
  // the held shares silently invalidate against the next blob. This
  // test pins that property.
  const w = Wallet.generate();
  const { blob: firstBlob, kData: firstK } = await w.exportRecoverable('pw');
  w.attest({ kind: 'identity', tier: 'routine', subject: 'x', fields: { v: '1' } });
  const { blob: secondBlob, kData: secondK } = await w.exportRecoverableReuseKData(firstBlob, 'pw');
  assert.deepEqual(secondK, firstK);
  // The wrap fields stay identical; only dataIv + dataCiphertext rotate.
  assert.equal(secondBlob.salt, firstBlob.salt);
  assert.equal(secondBlob.wrapIv, firstBlob.wrapIv);
  assert.equal(secondBlob.wrapCiphertext, firstBlob.wrapCiphertext);
  assert.notEqual(secondBlob.dataIv, firstBlob.dataIv);
  assert.notEqual(secondBlob.dataCiphertext, firstBlob.dataCiphertext);
  // The reused K_data still decrypts the new blob.
  const restored = await Wallet.restoreFromKData(secondBlob, secondK);
  assert.equal(restored.publicKey, w.publicKey);
});

test('exportRecoverableReuseKData rejects a wrong passphrase', async () => {
  const w = Wallet.generate();
  const { blob } = await w.exportRecoverable('right');
  await assert.rejects(
    () => w.exportRecoverableReuseKData(blob, 'wrong'),
    /wrong passphrase/,
  );
});

test('exportRecoverableWithKData saves under a fresh passphrase while preserving K_data', async () => {
  // The Phase 5e new-device save seam. After recovery, the operator
  // knows K_data (from combined cohort shares) and picks a new
  // passphrase on the new device. The save must (a) decrypt under
  // the new passphrase via the standard path and (b) keep K_data
  // identical so already-distributed cohort shares stay valid
  // against future recoveries.
  const w = Wallet.generate();
  const a = w.attest({
    kind: 'identity',
    tier: 'routine',
    subject: 'did:example:dana',
    fields: { label: 'Dana' },
  });
  await w.hold(a);
  // Simulate a recovery: produce K_data, then save under a NEW pass.
  const { kData } = await w.exportRecoverable('old pw');
  const newBlob = await w.exportRecoverableWithKData(kData, 'new pw');
  // Passphrase path works against the new blob.
  const fromPass = await Wallet.restoreRecoverable(newBlob, 'new pw');
  assert.equal(fromPass.publicKey, w.publicKey);
  const heldFromPass = await fromPass.holdings();
  assert.equal(heldFromPass.length, 1);
  // kData path still works — cohort shares stay valid.
  const fromKData = await Wallet.restoreFromKData(newBlob, kData);
  assert.equal(fromKData.publicKey, w.publicKey);
  // Old passphrase no longer unlocks the new blob.
  await assert.rejects(
    () => Wallet.restoreRecoverable(newBlob, 'old pw'),
    /wrong passphrase/,
  );
});

test('exportRecoverableWithKData rejects a wrong-length kData', async () => {
  const w = Wallet.generate();
  await assert.rejects(
    () => w.exportRecoverableWithKData(new Uint8Array(16), 'pw'),
    /32 bytes/,
  );
});

test('Shamir-split K_data round-trips through combineShares into restoreFromKData', async () => {
  // The end-to-end shape Phase 5e cascade recovery will use: split
  // K_data into N peer shares, throw enough away to simulate offline
  // peers, combine M survivors, restore the wallet from the result.
  const w = Wallet.generate();
  const a = w.attest({
    kind: 'identity',
    tier: 'routine',
    subject: 'did:example:carol',
    fields: { label: 'Carol' },
  });
  await w.hold(a);
  const { blob, kData } = await w.exportRecoverable('pw');

  const shares = splitSecret(kData, 3, 5);
  // Simulate two peers offline; the remaining three cooperate.
  const survivors = [shares[0], shares[2], shares[4]];
  const reconstructed = combineShares(survivors);
  assert.deepEqual(reconstructed, kData);

  const restored = await Wallet.restoreFromKData(blob, reconstructed);
  assert.equal(restored.publicKey, w.publicKey);
  const held = await restored.holdings();
  assert.equal(held.length, 1);
});
