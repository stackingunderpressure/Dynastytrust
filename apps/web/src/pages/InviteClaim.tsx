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
        <Auth />
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
  const [selectedKeyId, setSelectedKeyId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const keys = listKeys().filter(k => k.status === 'active' && k.network === vault.network);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const selected: LocalKey | undefined = keys.find(k => k.keyId === selectedKeyId);
      const res = await api.invites.claim({
        token,
        label: label.trim() || undefined,
        xpub: selected?.xpub,
        fingerprint: selected?.fingerprint,
        key_label: selected?.label,
      });
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
            <option value="">Claim slot now, add key later</option>
            {keys.map(k => (
              <option key={k.keyId} value={k.keyId}>
                [{k.persona}] {k.label} ({k.fingerprint})
              </option>
            ))}
          </select>
          {keys.length === 0 && (
            <div style={{ fontSize: 12, color: colors.muted, marginTop: 6 }}>
              No {vault.network} keys yet. You can claim the slot now and add a key from the Keys tab afterwards.
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
