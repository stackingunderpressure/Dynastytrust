export type Network = 'testnet' | 'mainnet';
export type KeyOrigin = 'software' | 'hardware' | 'imported_xpub';
export type MemberRole = 'owner' | 'spouse' | 'child' | 'trustee' | 'executor' | 'guardian' | 'observer';
export interface PolicyMember { memberId: string; displayName: string; role: MemberRole; active: boolean; }
export interface PolicyKeyRef { keyId: string; memberId: string; label: string; origin: KeyOrigin; purpose: 'primary' | 'backup' | 'recovery'; network?: Network; }
export interface TimeConstraint { type: 'relative' | 'absolute'; value: number; }
export type PathConstraint = { type: 'max_amount'; sats: number } | { type: 'cooldown'; blocks: number } | { type: 'notice_period'; hours: number };
export interface NormalPath { pathId: string; kind: 'normal'; threshold: number; keyIds: string[]; constraints?: PathConstraint[]; }
export interface EmergencyPath { pathId: string; kind: 'emergency'; threshold: number; keyIds: string[]; timelock?: TimeConstraint; action: 'move_to_new_vault' | 'sweep_to_safe_address'; constraints?: PathConstraint[]; }
export interface InheritancePath { pathId: string; kind: 'inheritance'; threshold: number; keyIds: string[]; timelock: TimeConstraint; constraints?: PathConstraint[]; }
export type PolicyPath = NormalPath | EmergencyPath | InheritancePath;
export interface PolicyRules { allowKeyReplacement: boolean; allowThresholdChange: boolean; requireAuditTrail: boolean; requireHumanSummary: boolean; testMode: boolean; }
export interface VaultPolicy { version: 1; policyId: string; name: string; network: Network; members: PolicyMember[]; keys: PolicyKeyRef[]; paths: PolicyPath[]; rules: PolicyRules; metadata?: Record<string, string>; }
export interface ValidationMessage { code: string; field?: string; message: string; }
export interface PolicyValidationResult { ok: boolean; errors: ValidationMessage[]; warnings: ValidationMessage[]; }

export function validatePolicy(policy: VaultPolicy): PolicyValidationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const memberIds = new Set(policy.members.map((m) => m.memberId));
  const keyMap = new Map(policy.keys.map((k) => [k.keyId, k]));
  for (const key of policy.keys) {
    if (!memberIds.has(key.memberId)) errors.push({ code: 'UNKNOWN_MEMBER', field: `keys.${key.keyId}.memberId`, message: `Missing member ${key.memberId} for key ${key.keyId}.` });
    if (key.network && key.network !== policy.network) errors.push({ code: 'NETWORK_MISMATCH', field: `keys.${key.keyId}.network`, message: `Key ${key.keyId} network does not match policy network.` });
  }
  if (policy.paths.length === 0) errors.push({ code: 'NO_PATHS', field: 'paths', message: 'At least one path is required.' });
  for (const path of policy.paths) {
    if (path.threshold < 1) errors.push({ code: 'INVALID_THRESHOLD', field: `paths.${path.pathId}.threshold`, message: `Path ${path.pathId} threshold must be positive.` });
    if (path.threshold > path.keyIds.length) errors.push({ code: 'THRESHOLD_EXCEEDS_KEYS', field: `paths.${path.pathId}.threshold`, message: `Path ${path.pathId} threshold exceeds available keys.` });
    const seen = new Set<string>();
    for (const keyId of path.keyIds) {
      if (seen.has(keyId)) errors.push({ code: 'DUPLICATE_KEY_IN_PATH', field: `paths.${path.pathId}.keyIds`, message: `Path ${path.pathId} duplicates key ${keyId}.` });
      seen.add(keyId);
      const key = keyMap.get(keyId);
      if (!key) { errors.push({ code: 'UNKNOWN_KEY', field: `paths.${path.pathId}.keyIds`, message: `Path ${path.pathId} references missing key ${keyId}.` }); continue; }
      const member = policy.members.find((m) => m.memberId === key.memberId);
      if (!member?.active) errors.push({ code: 'INACTIVE_MEMBER_KEY', field: `paths.${path.pathId}.keyIds`, message: `Path ${path.pathId} uses inactive member key ${keyId}.` });
    }
    if (path.kind === 'inheritance' && (!path.timelock || path.timelock.value <= 0)) errors.push({ code: 'MISSING_INHERITANCE_TIMELOCK', field: `paths.${path.pathId}.timelock`, message: `Inheritance path ${path.pathId} needs a valid timelock.` });
    if (path.kind === 'emergency' && path.timelock && path.timelock.value <= 0) errors.push({ code: 'INVALID_TIMELOCK', field: `paths.${path.pathId}.timelock`, message: `Emergency path ${path.pathId} timelock must be positive.` });
  }
  if (!policy.paths.some((p) => p.kind === 'emergency')) warnings.push({ code: 'NO_EMERGENCY_PATH', field: 'paths', message: 'No emergency path is defined yet.' });
  if (!policy.paths.some((p) => p.kind === 'inheritance')) warnings.push({ code: 'NO_INHERITANCE_PATH', field: 'paths', message: 'No inheritance path is defined yet.' });
  if (policy.keys.length > 0 && policy.keys.every((key) => key.origin === 'software')) warnings.push({ code: 'ALL_SOFTWARE_KEYS', field: 'keys', message: 'All current keys are software keys.' });
  if (policy.members.length === 1 && policy.keys.length > 0) warnings.push({ code: 'ONE_PERSON_CONTROLS_ALL_KEYS', field: 'members', message: 'One person appears to control every key.' });
  const oneOfOne = policy.paths.find((p) => p.kind === 'normal' && p.threshold === 1 && p.keyIds.length === 1);
  if (oneOfOne) warnings.push({ code: 'SINGLE_SIG_POLICY', field: `paths.${oneOfOne.pathId}`, message: 'The normal path is effectively 1-of-1.' });
  return { ok: errors.length === 0, errors, warnings };
}

