import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../config';

export default function Auth() {
  const [mode, setMode]       = useState<'login' | 'signup'>('login');
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [done, setDone]       = useState(false);

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
        // App.tsx listener will handle redirect
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
            We sent a confirmation link to <strong style={{ color: '#C9A84C' }}>{email}</strong>.
            Confirm your address then return here to sign in.
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
          <button style={{ ...s.tab, ...(mode === 'login'  ? s.tabActive : {}) }} onClick={() => setMode('login')}>Sign in</button>
          <button style={{ ...s.tab, ...(mode === 'signup' ? s.tabActive : {}) }} onClick={() => setMode('signup')}>Create account</button>
        </div>

        <form onSubmit={submit} style={s.form}>
          <label style={s.label}>Email</label>
          <input
            style={s.input}
            type="email"
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            placeholder="you@example.com"
          />

          <label style={s.label}>Password</label>
          <input
            style={s.input}
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={8}
            placeholder="••••••••"
          />

          {error && <p style={s.error}>{error}</p>}

          <button style={{ ...s.btn, opacity: busy ? 0.6 : 1 }} type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#07070F',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    fontFamily: '"DM Sans", sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    background: '#0F0F1A',
    border: '1px solid #1E1E30',
    borderRadius: 16,
    padding: '48px 40px',
  },
  logo: {
    fontFamily: '"Playfair Display", serif',
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: '0.12em',
    color: '#C9A84C',
    marginBottom: 8,
  },
  tagline: {
    fontSize: 13,
    color: '#5A5570',
    marginBottom: 36,
    lineHeight: 1.5,
  },
  heading: {
    fontSize: 22,
    fontWeight: 600,
    color: '#E8E4D8',
    marginBottom: 12,
  },
  sub: {
    fontSize: 14,
    color: '#9994A8',
    lineHeight: 1.6,
    marginBottom: 24,
  },
  tabs: {
    display: 'flex',
    gap: 4,
    background: '#161622',
    borderRadius: 10,
    padding: 4,
    marginBottom: 28,
  },
  tab: {
    flex: 1,
    padding: '8px 0',
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    color: '#5A5570',
    fontSize: 14,
    fontFamily: '"DM Sans", sans-serif',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  tabActive: {
    background: '#1E1E30',
    color: '#E8E4D8',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: '0.06em',
    color: '#9994A8',
    textTransform: 'uppercase' as const,
    marginTop: 8,
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    background: '#161622',
    border: '1px solid #1E1E30',
    borderRadius: 8,
    color: '#E8E4D8',
    fontSize: 15,
    fontFamily: '"DM Sans", sans-serif',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  error: {
    fontSize: 13,
    color: '#E05C5C',
    margin: '4px 0',
  },
  btn: {
    marginTop: 16,
    padding: '14px',
    background: '#C9A84C',
    border: 'none',
    borderRadius: 8,
    color: '#07070F',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: '"DM Sans", sans-serif',
    cursor: 'pointer',
    letterSpacing: '0.04em',
    transition: 'opacity 0.15s',
  },
  link: {
    background: 'none',
    border: 'none',
    color: '#C9A84C',
    fontSize: 14,
    cursor: 'pointer',
    padding: 0,
    fontFamily: '"DM Sans", sans-serif',
  },
};
