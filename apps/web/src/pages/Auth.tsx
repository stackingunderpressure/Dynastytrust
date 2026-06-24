import { useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input } from '../components/ui';
import { startTapitFlow } from '../lib/wallet-signin';

interface AuthProps {
  /**
   * If the user signs up, Supabase sends a confirmation email. Without
   * a redirect Supabase routes the click to the site default, which
   * loses any deep-link context like an invite token. Pass the current
   * URL here so the confirmation link brings the user back where they
   * started.
   */
  redirectTo?: string;
}

export default function Auth({ redirectTo }: AuthProps = {}) {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          ...(redirectTo ? { options: { emailRedirectTo: redirectTo } } : null),
        });
        if (error) throw error;
        setDone(true);
      } else if (mode === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
        });
        if (error) throw error;
        setResetSent(true);
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

  if (done) {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={s.logo}>{APP_NAME}</div>
          <h2 style={s.heading}>Check your email</h2>
          <p style={s.sub}>
            We sent a confirmation link to{' '}
            <strong style={{ color: colors.gold }}>{email}</strong>. Confirm your
            address then return here to sign in.
          </p>
          <button style={s.link} onClick={() => { setDone(false); setMode('login'); }}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  if (resetSent) {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={s.logo}>{APP_NAME}</div>
          <h2 style={s.heading}>Check your email</h2>
          <p style={s.sub}>
            If an account exists for{' '}
            <strong style={{ color: colors.gold }}>{email}</strong>, we sent a
            password reset link. Open it on this device to choose a new password.
          </p>
          <button style={s.link} onClick={() => { setResetSent(false); setMode('login'); }}>
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
          <p style={s.sub}>Enter your account email and we'll send a reset link.</p>
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
              {busy ? 'Working…' : 'Send reset link'}
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
    return 'Confirm your email first -- check your inbox for the confirmation link.';
  if (m.includes('rate') || m.includes('too many'))
    return 'Too many attempts. Wait a minute and try again.';
  return message;
}

// Shown by RequireAuth when Supabase reports a PASSWORD_RECOVERY session
// (the user clicked a reset link). Lets them set a new password in-app.
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
