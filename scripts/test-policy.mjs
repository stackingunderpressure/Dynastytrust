import assert from 'node:assert/strict';
import { validatePolicy, evaluateSigningGate, ceremonyFromProposal } from '../packages/policy-engine/dist/index.js';
const validPolicy = {
  version: 1,
  policyId: 'p1',
  name: 'Family Test Vault',
  network: 'testnet',
  members: [
    { memberId: 'm1', displayName: 'Thomas', role: 'owner', active: true },
    { memberId: 'm2', displayName: 'Backup', role: 'trustee', active: true }
  ],
  keys: [
    { keyId: 'k1', memberId: 'm1', label: 'Owner', origin: 'software', purpose: 'primary', network: 'testnet' },
    { keyId: 'k2', memberId: 'm2', label: 'Backup', origin: 'software', purpose: 'backup', network: 'testnet' }
  ],
  paths: [
    { pathId: 'n1', kind: 'normal', threshold: 2, keyIds: ['k1', 'k2'] },
    { pathId: 'i1', kind: 'inheritance', threshold: 1, keyIds: ['k2'], timelock: { type: 'relative', value: 52560 } }
  ],
  rules: { allowKeyReplacement: true, allowThresholdChange: false, requireAuditTrail: true, requireHumanSummary: true, testMode: true }
};
const good = validatePolicy(validPolicy);
assert.equal(good.ok, true);
assert.equal(good.errors.length, 0);
const bad = validatePolicy({ ...validPolicy, paths: [{ pathId: 'bad', kind: 'normal', threshold: 3, keyIds: ['k1', 'k2'] }] });
assert.equal(bad.ok, false);
assert.ok(bad.errors.some((e) => e.code === 'THRESHOLD_EXCEEDS_KEYS'));

// ── Fail-closed signing gate ────────────────────────────────────────────────
const NOW = 1_000_000;
const greenCeremony = {
  proposalId: 'pr1', vaultId: 'v1', status: 'approved',
  authorizedPsbtHash: 'abc123', destination: 'tb1pdest', amountSats: 50_000,
  path: 'parents_now', approvalsRequired: 2, approvalsCollected: 2,
  duress: false, expiresAt: NOW + 10_000,
};
const baseRequest = {
  vaultId: 'v1', psbtHash: 'abc123', destination: 'tb1pdest',
  amountSats: 50_000, path: 'parents_now',
};
const baseInput = {
  request: baseRequest,
  ceremony: greenCeremony,
  vault: { vaultId: 'v1', address: 'tb1pvault' },
  psbtBindsToVault: true,
  governanceApproved: true,
};
const codes = (r) => r.denials.map((d) => d.code);

// Happy path: a fully green, bound, non-duress ceremony allows.
const allow = evaluateSigningGate(baseInput, NOW);
assert.equal(allow.allow, true, 'green ceremony must allow');
assert.equal(allow.denials.length, 0);

// Default-DENY: no ceremony at all is an immediate hard deny.
const noCeremony = evaluateSigningGate({ ...baseInput, ceremony: null }, NOW);
assert.equal(noCeremony.allow, false);
assert.deepEqual(codes(noCeremony), ['NO_CEREMONY']);

// PSBT swap: signing target differs from what was approved.
const swapped = evaluateSigningGate(
  { ...baseInput, request: { ...baseRequest, psbtHash: 'deadbeef' } }, NOW);
assert.equal(swapped.allow, false);
assert.ok(codes(swapped).includes('PSBT_HASH_MISMATCH'));

// Destination / amount / path tampering each deny.
assert.equal(evaluateSigningGate({ ...baseInput, request: { ...baseRequest, destination: 'tb1pEVIL' } }, NOW).allow, false);
assert.equal(evaluateSigningGate({ ...baseInput, request: { ...baseRequest, amountSats: 99_999 } }, NOW).allow, false);
assert.equal(evaluateSigningGate({ ...baseInput, request: { ...baseRequest, path: 'kids_decay' } }, NOW).allow, false);

// Not green: approvals threshold not met.
const notGreen = evaluateSigningGate(
  { ...baseInput, ceremony: { ...greenCeremony, approvalsCollected: 1 } }, NOW);
