import { useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input } from '../components/ui';
import { startTapitFlow } from '../lib/wallet-signin';

// Set once we've asked Supabase to email a 6-digit code -- 'signup' for
// account confirmation, 'recovery' for password reset. Identifies which
// verifyOtp type to call once the code comes back. No magic links
// anywhere: every code-bearing email uses Supabase's {{ .Token }}
// variable only (operator, 2026-08-17: "6 digit on all sides no links").
type Pending = 'signup' | 'recovery' | null;

export default function Auth() {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending>(null);
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setPending('signup');
      } else if (mode === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(email);
        if (error) throw error;
        setPending('recovery');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err: unknown) {
      setError(friendlyAuthError(err instanceof Error ? err.message : 'Authentication failed'));
    } finally {
      setBusy(false);
    }
  }

  // Verifying a 'signup' code establishes a normal session; verifying a
  // 'recovery' code fires Supabase's PASSWORD_RECOVERY auth event, which
  // RequireAuth already listens for and swaps in SetNewPassword. Either
  // way this screen doesn't need to do anything else on success -- the
  // session-change listener upstream takes it from here.
  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setCodeBusy(true);
    setCodeError(null);
    try {
      const { error } = await supabase.auth.verifyOtp({ email, token: code, type: pending });
      if (error) throw error;
    } catch (err: unknown) {
      setCodeError(friendlyAuthError(err instanceof Error ? err.message : 'Invalid code'));
    } finally {
      setCodeBusy(false);
    }
  }

  async function resendCode() {
    setCodeBusy(true);
    setCodeError(null);
    setResent(false);
    try {
      const { error } =
        pending === 'signup'
          ? await supabase.auth.resend({ type: 'signup', email })
          : await supabase.auth.resetPasswordForEmail(email);
      if (error) throw error;
      setResent(true);
    } catch (err: unknown) {
      setCodeError(friendlyAuthError(err instanceof Error ? err.message : 'Could not resend code'));
    } finally {
      setCodeBusy(false);
    }
  }

  function backToSignIn() {
    setPending(null);
    setCode('');
    setCodeError(null);
    setResent(false);
    setMode('login');
  }

  // Sign in by proving control of a linked Tapit wallet key. On success this
  // navigates to the wallet, so we only clear busy on failure.
  async function tapit() {
    setBusy(true);
    setError(null);
    try {
      await startTapitFlow('signin');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start Tapit sign-in');
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={s.logo}>{APP_NAME}</div>
          <h2 style={s.heading}>
            {pending === 'signup' ? 'Confirm your email' : 'Enter your reset code'}
          </h2>
          <p style={s.sub}>
            We sent a 6-digit code to{' '}
            <strong style={{ color: colors.gold }}>{email}</strong>. Enter it below
            {pending === 'recovery' ? ' to choose a new password.' : ' to finish creating your account.'}
          </p>
          <form onSubmit={verifyCode} style={s.form}>
            <label style={s.label} htmlFor="auth-code">Code</label>
            <Input
              id="auth-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
              required
              minLength={6}
              maxLength={6}
              placeholder="000000"
              style={{ fontSize: 20, padding: '12px 14px', letterSpacing: '0.3em', textAlign: 'center' }}
            />
            {codeError && <p style={s.error}>{codeError}</p>}
            {resent && !codeError && <p style={s.resent}>New code sent.</p>}
            <Button
              type="submit"
              disabled={codeBusy || code.length !== 6}
              style={{ marginTop: space[4], padding: '14px', fontSize: 15, letterSpacing: '0.04em' }}
            >
              {codeBusy ? 'Working…' : 'Verify code'}
            </Button>
          </form>
          <button
            style={{ ...s.link, marginTop: space[4] }}
            disabled={codeBusy}
            onClick={() => void resendCode()}
          >
            Resend code
          </button>
          <button style={{ ...s.link, marginTop: space[2], fontSize: 13 }} onClick={backToSignIn}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'reset') {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={s.logo}>{APP_NAME}</div>
          <h2 style={s.heading}>Reset password</h2>
          <p style={s.sub}>Enter your account email and we'll send a 6-digit code.</p>
          <form onSubmit={submit} style={s.form}>
            <label style={s.label} htmlFor="auth-email">Email</label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              style={{ fontSize: 15, padding: '12px 14px' }}
            />
            {error && <p style={s.error}>{error}</p>}
            <Button
              type="submit"
              disabled={busy}
              style={{ marginTop: space[4], padding: '14px', fontSize: 15, letterSpacing: '0.04em' }}
            >
              {busy ? 'Working…' : 'Send code'}
            </Button>
          </form>
          <button style={{ ...s.link, marginTop: space[4] }} onClick={() => { setMode('login'); setError(null); }}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.logo}>{APP_NAME}</div>
        <p style={s.tagline}>Bitcoin vault infrastructure for multi-generational wealth</p>

        <div style={s.tabs}>
          <button
            style={{ ...s.tab, ...(mode === 'login' ? s.tabActive : null) }}
            onClick={() => setMode('login')}
          >
            Sign in
          </button>
          <button
            style={{ ...s.tab, ...(mode === 'signup' ? s.tabActive : null) }}
            onClick={() => setMode('signup')}
          >
            Create account
          </button>
        </div>

        <form onSubmit={submit} style={s.form}>
          <label style={s.label} htmlFor="auth-email">Email</label>
          <Input
            id="auth-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            placeholder="you@example.com"
            style={{ fontSize: 15, padding: '12px 14px' }}
          />

          <label style={s.label} htmlFor="auth-password">Password</label>
          <Input
            id="auth-password"
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={8}
            placeholder="••••••••"
            style={{ fontSize: 15, padding: '12px 14px' }}
          />

          {error && <p style={s.error}>{error}</p>}

          <Button
            type="submit"
            disabled={busy}
            style={{ marginTop: space[4], padding: '14px', fontSize: 15, letterSpacing: '0.04em' }}
          >
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        {mode === 'login' && (
          <>
            <div style={s.orRow}>
              <span style={s.orLine} />
              <span style={s.orText}>or</span>
              <span style={s.orLine} />
            </div>
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => void tapit()}
              style={{ width: '100%', padding: '14px', fontSize: 15 }}
            >
              Sign in with Tapit
            </Button>
            <p style={s.tapitHint}>
              Prove control of a wallet key you've linked. New here? Sign in with
              email first, then link your wallet.
            </p>
          </>
        )}

        {mode === 'login' && (
          <button
            style={{ ...s.link, marginTop: space[4], fontSize: 13 }}
            onClick={() => { setMode('reset'); setError(null); }}
          >
            Forgot password?
          </button>
        )}
      </div>
    </div>
  );
}

