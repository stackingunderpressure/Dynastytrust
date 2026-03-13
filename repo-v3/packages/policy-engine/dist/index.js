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