assert.equal(notGreen.allow, false);
assert.ok(codes(notGreen).includes('NOT_GREEN'));

// Kimi K3 scan #56: approvalsRequired must have a floor. Without one,
// approvalsRequired=0 is vacuously satisfied by approvalsCollected=0,
// bypassing the approval gate entirely.
const zeroRequired = evaluateSigningGate(
  { ...baseInput, ceremony: { ...greenCeremony, approvalsRequired: 0, approvalsCollected: 0 } }, NOW);
assert.equal(zeroRequired.allow, false, 'approvalsRequired=0 must not vacuously pass the gate');
assert.ok(codes(zeroRequired).includes('NOT_GREEN'));

// Duress dominates -> deny even when otherwise green.
const duress = evaluateSigningGate(
  { ...baseInput, ceremony: { ...greenCeremony, duress: true } }, NOW);
assert.equal(duress.allow, false);
assert.ok(codes(duress).includes('DURESS_HOLD'));

// Expired proposal denies.
const expired = evaluateSigningGate(
  { ...baseInput, ceremony: { ...greenCeremony, expiresAt: NOW - 1 } }, NOW);
assert.equal(expired.allow, false);
assert.ok(codes(expired).includes('CEREMONY_EXPIRED'));

// Not signable (cancelled / broadcast / draft) denies.
for (const status of ['draft', 'cancelled', 'broadcast']) {
  const r = evaluateSigningGate({ ...baseInput, ceremony: { ...greenCeremony, status } }, NOW);
  assert.equal(r.allow, false, `status ${status} must not be signable`);
  assert.ok(codes(r).includes('CEREMONY_NOT_SIGNABLE'));
}

// PSBT not bound to the vault denies.
const unbound = evaluateSigningGate({ ...baseInput, psbtBindsToVault: false }, NOW);
assert.equal(unbound.allow, false);
assert.ok(codes(unbound).includes('PSBT_NOT_BOUND'));

// Vault mismatch (ceremony for a different vault) denies.
const wrongVault = evaluateSigningGate(
  { ...baseInput, ceremony: { ...greenCeremony, vaultId: 'v2' } }, NOW);
assert.equal(wrongVault.allow, false);
assert.ok(codes(wrongVault).includes('VAULT_MISMATCH'));

// Script-mirroring governance explicitly false denies.
const govReject = evaluateSigningGate({ ...baseInput, governanceApproved: false }, NOW);
assert.equal(govReject.allow, false);
assert.ok(codes(govReject).includes('GOVERNANCE_REJECTED'));

// ── Circle liveness gate (the green ladder) ─────────────────────────────────
// The gate consumes pre-computed liveness states; it does no crypto. Red
// dominates: a single red blocks the leg even when greens meet the quorum.

// (a) liveness undefined -> no liveness denial; an otherwise-green spend still allows.
const noLiveness = evaluateSigningGate(baseInput, NOW);
assert.equal(noLiveness.allow, true, 'no liveness supplied must still allow a green ceremony');
assert.ok(!codes(noLiveness).some((c) => c.startsWith('LIVENESS_')), 'no liveness denial when not supplied');

// (b) enough greens, zero reds, quorum met -> no liveness denial.
const livenessOk = evaluateSigningGate(
  { ...baseInput, liveness: { memberStates: ['green', 'green', 'no-report'], requiredGreen: 2 } }, NOW);
assert.equal(livenessOk.allow, true, 'met green quorum with zero reds must allow');
assert.ok(!codes(livenessOk).some((c) => c.startsWith('LIVENESS_')), 'no liveness denial when quorum met');

// (c) one red present even though greens >= requiredGreen -> LIVENESS_RED (red dominates).
const livenessRed = evaluateSigningGate(
  { ...baseInput, liveness: { memberStates: ['green', 'green', 'red'], requiredGreen: 2 } }, NOW);
assert.equal(livenessRed.allow, false, 'a red must block even with the green count met');
assert.ok(codes(livenessRed).includes('LIVENESS_RED'));
assert.ok(!codes(livenessRed).includes('LIVENESS_NOT_GREEN'), 'red dominates -- not the not-green denial');

