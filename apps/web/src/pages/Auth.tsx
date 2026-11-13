import { useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input } from '../components/ui';
import { startTapitFlow, rememberSignupName, WALLET_BASE_URL } from '../lib/wallet-signin';
import { friendlyAuthError } from '../lib/auth-errors';
import { signInAddress, usernameProblem, normalizeUsername } from '../lib/username';
import { passwordProblem } from '../lib/password-rules';
import { offerFaceIdFor, declineFaceIdOffer, savedFaceIdSignIn, signInWithFaceId } from '../lib/faceid-signin';

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
  // Sovereign sign-in with Tapit: creating an account asks only a name.
  const [tapitCreate, setTapitCreate] = useState(false);
  const [tapitName, setTapitName] = useState('');
  // Create account: with an email (can be reset) or a username (no email,
  // no reset). Operator, 2026-11-13: "user name password ... or email for
  // future proof of getting locked out".
  const [withUsername, setWithUsername] = useState(false);
  const faceSaved = savedFaceIdSignIn();
  async function faceId() {
    setBusy(true);
    setError(null);
    try { await signInWithFaceId(); } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Face ID sign-in did not work'); } finally { setBusy(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (mode === 'signup' && withUsername) {
        const bad = usernameProblem(email) ?? passwordProblem(password, 'mainnet');
        if (bad) { setError(bad); return; }
        const res = await fetch('/api/username-signup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: normalizeUsername(email), password }),
        });
        const out = await res.json().catch(() => ({})) as { error?: string };
        if (!res.ok) { setError(out.error ?? 'Could not create the account'); return; }
        // Staged BEFORE signing in: the signed-in screen can mount the
        // instant Supabase reports the session, before this call returns.
        offerFaceIdFor(signInAddress(email), normalizeUsername(email), password);
        const { error } = await supabase.auth.signInWithPassword({ email: signInAddress(email), password });
        if (error) { declineFaceIdOffer(); throw error; }
      } else if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setPending('signup');
      } else if (mode === 'reset') {
        if (!email.includes('@')) {
          setError('A username account has no email, so its password cannot be reset. If you turned on Face ID for it on this phone, sign in with Face ID.');
          return;
        }
        const { error } = await supabase.auth.resetPasswordForEmail(email);
        if (error) throw error;
        setPending('recovery');
      } else {
        // Face ID right after (operator's chip): offered once, on the next
        // screen. Staged before signing in for the same reason as above.
        offerFaceIdFor(signInAddress(email), email.trim(), password);
        const { error } = await supabase.auth.signInWithPassword({ email: signInAddress(email), password });
        if (error) { declineFaceIdOffer(); throw error; }
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
  async function tapit(kind: 'signin' | 'signup' = 'signin') {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'signup') rememberSignupName(tapitName);
      await startTapitFlow(kind);
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
              style={{ marginTop: space[4], padding: '14px', fontSize: 17, letterSpacing: '0.04em' }}
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
          <button style={{ ...s.link, marginTop: space[2], fontSize: 17 }} onClick={backToSignIn}>
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
          <p style={s.sub}>Enter your account email and we'll send a 6-digit code. A username account has no email, so it cannot be reset.</p>
          <form onSubmit={submit} style={s.form}>
            <label style={s.label} htmlFor="auth-email">Email</label>
            <Input
              id="auth-email"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              style={{ fontSize: 17, padding: '12px 14px' }}
            />
            {error && <p style={s.error}>{error}</p>}
            <Button
              type="submit"
              disabled={busy}
              style={{ marginTop: space[4], padding: '14px', fontSize: 17, letterSpacing: '0.04em' }}
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

        {mode === 'login' && faceSaved && (
          <div style={{ marginBottom: space[4] }}>
            <Button type="button" disabled={busy} onClick={() => void faceId()} style={{ width: '100%', padding: '14px', fontSize: 17 }}>
              {busy ? 'Waiting for Face ID...' : `Sign in with Face ID (${faceSaved.label})`}
            </Button>
          </div>
        )}
        <form onSubmit={submit} style={s.form}>
          {mode === 'signup' && (
            <div style={{ ...s.tabs, marginBottom: space[2] }}>
              <button type="button" style={{ ...s.tab, ...(!withUsername ? s.tabActive : null) }} onClick={() => { setWithUsername(false); setError(null); }}>
                With email
              </button>
              <button type="button" style={{ ...s.tab, ...(withUsername ? s.tabActive : null) }} onClick={() => { setWithUsername(true); setError(null); }}>
                Username, no email
              </button>
            </div>
          )}
          {mode === 'signup' && (
            <p style={{ ...s.tapitHint, margin: 0, color: withUsername ? colors.orange : colors.sub }}>
              {withUsername
                ? 'No email means no reset. If you forget this password the account is gone for good (money in a vault stays safe with its own keys, and you would be invited back). Turn on Face ID after, and keep the password written down somewhere safe.'
                : 'Recommended: if you are ever locked out, a code to this email gets you back in. We send nothing else.'}
            </p>
          )}
          <label style={s.label} htmlFor="auth-email">{mode === 'login' ? 'Email or username' : withUsername && mode === 'signup' ? 'Username' : 'Email'}</label>
          <Input
            id="auth-email"
            type={mode === 'signup' && !withUsername ? 'email' : 'text'}
            autoComplete={mode === 'signup' && withUsername ? 'username' : 'email'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            placeholder={mode === 'login' ? 'Email or username' : mode === 'signup' && withUsername ? 'e.g. grandpa.joe' : 'you@example.com'}
            style={{ fontSize: 17, padding: '12px 14px' }}
          />

          <label style={s.label} htmlFor="auth-password">Password</label>
          <Input
            id="auth-password"
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={mode === 'signup' && withUsername ? 12 : 8}
            placeholder="••••••••"
            style={{ fontSize: 17, padding: '12px 14px' }}
          />

          {error && <p style={s.error}>{error}</p>}

          <Button
            type="submit"
            disabled={busy}
            style={{ marginTop: space[4], padding: '14px', fontSize: 17, letterSpacing: '0.04em' }}
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
            {/* Sovereign sign-in (operator, 2026-11-13: "the most sovereign way
                is run your own Tapit wallet, sign in through it, not email,
                not enter your words in ... good warnings and education"). */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[2], padding: space[3], border: `1px solid ${colors.gold}55`, borderRadius: radii.md }}>
              <p style={{ ...s.tapitHint, color: colors.text, fontWeight: 600, margin: 0 }}>Sovereign sign-in with Tapit</p>
              <p style={{ ...s.tapitHint, margin: 0 }}>
                No email and no password here. Your own Tapit wallet proves it is you; its key never leaves the wallet,
                and nobody, not even DynastyTrust, can sign in as you without it.
              </p>
              <Button
                type="button"
                disabled={busy}
                onClick={() => void tapit('signin')}
                style={{ width: '100%', padding: '14px', fontSize: 17 }}
              >
                Sign in with Tapit
              </Button>
              {!tapitCreate ? (
                <Button variant="ghost" type="button" disabled={busy} onClick={() => setTapitCreate(true)} style={{ width: '100%', padding: '14px', fontSize: 17 }}>
                  Create an account with Tapit
                </Button>
              ) : (
                <form onSubmit={e => { e.preventDefault(); void tapit('signup'); }} style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
                  <label style={s.label} htmlFor="tapit-name">Your name</label>
                  <Input id="tapit-name" value={tapitName} onChange={e => setTapitName(e.target.value)} placeholder="What the family calls you" maxLength={40} required />
                  <Button type="submit" disabled={busy || !tapitName.trim()} style={{ width: '100%', padding: '14px', fontSize: 17 }}>
                    {busy ? 'Opening Tapit...' : 'Continue in Tapit'}
                  </Button>
                </form>
              )}
              <p style={{ ...s.tapitHint, margin: 0, color: colors.orange }}>
                Know this before you choose it: with Tapit there is no email to reset anything. Your Tapit wallet and its
                backup ARE your account. Lose both and the account is gone for good (money in a vault stays safe with its
                own keys, and you would be invited back). Keep Tapit's backup somewhere safe, off this phone.
              </p>
              <a href={WALLET_BASE_URL} target="_blank" rel="noopener noreferrer" style={{ ...s.tapitHint, margin: 0, color: colors.gold }}>
                No Tapit wallet yet? Get it here.
              </a>
            </div>
          </>
        )}

        {mode === 'login' && (
          <button
            style={{ ...s.link, marginTop: space[4], fontSize: 17 }}
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
            style={{ fontSize: 17, padding: '12px 14px' }}
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
            style={{ fontSize: 17, padding: '12px 14px' }}
          />
          {error && <p style={s.error}>{error}</p>}
          <Button
            type="submit"
            disabled={busy}
            style={{ marginTop: space[4], padding: '14px', fontSize: 17, letterSpacing: '0.04em' }}
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
    fontSize: 17,
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
    fontSize: 17,
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
    fontSize: 16,
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  tapitHint: {
    fontSize: 16,
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
    fontSize: 17,
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
    fontSize: 16,
    fontWeight: 500,
    letterSpacing: '0.06em',
    color: colors.sub,
    textTransform: 'uppercase',
    marginTop: space[2],
  },
  error: {
    fontSize: 17,
    color: colors.red,
    margin: '4px 0',
  },
  resent: {
    fontSize: 17,
    color: colors.gold,
    margin: '4px 0',
  },
  link: {
    background: 'none',
    border: 'none',
    color: colors.gold,
    fontSize: 17,
    cursor: 'pointer',
    padding: 0,
    fontFamily: fonts.sans,
  },
};
