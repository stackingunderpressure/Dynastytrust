/**
 * test-attest.mjs -- attestation integrity tests.
 *
 * Proves that verifyAttestationRecord() rejects a tampered
 * threshold-influencing value. The Schnorr signature only commits to
 * (attestation_type, target_hash); target_data is stored unsigned
 * beside the row. Without the target_data <-> target_hash binding a
 * relayer could edit a death-declaration's subject -- a governance
 * input -- and every signature would still verify.
 */
import assert from 'node:assert/strict';
import {
  signAttestation,
  verifyAttestation,
  verifyAttestationRecord,
  recomputeTargetHash,
  deathDeclarationHash,
} from '../apps/web/src/lib/attest.ts';

const mnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const derivationPath = "m/86'/1'/0'";
const vaultId = '11111111-1111-1111-1111-111111111111';
const subjectA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const subjectB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const effectiveDate = '2026-05-17';

// A genuine death declaration: witness signs the hash of
// (vaultId, subjectA, effectiveDate).
const targetHash = deathDeclarationHash(vaultId, subjectA, effectiveDate);
const { signature, pubkey } = signAttestation({
  mnemonic,
  derivationPath,
  network: 'testnet',
  attestationType: 'death_declaration',
  targetHash,
});
const targetData = {
  subject_user_id: subjectA,
  effective_date: effectiveDate,
  notes: '',
};

// Honest record verifies.
assert.equal(
  verifyAttestationRecord({
    attestationType: 'death_declaration',
    targetHash,
    targetData,
    signature,
    pubkey,
    vaultId,
  }),
  true,
  'an honest death declaration must verify',
);

// Tamper the subject -- a relayer points the witness signature at a
// different person. verifyAttestationRecord MUST reject it.
const tampered = { ...targetData, subject_user_id: subjectB };
assert.equal(
  verifyAttestationRecord({
    attestationType: 'death_declaration',
    targetHash,
    targetData: tampered,
    signature,
    pubkey,
    vaultId,
  }),
  false,
  'a tampered death-declaration subject must fail verifyAttestationRecord',
);

// This is the hole the fix closes: the signature-only check still
// passes for the tampered row, because target_data is not signed.
assert.equal(
  verifyAttestation({
    attestationType: 'death_declaration',
    targetHash,
    signature,
    pubkey,
  }),
  true,
  'signature-only verification cannot detect target_data tampering',
);

// The binding is the recomputed hash: honest target_data hashes to
// the signed target_hash, tampered target_data does not.
assert.equal(
  recomputeTargetHash('death_declaration', targetData, vaultId),
  targetHash,
);
assert.notEqual(
  recomputeTargetHash('death_declaration', tampered, vaultId),
  targetHash,
);

// A fabricated row with a junk signature must never count toward a
// threshold -- closes the "counter counts unverified rows" hole.
assert.equal(
  verifyAttestationRecord({
    attestationType: 'death_declaration',
    targetHash,
    targetData,
    signature: '00'.repeat(64),
    pubkey,
    vaultId,
  }),
  false,
  'a fabricated row with a junk signature must not verify',
);

// Tampering the signed target_hash breaks the signature outright.
assert.equal(
  verifyAttestationRecord({
    attestationType: 'death_declaration',
    targetHash: 'f'.repeat(64),
    targetData,
    signature,
    pubkey,
    vaultId,
  }),
  false,
  'a tampered target_hash must fail verification',
);

console.log('attestation tests passed');