// Map Supabase's terse auth errors to friendlier copy.
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid credentials'))
    return 'Email or password is incorrect.';
  if (m.includes('already registered') || m.includes('already exists'))
    return 'An account with this email already exists. Try signing in instead.';
  if (m.includes('email not confirmed'))
    return 'Confirm your email first -- check your inbox for the 6-digit code.';
  if (m.includes('token has expired') || m.includes('otp_expired'))
    return 'That code has expired. Request a new one.';
  if (m.includes('invalid') && (m.includes('token') || m.includes('otp')))
    return 'That code is incorrect. Check it and try again.';
  if (m.includes('rate') || m.includes('too many'))
    return 'Too many attempts. Wait a minute and try again.';
  return message;
}

// Shown by RequireAuth when Supabase reports a PASSWORD_RECOVERY session
// (the user verified their reset code above). Lets them set a new
// password in-app.
export function SetNewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      onDone();
    } catch (err: unknown) {
      setError(friendlyAuthError(err instanceof Error ? err.message : 'Could not update password'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.logo}>{APP_NAME}</div>
        <h2 style={s.heading}>Choose a new password</h2>
        <p style={s.sub}>Enter a new password for your account.</p>
        <form onSubmit={submit} style={s.form}>
          <label style={s.label} htmlFor="new-password">New password</label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={8}
            placeholder="••••••••"
            style={{ fontSize: 15, padding: '12px 14px' }}
          />
          <label style={s.label} htmlFor="confirm-password">Confirm password</label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
            minLength={8}
            placeholder="••••••••"
            style={{ fontSize: 15, padding: '12px 14px' }}
          />
          {error && <p style={s.error}>{error}</p>}
          <Button
            type="submit"
            disabled={busy}
            style={{ marginTop: space[4], padding: '14px', fontSize: 15, letterSpacing: '0.04em' }}
          >
            {busy ? 'Working…' : 'Update password'}
          </Button>
        </form>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[6],
    fontFamily: fonts.sans,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 16,
    padding: '48px 40px',
  },
  logo: {
    fontFamily: fonts.display,
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: '0.12em',
    color: colors.gold,
    marginBottom: space[2],
  },
  tagline: {
    fontSize: 13,
    color: colors.muted,
    marginBottom: 36,
    lineHeight: 1.5,
  },
  heading: {
    fontSize: 22,
    fontWeight: 600,
    color: colors.text,
    marginBottom: space[3],
  },
  sub: {
    fontSize: 14,
    color: colors.sub,
    lineHeight: 1.6,
    marginBottom: space[6],
  },
  tabs: {
    display: 'flex',
    gap: 4,
    background: colors.input,
    borderRadius: 10,
    padding: 4,
    marginBottom: 28,
  },
  orRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    margin: `${space[5]}px 0 ${space[4]}px`,
  },
  orLine: {
    flex: 1,
    height: 1,
    background: colors.border,
  },
  orText: {
    fontSize: 12,
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  tapitHint: {
    fontSize: 12,
    color: colors.muted,
    lineHeight: 1.5,
    marginTop: space[3],
  },
  tab: {
    flex: 1,
    padding: '8px 0',
    border: 'none',
    borderRadius: radii.md,
    background: 'transparent',
    color: colors.muted,
    fontSize: 14,
    fontFamily: fonts.sans,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  tabActive: {
    background: colors.border,
    color: colors.text,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: '0.06em',
    color: colors.sub,
    textTransform: 'uppercase',
    marginTop: space[2],
  },
  error: {
    fontSize: 13,
    color: colors.red,
    margin: '4px 0',
  },
  resent: {
    fontSize: 13,
    color: colors.gold,
    margin: '4px 0',
  },
  link: {
    background: 'none',
    border: 'none',
    color: colors.gold,
    fontSize: 14,
    cursor: 'pointer',
    padding: 0,
    fontFamily: fonts.sans,
  },
};
