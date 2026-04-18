import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase, type Session } from '../lib/supabase';
import { api } from '../lib/api';
import { listKeys, type LocalKey } from '../lib/keystore';
import { APP_NAME } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input, Label } from '../components/ui';
import { LoadingScreen } from '../components/LoadingScreen';
import { useToast } from '../components/toast';
import { QrScanner } from '../components/QrScanner';
import { pubkeyFromXpub } from '../lib/xpub';
import Auth from './Auth';

interface InviteInfo {
  id: string;
  vault_id: string;
  invited_role: 'founder' | 'heir' | 'viewer';
  invited_label: string | null;
  expires_at: string;
}

interface VaultInfo {
  id: string;
  name: string;
  network: 'testnet' | 'bitcoin';
}

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
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load invite'))
      .finally(() => setLoading(false));
  }, [token]);

  if (sessionLoading || loading) return <LoadingScreen />;

  if (error) return <CenteredCard><ErrorBody message={error} /></CenteredCard>;
  if (!invite || !vault) return <CenteredCard><ErrorBody message="Invite not found" /></CenteredCard>;

  // Not signed in: show Auth inline with a banner explaining why.
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
        <Auth redirectTo={typeof window !== 'undefined' ? window.location.href : undefined} />
      </div>
    );
  }

  // Signed in: show the claim form.
  return (
    <CenteredCard>
      <ClaimForm token={token!} invite={invite} vault={vault} />
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
}: {
  token: string;
  invite: InviteInfo;
  vault: VaultInfo;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [label, setLabel] = useState(invite.invited_label ?? '');
  const [mode, setMode] = useState<'hardware' | 'browser' | 'skip'>('hardware');
  const [selectedKeyId, setSelectedKeyId] = useState<string>('');
  const [hwKey, setHwKey] = useState<HwKeyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const keys = listKeys().filter(k => k.status === 'active' && k.network === vault.network);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      let payload: Parameters<typeof api.invites.claim>[0] = {
        token,
        label: label.trim() || undefined,
      };

      if (invite.invited_role !== 'viewer') {
        if (mode === 'browser') {
          const selected: LocalKey | undefined = keys.find(k => k.keyId === selectedKeyId);
          if (!selected) {
            setErr('Pick a local key or switch to hardware wallet / skip.');
            setBusy(false);
            return;
          }
          payload = {
            ...payload,
            xpub: selected.xpub,
            fingerprint: selected.masterFingerprint ?? selected.fingerprint,
            pubkey: selected.pubkey,
            derivation_path: selected.derivationPath,
            key_label: selected.label,
          };
        } else if (mode === 'hardware') {
          if (!hwKey) {
            setErr('Scan or paste your xpub first, or switch to Skip for now.');
            setBusy(false);
            return;
          }
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
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color: colors.gold,
          marginBottom: 4,
        }}
      >
        {APP_NAME}
      </div>
      <div style={{ fontSize: 15, color: colors.text, marginBottom: 4 }}>
        Claim your spot on <strong>{vault.name}</strong>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 14 }}>
        Role: {invite.invited_role} / Network: {vault.network.toUpperCase()}
      </div>

      <div>
        <Label>Display name (optional)</Label>
        <Input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder={invite.invited_label ?? 'e.g. Dad, Sister, Lawyer'}
        />
      </div>

      {invite.invited_role !== 'viewer' && (
        <div>
          <Label>Signing key</Label>
          <div
            style={{
              display: 'flex',
              gap: 4,
              background: colors.input,
              borderRadius: radii.md,
              padding: 4,
              marginBottom: 10,
            }}
          >
            {(['hardware', 'browser', 'skip'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  flex: 1,
                  padding: '7px 0',
                  border: 'none',
                  borderRadius: radii.sm,
                  background: mode === m ? colors.border : 'transparent',
                  color: mode === m ? colors.text : colors.muted,
                  fontSize: 12,
                  fontFamily: fonts.sans,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {m === 'hardware' ? 'Hardware wallet' : m === 'browser' ? 'Browser key' : 'Skip'}
              </button>
            ))}
          </div>

          {mode === 'hardware' && (
            <HardwareKeyInput
              network={vault.network}
              value={hwKey}
              onChange={setHwKey}
            />
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
                <div style={{ fontSize: 12, color: colors.muted, marginTop: 6 }}>
                  No {vault.network} keys in this browser. Generate one on the Keys tab or switch to the hardware wallet flow.
                </div>
              )}
              <div style={{ fontSize: 11, color: colors.orange, marginTop: 8 }}>
                Browser keys are for testing only. Use a hardware wallet for real funds.
              </div>
            </>
          )}

          {mode === 'skip' && (
            <div style={{ fontSize: 13, color: colors.muted, lineHeight: 1.5 }}>
              Claim the slot now. You can add your xpub later from the vault's Members tab before the vault is compiled.
            </div>
          )}
        </div>
      )}

      {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}

      <Button type="submit" disabled={busy}>
        {busy ? 'Claiming...' : 'Claim invite'}
      </Button>
    </form>
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

function HardwareKeyInput({
  network,
  value,
  onChange,
}: {
  network: 'testnet' | 'bitcoin';
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