export function summarizePolicy(policy: VaultPolicy): string {
  return `${policy.name} on ${policy.network} with ${policy.members.length} members, ${policy.keys.length} keys, and ${policy.paths.length} policy paths.`;
}

// ── Fail-closed signing gate ────────────────────────────────────────────────
//
// The Tier-2 spine from docs/threat-model-and-fail-closed.md. The in-app
// signer calls this IMMEDIATELY BEFORE signing and refuses on any denial.
// It is NOT consensus (a key-holder can sign off-platform); its job is the
// governing invariant: our platform must never be a SHORTCUT around the
// script. It only ever signs a transaction that exactly matches a green,
// non-duress ceremony bound to this vault -- so deviating gains an attacker
// nothing our app didn't already require, and trips the checks instead.
//
// Default-DENY by construction: allow is true only when there are zero
// denials. A missing/unknown ceremony is an immediate hard deny.

export type CeremonyStatus =
  | 'draft' | 'pending' | 'approved' | 'signing' | 'broadcast' | 'cancelled';

/** The proposal/ceremony a spend must exactly match to be signable. */
export interface SigningCeremony {
  proposalId: string;
  vaultId: string;
  status: CeremonyStatus;
  /** Stable digest of the unsigned PSBT the ceremony authorized. The spend
   *  being signed MUST carry the identical digest. */
  authorizedPsbtHash: string;
  destination: string;
  amountSats: number;
  /** Spend path id (e.g. parents_now / kids_decay / recovery). */
  path: string;
  /** Go-for-green: approvals required vs collected from the member roster. */
  approvalsRequired: number;
  approvalsCollected: number;
  /** A duress / hold signal dominates everything (Q4). */
  duress: boolean;
  /** Optional expiry (epoch ms). */
  expiresAt?: number;
}

/** What the wallet is about to sign, plus the bindings to verify. */
export interface SigningGateInput {
  request: {
    vaultId: string;
    /** Digest of the unsigned PSBT about to be signed. */
    psbtHash: string;
    destination: string;
    amountSats: number;
    path: string;
  };
  /** The ceremony authorizing this spend. null = no proposal at all -> DENY. */
  ceremony: SigningCeremony | null;
  vault: { vaultId: string; address: string };
  /** Whether the PSBT's inputs were verified to belong to vault.address.
   *  The caller computes this; the gate refuses if it is not true. */
  psbtBindsToVault: boolean;
  /** Optional script-mirroring governance result (timelock+quorum+dust).
   *  If explicitly false, the gate denies. undefined = not supplied. */
  governanceApproved?: boolean;
}

export interface SigningGateResult { allow: boolean; denials: ValidationMessage[]; }

