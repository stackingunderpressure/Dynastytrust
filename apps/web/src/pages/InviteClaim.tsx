import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase, type Session } from '../lib/supabase';
import { api, type TrustDoc, type VaultRole } from '../lib/api';
import { listKeys, type LocalKey } from '../lib/keystore';
import { APP_NAME } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input, Label } from '../components/ui';
import { LoadingScreen } from '../components/LoadingScreen';
import { useToast } from '../components/toast';
import { QrScanner } from '../components/QrScanner';
import { pubkeyFromXpub } from '../lib/xpub';
import Auth from './Auth';

type InvitableRole = Exclude<VaultRole, 'owner'>;

interface InviteInfo {
  id: string;
  vault_id: string;
  invited_role: InvitableRole;
  invited_label: string | null;
  expires_at: string;
}

interface VaultInfo {
  id: string;
  name: string;
  network: 'testnet' | 'signet' | 'bitcoin';
  status: string;
  founder_quorum: number;
  heir_quorum: number;
  recovery_after: number;
  inheritance_after: number;
  protector_after: number | null;
  consent_quorum: number | null;
  trust_doc: TrustDoc;
  founder_count: number;
  heir_count: number;
  protector_count: number;
  consent_count: number;
  planned_founder_count: number | null;
  planned_heir_count: number | null;
}

interface MemberPreview {
  id: string;
  role: VaultRole;
  label: string | null;
  status: string;
  created_at: string;
}

// Roles where the caller does NOT need to attach a signing key. For
// these we default to "skip" so the claim form doesn't block them
// on a decision that doesn't apply.
const NO_KEY_ROLES = new Set<InvitableRole>(['viewer', 'beneficiary']);

// // -- Claim page
// Renders the invite details, then either an inline <Auth /> screen
// for unauthenticated users or the key-picker + claim form for
// authenticated ones.

