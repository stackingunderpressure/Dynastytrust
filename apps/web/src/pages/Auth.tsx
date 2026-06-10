import { useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input } from '../components/ui';

interface AuthProps {
  /**
   * Where the magic link should return the user. Without a redirect
   * Supabase routes the click to the site default, which loses any
   * deep-link context like an invite token. Pass the current URL here so
   * the link brings the user back where they started.
   */
  redirectTo?: string;
}

// Passwordless sign-in. signInWithOtp emails a magic link that both
// signs in existing users and creates new ones (shouldCreateUser is on
// by default), so there is a single email field -- no password, no
// separate sign-up, no reset flow. Clicking the link establishes the
// session via supabase-js's detectSessionInUrl on return.
export default function Auth({ redirectTo }: AuthProps = {}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const emailRedirectTo =
        redirectTo ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: emailRedirectTo ? { emailRedirectTo } : undefined,
      });
      if (error) throw error;
      setSent(true);
    } catch (err: unknown) {
      setError(friendlyAuthError(err instanceof Error ? err.message : 'Could not send link'));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={s.logo}>{APP_NAME}</div>
          <h2 style={s.heading}>Check your email</h2>
          <p style={s.sub}>
            We sent a sign-in link to{' '}
            <strong style={{ color: colors.gold }}>{email}</strong>. Open it on
            this device to continue. The link expires shortly, so use it soon.
          </p>
          <button
            style={s.link}
            onClick={() => { setSent(false); setError(null); }}
          >
            Use a different email
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

        <h2 style={s.heading}>Sign in</h2>
        <p style={s.sub}>
          Enter your email and we'll send a one-tap sign-in link. No password --
          if you're new, your account is created when you open the link.
        </p>

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
            {busy ? 'Sending…' : 'Send sign-in link'}
          </Button>
        </form>
      </div>
    </div>
  );
}

// Map Supabase's terse auth errors to friendlier copy.
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('rate') || m.includes('too many') || m.includes('seconds'))
    return 'Too many requests. Wait a minute before requesting another link.';
  if (m.includes('invalid') && m.includes('email'))
    return 'That email address does not look valid.';
  if (m.includes('signups not allowed') || m.includes('not allowed'))
    return 'Sign-ups are currently disabled for this instance.';
  return message;
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