export function evaluateSigningGate(
  input: SigningGateInput,
  now: number = Date.now(),
): SigningGateResult {
  const denials: ValidationMessage[] = [];
  const deny = (code: string, message: string) => denials.push({ code, message });

  const { request, ceremony, vault, psbtBindsToVault, governanceApproved } = input;

  // Hard fail-closed gate: with no ceremony there is nothing that
  // authorizes this spend. Stop here -- do not evaluate anything else.
  if (!ceremony) {
    deny('NO_CEREMONY', 'No proposal authorizes this spend. The wallet will not sign an unproposed transaction.');
    return { allow: false, denials };
  }

  // The PSBT must provably belong to this vault, and spend + ceremony +
  // vault must all name the same vault.
  if (!psbtBindsToVault) {
    deny('PSBT_NOT_BOUND', 'The PSBT inputs do not belong to this vault address.');
  }
  if (ceremony.vaultId !== vault.vaultId || request.vaultId !== vault.vaultId) {
    deny('VAULT_MISMATCH', 'The spend, the ceremony, and the vault do not all refer to the same vault.');
  }

  // Exact-match binding: we sign ONLY the transaction that was proposed and
  // approved -- same PSBT digest, destination, amount, and path. This is the
  // "in sequence / no swap" enforcement and the anti-lying-device backstop.
  if (request.psbtHash !== ceremony.authorizedPsbtHash) {
    deny('PSBT_HASH_MISMATCH', 'The transaction being signed does not match the one that was proposed and approved.');
  }
  if (request.destination !== ceremony.destination) {
    deny('DESTINATION_MISMATCH', 'Destination differs from the approved proposal.');
  }
  if (request.amountSats !== ceremony.amountSats) {
    deny('AMOUNT_MISMATCH', 'Amount differs from the approved proposal.');
  }
  if (request.path !== ceremony.path) {
    deny('PATH_MISMATCH', 'Spend path differs from the approved proposal.');
  }

  // The ceremony must be in a signable state.
  const signable = ceremony.status === 'pending' || ceremony.status === 'approved' || ceremony.status === 'signing';
  if (!signable) {
    deny('CEREMONY_NOT_SIGNABLE', `Proposal status "${ceremony.status}" is not signable.`);
  }

  // Go-for-green: the member approvals threshold must be met.
  if (ceremony.approvalsCollected < ceremony.approvalsRequired) {
    deny('NOT_GREEN', `Approvals not complete: ${ceremony.approvalsCollected} of ${ceremony.approvalsRequired}.`);
  }

  // Duress dominates: hold position; funds fall to the timelock backstop.
  if (ceremony.duress) {
    deny('DURESS_HOLD', 'A duress/hold signal is active. Signing is blocked; the timelock backstop is the guarantee.');
  }

  // Expiry, if set.
  if (typeof ceremony.expiresAt === 'number' && now > ceremony.expiresAt) {
    deny('CEREMONY_EXPIRED', 'This proposal has expired. Re-propose to sign.');
  }

  // Script-mirroring governance, if supplied.
  if (governanceApproved === false) {
    deny('GOVERNANCE_REJECTED', 'Governance audit did not approve this spend (timelock/quorum/limits).');
  }

  return { allow: denials.length === 0, denials };
}

// ── Ceremony bridge ─────────────────────────────────────────────────────────
//
// Maps persisted records (a proposal + its advisory approve-votes + a duress
// flag) into the SigningCeremony the gate consumes. This is the
// correctness-critical glue between the database and the fail-closed gate:
// it counts DISTINCT approvers, maps the proposal status to a signable
// state, and carries the duress signal. Pure + unit-tested.
//
// Status mapping (proposals.status -> CeremonyStatus):
//   draft     -> draft      (not signable -- not yet submitted)
//   pending   -> pending    (signable -- awaiting signatures)
//   signed    -> signing    (signable -- some signatures collected)
//   broadcast -> broadcast  (terminal)
//   cancelled -> cancelled  (terminal)

export interface ProposalRecord {
  proposalId: string;
  vaultId: string;
  status: string;
  destination: string;
  amountSats: number;
  path: string;
}

export interface CeremonyBridgeInput {
  proposal: ProposalRecord;
  /** Binding digest of the proposal's unsigned PSBT, computed by the caller
   *  with the SAME hash used at sign time (single source of truth). */
  authorizedPsbtHash: string;
  /** User ids that voted 'approve'. Deduped here. */
  approveVoterIds: string[];
  /** Go-for-green threshold (e.g. the path's signing quorum). */
  approvalsRequired: number;
  /** A duress / hold signal on the vault or proposal -- dominates. */
  duress: boolean;
  expiresAt?: number;
}

function mapProposalStatus(status: string): CeremonyStatus {
  switch (status) {
    case 'pending': return 'pending';
    case 'signed': return 'signing';
    case 'broadcast': return 'broadcast';
    case 'cancelled': return 'cancelled';
    case 'draft':
    default: return 'draft';
  }
}

export function ceremonyFromProposal(input: CeremonyBridgeInput): SigningCeremony {
  const { proposal, authorizedPsbtHash, approveVoterIds, approvalsRequired, duress, expiresAt } = input;
  const ceremony: SigningCeremony = {
    proposalId: proposal.proposalId,
    vaultId: proposal.vaultId,
    status: mapProposalStatus(proposal.status),
    authorizedPsbtHash,
    destination: proposal.destination,
    amountSats: proposal.amountSats,
    path: proposal.path,
    approvalsRequired,
    approvalsCollected: new Set(approveVoterIds).size,
    duress,
  };
  if (typeof expiresAt === 'number') ceremony.expiresAt = expiresAt;
  return ceremony;
}
