import assert from 'node:assert/strict';
import { validatePolicy } from '../packages/policy-engine/dist/index.js';
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
console.log('policy tests passed');
