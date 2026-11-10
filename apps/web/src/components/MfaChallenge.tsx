import { useState } from 'react';
import { verifyCode } from '../lib/mfa';
import { supabase } from '../lib/supabase';
import { markIntentionalSignOut } from '../lib/session-intent';
import { Button, Card, Field, Input } from './ui';
import { APP_NAME } from '../config';
import { colors, fonts, space } from '../theme';

/**
 * Second step of sign-in: shown by RequireAuth when the account has an
 * authenticator set up and this session has only proven the password.
 * Nothing behind it renders until a current 6-digit code verifies.
 */
export function MfaChallenge({ factorId, onVerified }: { factorId: string; onVerified: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await verifyCode(factorId, code);
      onVerified();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    markIntentionalSignOut();
    await supabase.auth.signOut();
  }

  return (
    <div style={{ minHeight: '100vh', background: colors.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: space[6] }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ fontFamily: fonts.mono, color: colors.gold, letterSpacing: 2, fontSize: 13, marginBottom: space[4], textAlign: 'center' }}>
          {APP_NAME}
        </div>
        <Card>
          <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 6 }}>Two-step sign-in</div>
          <p style={{ fontSize: 13, color: colors.muted, lineHeight: 1.5, marginBottom: space[4] }}>
            Your password was right. Now enter the 6-digit code from your authenticator app.
          </p>
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Code">
              <Input
                mono
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="123456"
              />
            </Field>
            {err && <div style={{ fontSize: 13, color: colors.red }}>{err}</div>}
            <Button variant="primary" type="submit" disabled={busy || code.trim().length < 6}>
              {busy ? 'Checking...' : 'Continue'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => void signOut()}>
              Sign out
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
