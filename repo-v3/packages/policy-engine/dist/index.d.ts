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
