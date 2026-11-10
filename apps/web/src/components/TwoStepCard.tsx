import { useEffect, useState } from 'react';
import { getMfaState, startEnrollment, verifyCode, removeAuthenticator, type Enrollment } from '../lib/mfa';
import { QrImage } from './QrImage';
import { Button, Card, Field, Input } from './ui';
import { useToast } from './toast';
import { useConfirm } from './dialog';
import { colors, fonts, radii, space } from '../theme';

/**
 * Two-step sign-in setup. Off by default; once on, signing in needs the
 * password AND a 6-digit code from an authenticator app, and the server
 * refuses every request from a session that has not done both.
 *
 * Plain words on purpose: this protects what the account can SEE
 * (vaults, balances, members, requests). It was never able to move
 * coins -- only keys can -- and it is not a substitute for them.
 */
export function TwoStepCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [factorId, setFactorId] = useState<string | null | undefined>(undefined);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function refresh() {
    void getMfaState()
      .then(s => setFactorId(s.factorId))
      .catch(() => setFactorId(null));
  }
  useEffect(refresh, []);

  async function begin() {
    setBusy(true);
    setErr(null);
    try {
      setEnrollment(await startEnrollment());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start setup');
    } finally {
      setBusy(false);
    }
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    if (!enrollment) return;
    setBusy(true);
    setErr(null);
    try {
      await verifyCode(enrollment.factorId, code);
      setEnrollment(null);
      setCode('');
      toast.success('Two-step sign-in is on.');
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (!factorId) return;
    const ok = await confirm({
      title: 'Turn off two-step sign-in?',
      message: 'After this, your password alone will open this account again.',
      confirmLabel: 'Turn off',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removeAuthenticator(factorId);
      toast.success('Two-step sign-in is off.');
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const on = !!factorId;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? colors.green : colors.gold }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>Two-step sign-in</span>
        <span style={{ fontSize: 12, color: on ? colors.green : colors.muted, marginLeft: 'auto' }}>
          {factorId === undefined ? '' : on ? 'On' : 'Off'}
        </span>
      </div>
      <p style={{ fontSize: 13, color: colors.muted, lineHeight: 1.5, marginBottom: space[4] }}>
        {on
          ? 'Signing in needs your password and a code from your authenticator app. This guards what your account can see. Your coins are guarded by your keys, not by this.'
          : 'Add a second step so a stolen password is not enough to see your vaults, balances and family members. Uses any authenticator app. Your coins are guarded by your keys either way.'}
      </p>

      {!on && !enrollment && factorId !== undefined && (
        <Button variant="primary" disabled={busy} onClick={() => void begin()}>
          {busy ? 'Starting...' : 'Turn on two-step sign-in'}
        </Button>
      )}

      {enrollment && (
        <form onSubmit={finish} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: colors.text }}>
            1. Scan this with your authenticator app.
          </div>
          <div style={{ alignSelf: 'center' }}>
            <QrImage data={enrollment.uri} size={220} />
          </div>
          <div style={{ fontSize: 12, color: colors.muted }}>
            Cannot scan? Type this key into the app instead:
          </div>
          <div style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.text, background: colors.inset, borderRadius: radii.md, padding: '8px 10px', wordBreak: 'break-all' }}>
            {enrollment.secret}
          </div>
          <Field label="2. Enter the 6-digit code it shows">
            <Input mono inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={e => setCode(e.target.value)} placeholder="123456" />
          </Field>
          {err && <div style={{ fontSize: 13, color: colors.red }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" type="submit" disabled={busy || code.trim().length < 6}>
              {busy ? 'Checking...' : 'Confirm and turn on'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => { setEnrollment(null); setCode(''); setErr(null); }}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {!enrollment && err && <div style={{ fontSize: 13, color: colors.red, marginTop: 8 }}>{err}</div>}

      {on && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void turnOff()}>
          Turn off
        </Button>
      )}
    </Card>
  );
}
