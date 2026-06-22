export function validatePolicy(policy) {
    const errors = [];
    const warnings = [];
    const memberIds = new Set(policy.members.map((m) => m.memberId));
    const keyMap = new Map(policy.keys.map((k) => [k.keyId, k]));
    for (const key of policy.keys) {
        if (!memberIds.has(key.memberId))
            errors.push({ code: 'UNKNOWN_MEMBER', field: `keys.${key.keyId}.memberId`, message: `Missing member ${key.memberId} for key ${key.keyId}.` });
        if (key.network && key.network !== policy.network)
            errors.push({ code: 'NETWORK_MISMATCH', field: `keys.${key.keyId}.network`, message: `Key ${key.keyId} network does not match policy network.` });
    }
    if (policy.paths.length === 0)
        errors.push({ code: 'NO_PATHS', field: 'paths', message: 'At least one path is required.' });
    for (const path of policy.paths) {
        if (path.threshold < 1)
            errors.push({ code: 'INVALID_THRESHOLD', field: `paths.${path.pathId}.threshold`, message: `Path ${path.pathId} threshold must be positive.` });
        if (path.threshold > path.keyIds.length)
            errors.push({ code: 'THRESHOLD_EXCEEDS_KEYS', field: `paths.${path.pathId}.threshold`, message: `Path ${path.pathId} threshold exceeds available keys.` });
        const seen = new Set();
        for (const keyId of path.keyIds) {
            if (seen.has(keyId))
                errors.push({ code: 'DUPLICATE_KEY_IN_PATH', field: `paths.${path.pathId}.keyIds`, message: `Path ${path.pathId} duplicates key ${keyId}.` });
            seen.add(keyId);
            const key = keyMap.get(keyId);
            if (!key) {
                errors.push({ code: 'UNKNOWN_KEY', field: `paths.${path.pathId}.keyIds`, message: `Path ${path.pathId} references missing key ${keyId}.` });
                continue;
            }
            const member = policy.members.find((m) => m.memberId === key.memberId);
            if (!member?.active)
                errors.push({ code: 'INACTIVE_MEMBER_KEY', field: `paths.${path.pathId}.keyIds`, message: `Path ${path.pathId} uses inactive member key ${keyId}.` });
        }
        if (path.kind === 'inheritance' && (!path.timelock || path.timelock.value <= 0))
            errors.push({ code: 'MISSING_INHERITANCE_TIMELOCK', field: `paths.${path.pathId}.timelock`, message: `Inheritance path ${path.pathId} needs a valid timelock.` });
        if (path.kind === 'emergency' && path.timelock && path.timelock.value <= 0)
            errors.push({ code: 'INVALID_TIMELOCK', field: `paths.${path.pathId}.timelock`, message: `Emergency path ${path.pathId} timelock must be positive.` });
    }
    if (!policy.paths.some((p) => p.kind === 'emergency'))
        warnings.push({ code: 'NO_EMERGENCY_PATH', field: 'paths', message: 'No emergency path is defined yet.' });
    if (!policy.paths.some((p) => p.kind === 'inheritance'))
        warnings.push({ code: 'NO_INHERITANCE_PATH', field: 'paths', message: 'No inheritance path is defined yet.' });
    if (policy.keys.length > 0 && policy.keys.every((key) => key.origin === 'software'))
        warnings.push({ code: 'ALL_SOFTWARE_KEYS', field: 'keys', message: 'All current keys are software keys.' });
    if (policy.members.length === 1 && policy.keys.length > 0)
        warnings.push({ code: 'ONE_PERSON_CONTROLS_ALL_KEYS', field: 'members', message: 'One person appears to control every key.' });
    const oneOfOne = policy.paths.find((p) => p.kind === 'normal' && p.threshold === 1 && p.keyIds.length === 1);
    if (oneOfOne)
        warnings.push({ code: 'SINGLE_SIG_POLICY', field: `paths.${oneOfOne.pathId}`, message: 'The normal path is effectively 1-of-1.' });
    return { ok: errors.length === 0, errors, warnings };
}
export function summarizePolicy(policy) {
    return `${policy.name} on ${policy.network} with ${policy.members.length} members, ${policy.keys.length} keys, and ${policy.paths.length} policy paths.`;
}
export function evaluateSigningGate(input, now = Date.now()) {
    const denials = [];
    const deny = (code, message) => denials.push({ code, message });
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
function mapProposalStatus(status) {
    switch (status) {
        case 'pending': return 'pending';
        case 'signed': return 'signing';
        case 'broadcast': return 'broadcast';
        case 'cancelled': return 'cancelled';
        case 'draft':
        default: return 'draft';
    }
}
export function ceremonyFromProposal(input) {
    const { proposal, authorizedPsbtHash, approveVoterIds, approvalsRequired, duress, expiresAt } = input;
    const ceremony = {
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
    if (typeof expiresAt === 'number')
        ceremony.expiresAt = expiresAt;
    return ceremony;
}