// (d) greens < requiredGreen, zero reds -> LIVENESS_NOT_GREEN.
const livenessShort = evaluateSigningGate(
  { ...baseInput, liveness: { memberStates: ['green', 'no-report', 'no-report'], requiredGreen: 2 } }, NOW);
assert.equal(livenessShort.allow, false, 'short of the green quorum must deny');
assert.ok(codes(livenessShort).includes('LIVENESS_NOT_GREEN'));

// ── Ceremony bridge (proposal records -> SigningCeremony) ───────────────────
const proposalRec = {
  proposalId: 'pr9', vaultId: 'v1', status: 'signed',
  destination: 'tb1pdest', amountSats: 50_000, path: 'parents_now',
};
const bridged = ceremonyFromProposal({
  proposal: proposalRec,
  authorizedPsbtHash: 'abc123',
  approveVoterIds: ['u1', 'u2', 'u2'], // u2 duplicated -> counts once
  approvalsRequired: 2,
  duress: false,
});
assert.equal(bridged.status, 'signing', 'signed proposal -> signing');
assert.equal(bridged.approvalsCollected, 2, 'distinct approvers counted');
assert.equal(bridged.authorizedPsbtHash, 'abc123');

// Status mapping is exhaustive and correct.
const statusMap = { draft: 'draft', pending: 'pending', signed: 'signing', broadcast: 'broadcast', cancelled: 'cancelled' };
for (const [dbStatus, ceremonyStatus] of Object.entries(statusMap)) {
  const c = ceremonyFromProposal({ proposal: { ...proposalRec, status: dbStatus }, authorizedPsbtHash: 'h', approveVoterIds: ['u1', 'u2'], approvalsRequired: 2, duress: false });
  assert.equal(c.status, ceremonyStatus, `status ${dbStatus} -> ${ceremonyStatus}`);
}

// End-to-end: a bridged green ceremony passes the gate.
const bridgedReq = { vaultId: 'v1', psbtHash: 'abc123', destination: 'tb1pdest', amountSats: 50_000, path: 'parents_now' };
const bridgedAllow = evaluateSigningGate({
  request: bridgedReq, ceremony: bridged,
  vault: { vaultId: 'v1', address: 'tb1pvault' }, psbtBindsToVault: true, governanceApproved: true,
}, 0);
assert.equal(bridgedAllow.allow, true, 'bridged green ceremony must pass the gate');

// A draft proposal bridges to a non-signable ceremony -> gate denies.
const draftCeremony = ceremonyFromProposal({ proposal: { ...proposalRec, status: 'draft' }, authorizedPsbtHash: 'abc123', approveVoterIds: ['u1', 'u2'], approvalsRequired: 2, duress: false });
const draftGate = evaluateSigningGate({ request: bridgedReq, ceremony: draftCeremony, vault: { vaultId: 'v1', address: 'tb1pvault' }, psbtBindsToVault: true }, 0);
assert.equal(draftGate.allow, false, 'draft proposal must not be signable');
assert.ok(draftGate.denials.some((d) => d.code === 'CEREMONY_NOT_SIGNABLE'));

// Insufficient approvers -> gate denies NOT_GREEN.
const underApproved = ceremonyFromProposal({ proposal: proposalRec, authorizedPsbtHash: 'abc123', approveVoterIds: ['u1'], approvalsRequired: 2, duress: false });
const underGate = evaluateSigningGate({ request: bridgedReq, ceremony: underApproved, vault: { vaultId: 'v1', address: 'tb1pvault' }, psbtBindsToVault: true }, 0);
assert.equal(underGate.allow, false);
assert.ok(underGate.denials.some((d) => d.code === 'NOT_GREEN'));

// Duress bridges through and dominates.
const duressCeremony = ceremonyFromProposal({ proposal: proposalRec, authorizedPsbtHash: 'abc123', approveVoterIds: ['u1', 'u2'], approvalsRequired: 2, duress: true });
const duressGate = evaluateSigningGate({ request: bridgedReq, ceremony: duressCeremony, vault: { vaultId: 'v1', address: 'tb1pvault' }, psbtBindsToVault: true }, 0);
assert.equal(duressGate.allow, false);
assert.ok(duressGate.denials.some((d) => d.code === 'DURESS_HOLD'));

console.log('policy tests passed');