export default function InviteClaim() {
  const { token } = useParams<{ token: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [members, setMembers] = useState<MemberPreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!token) {
      setError('Missing invite token');
      setLoading(false);
      return;
    }
    api.invites
      .lookup(token)
      .then(res => {
        setInvite(res.invite);
        setVault(res.vault ?? null);
        setMembers(res.members ?? []);
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load invite'))
      .finally(() => setLoading(false));
  }, [token]);

  if (sessionLoading || loading) return <LoadingScreen />;

  if (error) return <CenteredCard><ErrorBody message={error} /></CenteredCard>;
  if (!invite || !vault) return <CenteredCard><ErrorBody message="Invite not found" /></CenteredCard>;

  // Not signed in: show Auth inline with a banner + vault preview.
  if (!session) {
    return (
      <div
        style={{
          minHeight: '100vh',
          fontFamily: fonts.sans,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <InviteBanner invite={invite} vault={vault} />
        <VaultPreviewBlock invite={invite} vault={vault} members={members} />
        <Auth redirectTo={typeof window !== 'undefined' ? window.location.href : undefined} />
      </div>
    );
  }

  // Signed in: show the claim form.
  return (
    <CenteredCard>
      <ClaimForm token={token!} invite={invite} vault={vault} members={members} />
    </CenteredCard>
  );
}

// // -- Banner (unauthenticated view)

function InviteBanner({ invite, vault }: { invite: InviteInfo; vault: VaultInfo }) {
  return (
    <div
      style={{
        padding: `${space[5]}px ${space[6]}px`,
        background: colors.surface,
        borderBottom: `1px solid ${colors.gold}44`,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color: colors.gold,
          marginBottom: 4,
        }}
      >
        {APP_NAME}
      </div>
      <div style={{ fontSize: 15, color: colors.text, marginBottom: 4 }}>
        You've been invited to <strong>{vault.name}</strong> as {invite.invited_role}
      </div>
      <div style={{ fontSize: 12, color: colors.muted }}>
        Sign in or create an account to claim your spot.
      </div>
    </div>
  );
}

// // -- Claim form (authenticated view)

interface HwKeyDraft {
  xpub: string;
  fingerprint: string;
  derivation_path: string;
  pubkey: string;
}

function ClaimForm({
  token,
  invite,
  vault,
  members,
}: {
  token: string;
  invite: InviteInfo;
  vault: VaultInfo;
  members: MemberPreview[];
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [label, setLabel] = useState(invite.invited_label ?? '');
  // Default to skip for roles that never sign (viewer, beneficiary).
  // Everyone else defaults to browser mode, which works on any box
  // whether or not the user has a hardware wallet handy.
  const [mode, setMode] = useState<'hardware' | 'browser' | 'skip'>(
    NO_KEY_ROLES.has(invite.invited_role) ? 'skip' : 'browser',
  );
  const [selectedKeyId, setSelectedKeyId] = useState<string>('');
  const [hwKey, setHwKey] = useState<HwKeyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const keys = listKeys().filter(k => k.status === 'active' && k.network === vault.network);
  const needsKey = !NO_KEY_ROLES.has(invite.invited_role);

  // Wizard flow. Viewer / beneficiary skip the key step entirely.
  const steps: { id: string; title: string }[] = [
    { id: 'welcome', title: 'Welcome' },
    { id: 'vault', title: 'Review vault' },
    { id: 'role', title: 'Your role' },
    ...(needsKey ? [{ id: 'key', title: 'Signing key' }] : []),
    { id: 'confirm', title: 'Confirm' },
  ];
  const [stepIdx, setStepIdx] = useState(0);
  const stepId = steps[stepIdx].id;
  const isLast = stepIdx === steps.length - 1;
  const isFirst = stepIdx === 0;

  // Validate before moving off the key step.
  function canAdvance(): true | string {
    if (stepId !== 'key') return true;
    if (mode === 'skip') return true;
    if (mode === 'browser') {
      if (!selectedKeyId) return 'Pick a local key or switch to Skip.';
      return true;
    }
    if (mode === 'hardware') {
      if (!hwKey) return 'Scan or paste your xpub first, or switch to Skip.';
      return true;
    }
    return true;
  }

  function next() {
    const v = canAdvance();
    if (v !== true) { setErr(v); return; }
    setErr(null);
    setStepIdx(i => Math.min(steps.length - 1, i + 1));
  }
  function back() {
    setErr(null);
    setStepIdx(i => Math.max(0, i - 1));
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      let payload: Parameters<typeof api.invites.claim>[0] = {
        token,
        label: label.trim() || undefined,
      };
      if (needsKey) {
        if (mode === 'browser') {
          const selected: LocalKey | undefined = keys.find(k => k.keyId === selectedKeyId);
          if (selected) {
            payload = {
              ...payload,
              xpub: selected.xpub,
              fingerprint: selected.masterFingerprint ?? selected.fingerprint,
              pubkey: selected.pubkey,
              derivation_path: selected.derivationPath,
              key_label: selected.label,
            };
          }
        } else if (mode === 'hardware' && hwKey) {
          payload = {
            ...payload,
            xpub: hwKey.xpub,
            fingerprint: hwKey.fingerprint,
            derivation_path: hwKey.derivation_path,
            pubkey: hwKey.pubkey,
            key_label: 'Hardware wallet',
          };
        }
      }
      const res = await api.invites.claim(payload);
      toast.success('Joined ' + vault.name);
      navigate(`/vaults/${res.vault_id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to claim invite');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <WizardHeader vault={vault} invite={invite} steps={steps} activeIdx={stepIdx} />

      {stepId === 'welcome' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 16, color: colors.text, lineHeight: 1.55 }}>
            You have been invited to join <strong>{vault.name}</strong> as{' '}
            <strong>{invite.invited_role}</strong>.
          </div>
          <div style={{ fontSize: 13, color: colors.sub, lineHeight: 1.6 }}>
            On the next steps you will:
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              <li>Review the vault&apos;s trust document and governance rules</li>
              <li>Understand what your role means and what is expected</li>
              {needsKey && <li>Attach a signing key (or skip and add it later)</li>}
              <li>Confirm and claim your spot</li>
            </ul>
          </div>
          <div style={{ fontSize: 12, color: colors.muted, marginTop: 4 }}>
            You can back out anytime -- no commitment until you click <em>Claim</em> on the last step.
          </div>
        </div>
      )}

      {stepId === 'vault' && (
        <VaultPreviewBlock invite={invite} vault={vault} members={members} />
      )}

      {stepId === 'role' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <RolePrimer role={invite.invited_role} />
          <div>
            <Label>Display name (optional)</Label>
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={invite.invited_label ?? 'e.g. Dad, Sister, Lawyer'}
            />
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>
              How other members see you on the roster.
            </div>
          </div>
        </div>
      )}

      {stepId === 'key' && needsKey && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: colors.sub, lineHeight: 1.55 }}>
            Attach a signing key so you can sign transactions for this vault.
            You can change it later from the Members tab.
          </div>
          <div
            style={{
              display: 'flex',
              gap: 4,
              background: colors.input,
              borderRadius: radii.md,
              padding: 4,
            }}
          >
            {(['hardware', 'browser', 'skip'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  flex: 1,
                  padding: '8px 0',
                  border: 'none',
                  borderRadius: radii.sm,
                  background: mode === m ? colors.border : 'transparent',
                  color: mode === m ? colors.text : colors.muted,
                  fontSize: 12,
                  fontFamily: fonts.sans,
                  cursor: 'pointer',
                }}
              >
                {m === 'hardware' ? 'Hardware wallet' : m === 'browser' ? 'Browser key' : "I'll add later"}
              </button>
            ))}
          </div>

          {mode === 'hardware' && (
            <HardwareKeyInput network={vault.network} value={hwKey} onChange={setHwKey} />
          )}

          {mode === 'browser' && (
            <>
              <select
                value={selectedKeyId}
                onChange={e => setSelectedKeyId(e.target.value)}
                style={{
                  width: '100%',
                  padding: '11px 13px',
                  background: colors.input,
                  border: `1px solid ${colors.border}`,
                  borderRadius: radii.md,
                  color: colors.text,
                  fontSize: 14,
                  fontFamily: fonts.sans,
                  boxSizing: 'border-box',
                }}
              >
                <option value="">Pick a local key...</option>
                {keys.map(k => (
                  <option key={k.keyId} value={k.keyId}>
                    [{k.persona}] {k.label} ({k.fingerprint})
                  </option>
                ))}
              </select>
              {keys.length === 0 && (
                <div style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>
                  No {vault.network} keys in this browser. Generate one on the Keys tab first, or switch to hardware wallet / I&apos;ll add later.
                </div>
              )}
              <div style={{ fontSize: 11, color: colors.orange }}>
                Browser keys are for testing only. Use a hardware wallet for real funds.
              </div>
            </>
          )}

          {mode === 'skip' && (
            <div style={{ fontSize: 13, color: colors.muted, lineHeight: 1.5, padding: 10, background: colors.input, borderRadius: radii.sm }}>
              No problem -- you will claim your slot now and attach a key later from the vault&apos;s Members tab. The vault cannot be compiled until every slot has a key, so try not to leave it too long.
            </div>
          )}
        </div>
      )}

      {stepId === 'confirm' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.55 }}>
            Ready to join <strong>{vault.name}</strong>.
          </div>
          <div style={{ fontSize: 13, color: colors.sub, lineHeight: 1.7 }}>
            <div>Role: <strong style={{ color: colors.text }}>{invite.invited_role}</strong></div>
            <div>Display name: <strong style={{ color: colors.text }}>{label.trim() || invite.invited_label || '(none)'}</strong></div>
            {needsKey && (
              <div>
                Key: <strong style={{ color: colors.text }}>
                  {mode === 'skip' && 'will add later'}
                  {mode === 'browser' && (selectedKeyId
                    ? keys.find(k => k.keyId === selectedKeyId)?.label
                    : 'none selected')}
                  {mode === 'hardware' && (hwKey ? `hw wallet ${hwKey.fingerprint}` : 'none')}
                </strong>
              </div>
            )}
            <div>Network: <strong style={{ color: colors.text }}>{vault.network.toUpperCase()}</strong></div>
          </div>
          <div style={{ fontSize: 12, color: colors.muted, marginTop: 4 }}>
            Clicking Claim links your account to this slot on the vault. The vault will show up on your Dashboard.
          </div>
        </div>
      )}

      {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}

      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        {!isFirst && (
          <Button type="button" variant="ghost" onClick={back} disabled={busy}>
            Back
          </Button>
        )}
        {!isLast && (
          <Button type="button" onClick={next} style={{ marginLeft: 'auto' }}>
            Continue
          </Button>
        )}
        {isLast && (
          <Button type="button" onClick={submit} disabled={busy} style={{ marginLeft: 'auto' }}>
            {busy ? 'Claiming...' : 'Claim my spot'}
          </Button>
        )}
      </div>
    </div>
  );
}

// // -- Wizard header: progress dots + title
function WizardHeader({
  vault,
  invite,
  steps,
  activeIdx,
}: {
  vault: VaultInfo;
  invite: InviteInfo;
  steps: { id: string; title: string }[];
  activeIdx: number;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color: colors.gold,
          marginBottom: 2,
        }}
      >
        {APP_NAME}
      </div>
      <div style={{ fontSize: 14, color: colors.text, marginBottom: 2 }}>
        Join <strong>{vault.name}</strong> as {invite.invited_role}
      </div>
      <div style={{ fontSize: 11, color: colors.muted, marginBottom: 12 }}>
        Step {activeIdx + 1} of {steps.length} - {steps[activeIdx].title}
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        {steps.map((s, i) => (
          <div
            key={s.id}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: i <= activeIdx ? colors.gold : colors.border,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// // -- Small helpers

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: space[6],
        fontFamily: fonts.sans,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: '40px 32px',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ErrorBody({ message }: { message: string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color: colors.gold,
          marginBottom: 12,
        }}
      >
        {APP_NAME}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
        Can't use this invite
      </div>
      <div style={{ fontSize: 14, color: colors.sub }}>{message}</div>
    </div>
  );
}

const ROLE_PRIMERS: Record<InvitableRole, { title: string; body: string }> = {
  founder: {
    title: 'You are joining as a Trustee.',
    body:
      "Trustees sign spends on behalf of the vault. You need a signing " +
      "key; once the vault is compiled your signature, combined with " +
      "other trustees up to the quorum, authorizes transactions. You " +
      "can attach a key now or later from the vault's Members tab.",
  },
  heir: {
    title: 'You are joining as a Successor.',
    body:
      "Successors inherit the vault after its inheritance timelock " +
      "elapses. You need a signing key, but you will not use it until " +
      "the inheritance path unlocks (often years from now). Back it up " +
      "carefully. You can attach a key now or later.",
  },
  protector: {
    title: 'You are joining as a Protector.',
    body:
      "Protectors can intervene via a time-locked emergency path if " +
      "the trustees become unable or unwilling to act. You need a " +
      "signing key. The protector role carries fiduciary weight in many " +
      "jurisdictions -- accept only if you understand the responsibility.",
  },
  beneficiary: {
    title: 'You are joining as a Beneficiary.',
    body:
      "Beneficiaries receive distributions from the vault according to " +
      "the trust document. No signing key is required. You can review " +
      "the trust doc below and, if it includes a consent quorum for " +
      "your slot, attach a key later to co-sign day-to-day spends.",
  },
  viewer: {
    title: 'You are joining as an Observer.',
    body:
      "Observers have read-only access to the vault and its governance " +
      "log. No signing key is required -- click through to confirm.",
  },
};

function RolePrimer({ role }: { role: InvitableRole }) {
  const p = ROLE_PRIMERS[role];
  if (!p) return null;
  return (
    <div
      style={{
        background: colors.input,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${colors.gold}`,
        borderRadius: radii.md,
        padding: '12px 14px',
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
        {p.title}
      </div>
      <div style={{ fontSize: 13, color: colors.sub, lineHeight: 1.55 }}>{p.body}</div>
    </div>
  );
}

function blocksToApproxMonths(blocks: number): string {
  if (!blocks || blocks <= 0) return 'unset';
  const days = Math.round((blocks * 10) / 60 / 24);
  if (days < 30) return `~${days} days`;
  if (days < 365) return `~${Math.round(days / 30)} months`;
  return `~${(days / 365).toFixed(1)} years`;
}

function VaultPreviewBlock({
  invite,
  vault,
  members,
}: {
  invite: InviteInfo;
  vault: VaultInfo;
  members: MemberPreview[];
}) {
  const trust = vault.trust_doc || {};
  const hasTrustDoc =
    !!trust.purpose ||
    !!trust.distribution_rules ||
    !!trust.succession_notes ||
    (trust.beneficiaries && trust.beneficiaries.length > 0);
  const activeMembers = members.filter(m => m.status !== 'removed');
  const plannedF = vault.planned_founder_count ?? vault.founder_count;
  const plannedH = vault.planned_heir_count ?? vault.heir_count;

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        padding: '14px 16px',
        marginBottom: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: colors.gold,
          textTransform: 'uppercase',
          marginBottom: 10,
        }}
      >
        What you are joining
      </div>

      {hasTrustDoc ? (
        <div style={{ marginBottom: 12 }}>
          {trust.purpose && (
            <PreviewField label="Purpose" value={trust.purpose} />
          )}
          {trust.beneficiaries && trust.beneficiaries.length > 0 && (
            <PreviewField
              label="Beneficiaries"
              value={trust.beneficiaries
                .map(b => b.name + (b.relation ? ` (${b.relation})` : ''))
                .join(', ')}
            />
          )}
          {trust.distribution_rules && (
            <PreviewField label="Distribution rules" value={trust.distribution_rules} />
          )}
          {trust.succession_notes && (
            <PreviewField label="Succession" value={trust.succession_notes} />
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.5, marginBottom: 10 }}>
          No trust document has been drafted yet. Ask the inviter to fill
          it in before you commit to the vault if the governance rules
          matter to you.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 }}>
        <Fact label="Trustees" value={`${vault.founder_quorum} of ${plannedF || '?'}`} />
        {plannedH > 0 && (
          <Fact label="Successors" value={`${vault.heir_quorum} of ${plannedH}`} />
        )}
        <Fact label="Recovery unlocks" value={blocksToApproxMonths(vault.recovery_after)} />
        {vault.inheritance_after > 0 && (
          <Fact label="Inheritance unlocks" value={blocksToApproxMonths(vault.inheritance_after)} />
        )}
        {vault.protector_after && vault.protector_after > 0 && (
          <Fact label="Protector unlocks" value={blocksToApproxMonths(vault.protector_after)} />
        )}
        {vault.consent_quorum != null && (
          <Fact label="Consent quorum" value={`${vault.consent_quorum} beneficiary sig(s)`} />
        )}
      </div>

      {activeMembers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: colors.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Members already on this vault
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {activeMembers.map(m => (
              <li key={m.id} style={{ fontSize: 12, color: colors.text }}>
                {m.label ?? '(unlabeled)'} <span style={{ color: colors.muted }}>-- {m.role}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: colors.muted, fontStyle: 'italic' }}>
        You are being invited as {invite.invited_role}. If the vault or any
        of the numbers above do not match what the inviter told you, stop
        and confirm before accepting.
      </div>
    </div>
  );
}

function PreviewField({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: colors.muted, textTransform: 'uppercase', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{value}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: colors.input, borderRadius: radii.sm, padding: '6px 10px' }}>
      <div style={{ fontSize: 10, color: colors.muted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 12, color: colors.text, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function HardwareKeyInput({
  network,
  value,
  onChange,
}: {
  network: 'testnet' | 'signet' | 'bitcoin';
  value: HwKeyDraft | null;
  onChange: (v: HwKeyDraft | null) => void;
}) {
  const [showScanner, setShowScanner] = useState(false);
  const [raw, setRaw] = useState('');
  const [fp, setFp] = useState('');
  const [path, setPath] = useState(
    network === 'bitcoin' ? "m/48'/0'/0'/2'" : "m/48'/1'/0'/2'",
  );
  const [err, setErr] = useState<string | null>(null);

  function applyScan(text: string) {
    setShowScanner(false);
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed) as {
          xpub?: string;
          xfp?: string;
          fingerprint?: string;
          path?: string;
          derivation_path?: string;
        };
        if (obj.xpub) setRaw(obj.xpub);
        const fpCandidate = obj.xfp ?? obj.fingerprint;
        if (fpCandidate) setFp(fpCandidate);
        const pathCandidate = obj.path ?? obj.derivation_path;
        if (pathCandidate) setPath(pathCandidate);
        return;
      } catch {
        /* fall through to raw-text path */
      }
    }
    setRaw(trimmed);
  }

  function commit() {
    setErr(null);
    const xpub = raw.trim();
    const fingerprint = fp.trim();
    const derivation_path = path.trim();
    if (!xpub) {
      setErr('Paste or scan an xpub first.');
      return;
    }
    if (!fingerprint || fingerprint.length !== 8) {
      setErr('Fingerprint must be 8 hex characters.');
      return;
    }
    if (!derivation_path) {
      setErr('Derivation path is required.');
      return;
    }
    const expectPrefix = network === 'bitcoin' ? /^[xyYz]pub/ : /^[tuUv]pub/;
    if (!expectPrefix.test(xpub)) {
      setErr(
        `This xpub doesn't look like a ${network} key.`,
      );
      return;
    }
    let pubkey: string;
    try {
      pubkey = pubkeyFromXpub(xpub);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not derive pubkey from xpub');
      return;
    }
    onChange({ xpub, fingerprint, derivation_path, pubkey });
  }

  if (showScanner) {
    return <QrScanner onResult={applyScan} onCancel={() => setShowScanner(false)} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowScanner(true)}>
          Scan QR
        </Button>
        {value && (
          <div style={{ fontSize: 12, color: colors.green, alignSelf: 'center' }}>
            Key ready to submit
          </div>
        )}
      </div>
      <div>
        <Label>xpub / tpub</Label>
        <Input
          mono
          value={raw}
          onChange={e => setRaw(e.target.value)}
          placeholder={network === 'bitcoin' ? 'xpub6...' : 'tpub...'}
        />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <Label>Master fingerprint (8 hex)</Label>
          <Input
            mono
            value={fp}
            onChange={e => setFp(e.target.value)}
            placeholder="deadbeef"
          />
        </div>
        <div style={{ flex: 2 }}>
          <Label>Derivation path</Label>
          <Input mono value={path} onChange={e => setPath(e.target.value)} />
        </div>
      </div>
      {err && <p style={{ color: colors.red, fontSize: 12, margin: 0 }}>{err}</p>}
      <Button type="button" variant="ghost" size="sm" onClick={commit}>
        Save key
      </Button>
    </div>
  );
}
