import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Vault } from '../lib/api';
import { listKeys, revealMnemonic, type LocalKey } from '../lib/keystore';
import { sealVaultLegacyRecovery, vaultNetworkToKeystoreNetwork } from '../lib/legacy-seal';
import { vaultBackupText } from '../lib/descriptor-backup';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card } from '../components/ui';
import { useToast } from '../components/toast';

// Long-horizon descriptor recovery ("Legacy Recovery" -- see
// apps/web/src/lib/legacy-recovery.ts's header for the full mechanism).
// This page is the deliberate, explicit ceremony: the owner assigns one
// LOCAL key to each of the vault's real roles, confirms each key's
// mnemonic (prompting for a password on secure-mode keys), and seals.
// Nothing here is automatic or silent -- every key used is a choice the
// owner makes and can see, matching "no naked footgun is ever a
// one-click choice, consequences shown before commitment."

interface RoleSlot {
  role: string;      // e.g. "founder_1"
  label: string;      // e.g. "Founder 1"
}

function rolesForVault(vault: Vault): RoleSlot[] {
  const slots: RoleSlot[] = [];
  vault.founder_keys.forEach((_, i) => slots.push({ role: `founder_${i + 1}`, label: `Founder ${i + 1}` }));
  (vault.backup_keys ?? []).forEach((_, i) => slots.push({ role: `backup_${i + 1}`, label: `Backup ${i + 1}` }));
  vault.heir_keys.forEach((_, i) => slots.push({ role: `heir_${i + 1}`, label: `Heir ${i + 1}` }));
  (vault.protector_keys ?? []).forEach((_, i) => slots.push({ role: `protector_${i + 1}`, label: `Protector ${i + 1}` }));
  (vault.second_heir_keys ?? []).forEach((_, i) => slots.push({ role: `second_heir_${i + 1}`, label: `Second heir ${i + 1}` }));
  return slots;
}

export default function LegacyRecoverySetup() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [vault, setVault] = useState<Vault | null>(null);
  const [loading, setLoading] = useState(true);
  const [sealing, setSealing] = useState(false);
  const [existingShareRoles, setExistingShareRoles] = useState<Set<string>>(new Set());

  const [assignment, setAssignment] = useState<Record<string, string>>({}); // role -> keyId
  const [passwords, setPasswords] = useState<Record<string, string>>({}); // role -> password

  const localKeys = useMemo(
    () => listKeys().filter((k): k is LocalKey => k.origin === 'software' && k.status === 'active'),
    [],
  );

  useEffect(() => {
    (async () => {
      if (!id) return;
      const { vaults } = await api.vaults.list(true);
      const found = vaults.find(v => v.id === id) ?? null;
      setVault(found);
      if (found) {
        try {
          const existing = await api.legacy.get(found.id);
          setExistingShareRoles(new Set(existing.shares.map(s => s.key_role)));
        } catch {
          // No prior seal yet -- fine, this is the first time.
        }
      }
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <p style={{ color: colors.muted }}>Loading...</p>;
  if (!vault) return <p style={{ color: colors.red }}>Vault not found.</p>;
  if (!vault.descriptor) {
    return (
      <Card>
        <p style={{ color: colors.text }}>
          This vault hasn't been compiled yet. Compile it first -- Legacy Recovery seals the actual
          descriptor, so there has to be one.
        </p>
      </Card>
    );
  }

  const roles = rolesForVault(vault);

  async function handleSeal() {
    if (!vault) return;
    const missing = roles.filter(r => !assignment[r.role]);
    if (missing.length > 0) {
      toast.error(`Assign a key for: ${missing.map(r => r.label).join(', ')}`);
      return;
    }
    setSealing(true);
    try {
      const network = vaultNetworkToKeystoreNetwork(vault.network);
      const roleKeys = [];
      for (const r of roles) {
        const keyId = assignment[r.role];
        const mnemonic = await revealMnemonic(keyId, passwords[r.role]);
        roleKeys.push({ keyRole: r.role, mnemonic });
      }
      const bundleText = vaultBackupText(vault);
      await sealVaultLegacyRecovery({ vaultId: vault.id, network, bundleText, roleKeys });
      toast.success('Legacy recovery sealed for every assigned key.');
      setExistingShareRoles(new Set(roles.map(r => r.role)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sealing failed');
    } finally {
      setSealing(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: space[3] }}>
      <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, lineHeight: 1.6 }}>
        Each key below gets its own sealed copy of this vault's descriptor -- locked so only that
        exact key can ever open it, decades from now, with nothing extra to back up. Pick which of
        your local keys plays each role, confirm the password on any secure key, and seal.
      </p>

      {roles.length === 0 && (
        <Card><p style={{ color: colors.muted }}>This vault has no named roles to seal yet.</p></Card>
      )}

      {roles.map(r => {
        const key = localKeys.find(k => k.keyId === assignment[r.role]);
        const needsPassword = !!key?.encryptedMnemonic;
        const alreadySealed = existingShareRoles.has(r.role);
        return (
          <Card key={r.role}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>{r.label}</div>
                {alreadySealed && (
                  <div style={{ fontSize: 12, color: colors.gold, fontWeight: 600 }}>Sealed</div>
                )}
              </div>
              <select
                value={assignment[r.role] ?? ''}
                onChange={e => setAssignment(a => ({ ...a, [r.role]: e.target.value }))}
                style={{
                  width: '100%', padding: '10px 12px', background: colors.input,
                  border: `1px solid ${colors.border}`, borderRadius: radii.md,
                  color: colors.text, fontSize: 16, fontFamily: fonts.sans,
                }}
              >
                <option value="">Choose a local key...</option>
                {localKeys.map(k => (
                  <option key={k.keyId} value={k.keyId}>{k.label}</option>
                ))}
              </select>
              {needsPassword && (
                <input
                  type="password"
                  placeholder="Password for this key"
                  value={passwords[r.role] ?? ''}
                  onChange={e => setPasswords(p => ({ ...p, [r.role]: e.target.value }))}
                  style={{
                    width: '100%', padding: '10px 12px', background: colors.input,
                    border: `1px solid ${colors.border}`, borderRadius: radii.md,
                    color: colors.text, fontSize: 16, fontFamily: fonts.sans,
                    boxSizing: 'border-box',
                  }}
                />
              )}
            </div>
          </Card>
        );
      })}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button onClick={handleSeal} disabled={sealing || roles.length === 0}>
          {sealing ? 'Sealing...' : 'Seal legacy recovery'}
        </Button>
        <button
          type="button"
          onClick={() => navigate(`/vaults/${vault.id}`)}
          style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 13, padding: 0, fontFamily: fonts.sans }}
        >
          Back to vault
        </button>
      </div>

      <div
        style={{
          background: colors.input, border: `1px solid ${colors.gold}33`, borderRadius: radii.md,
          padding: '14px 18px', fontSize: 14, color: colors.sub, lineHeight: 1.6,
        }}
      >
        Sealing doesn't move any funds and doesn't change the vault's spending policy -- it only
        locks a recovery copy of the descriptor to each key above. You can reseal any time the
        descriptor changes; a reseal replaces every prior share, so keep everyone's keys current.
      </div>

      <div style={{ fontSize: 13, color: colors.muted }}>
        Recovery itself doesn't need DynastyTrust running -- it needs a key and{' '}
        <a href="/dynastytrust-legacy-recovery-tool.html" target="_blank" rel="noopener noreferrer" style={{ color: colors.gold }}>
          this standalone recovery tool
        </a>{' '}
        (opens offline, in any browser, with nothing else installed). Keep a copy of it alongside
        every backup.
      </div>
    </div>
  );
}
