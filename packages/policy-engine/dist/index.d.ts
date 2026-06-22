export type Network = 'testnet' | 'mainnet';
export type KeyOrigin = 'software' | 'hardware' | 'imported_xpub';
export type MemberRole = 'owner' | 'spouse' | 'child' | 'trustee' | 'executor' | 'guardian' | 'observer';
export interface PolicyMember {
    memberId: string;
    displayName: string;
    role: MemberRole;
    active: boolean;
}
export interface PolicyKeyRef {
    keyId: string;
    memberId: string;
    label: string;
    origin: KeyOrigin;
    purpose: 'primary' | 'backup' | 'recovery';
    network?: Network;
}
export interface TimeConstraint {
    type: 'relative' | 'absolute';
    value: number;
}
export type PathConstraint = {
    type: 'max_amount';
    sats: number;
} | {
    type: 'cooldown';
    blocks: number;
} | {
    type: 'notice_period';
    hours: number;
};
export interface NormalPath {
    pathId: string;
    kind: 'normal';
    threshold: number;
    keyIds: string[];
    constraints?: PathConstraint[];
}
export interface EmergencyPath {
    pathId: string;
    kind: 'emergency';
    threshold: number;
    keyIds: string[];
    timelock?: TimeConstraint;
    action: 'move_to_new_vault' | 'sweep_to_safe_address';
    constraints?: PathConstraint[];
}
export interface InheritancePath {
    pathId: string;
    kind: 'inheritance';
    threshold: number;
    keyIds: string[];
    timelock: TimeConstraint;
    constraints?: PathConstraint[];
}
export type PolicyPath = NormalPath | EmergencyPath | InheritancePath;
export interface PolicyRules {
    allowKeyReplacement: boolean;
    allowThresholdChange: boolean;
    requireAuditTrail: boolean;
    requireHumanSummary: boolean;
    testMode: boolean;
}
export interface VaultPolicy {
    version: 1;
    policyId: string;
    name: string;
    network: Network;
    members: PolicyMember[];
    keys: PolicyKeyRef[];
    paths: PolicyPath[];
    rules: PolicyRules;
    metadata?: Record<string, string>;
}
export interface ValidationMessage {
    code: string;
    field?: string;
    message: string;
}
export interface PolicyValidationResult {
    ok: boolean;
    errors: ValidationMessage[];
    warnings: ValidationMessage[];
}
export declare function validatePolicy(policy: VaultPolicy): PolicyValidationResult;
export declare function summarizePolicy(policy: VaultPolicy): string;
export type CeremonyStatus = 'draft' | 'pending' | 'approved' | 'signing' | 'broadcast' | 'cancelled';
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
    vault: {
        vaultId: string;
        address: string;
    };
    /** Whether the PSBT's inputs were verified to belong to vault.address.
     *  The caller computes this; the gate refuses if it is not true. */
    psbtBindsToVault: boolean;
    /** Optional script-mirroring governance result (timelock+quorum+dust).
     *  If explicitly false, the gate denies. undefined = not supplied. */
    governanceApproved?: boolean;
}
export interface SigningGateResult {
    allow: boolean;
    denials: ValidationMessage[];
}
export declare function evaluateSigningGate(input: SigningGateInput, now?: number): SigningGateResult;
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
export declare function ceremonyFromProposal(input: CeremonyBridgeInput): SigningCeremony;
