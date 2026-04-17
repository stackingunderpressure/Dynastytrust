import { useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input } from '../components/ui';

export default function Auth() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setDone(true);
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
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
