import { useEffect, useState, type ReactNode } from 'react';
import { supabase, type Session } from '../lib/supabase';
import { repairPubkeys } from '../lib/keystore';
import { consumeIntentionalSignOut } from '../lib/session-intent';
import {
  readTapitCallback,
  completeTapitCallback,
  clearTapitCallbackUrl,
} from '../lib/wallet-signin';
import { useToast } from './toast';
import Auth, { SetNewPassword } from '../pages/Auth';
import { LoadingScreen } from './LoadingScreen';
import { MfaChallenge } from './MfaChallenge';
import { getMfaState } from '../lib/mfa';

interface RequireAuthProps {
  children: (session: Session) => ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const toast = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Set when Supabase reports the user arrived via a password-reset link.
  // We then show the set-new-password screen instead of the app, so the
  // recovery session is used to actually change the password.
  const [recovering, setRecovering] = useState(false);
  // True while we redeem a Tapit wallet redirect into a session, so we show
  // the splash instead of flashing the login screen mid-handshake.
  const [processing, setProcessing] = useState(false);
  // 'checking' until we know whether this session still owes a second
  // step; { factorId } while it does. Re-evaluated whenever the signed-in
  // user changes. If the check itself fails we let the app render: the
  // server refuses every request from a session that owes the step
  // (netlify/functions/_auth.js), so this screen is the front door, not
  // the wall, and a transient error must not lock someone out of signing
  // out or retrying.
  const [mfa, setMfa] = useState<'checking' | 'ok' | { factorId: string }>('checking');
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (!userId) { setMfa('checking'); return; }
    let live = true;
    setMfa('checking');
    getMfaState()
      .then(st => {
        if (!live) return;
        setMfa(st.decision === 'challenge' && st.factorId ? { factorId: st.factorId } : 'ok');
      })
      .catch(() => { if (live) setMfa('ok'); });
    return () => { live = false; };
  }, [userId]);

  useEffect(() => {
    repairPubkeys();
    let active = true;

    async function boot() {
      // If the Tapit wallet just redirected back, finish the handshake before
      // deciding what to render.
      const cb = readTapitCallback();
      if (cb) {
        setProcessing(true);
        try {
          const result = await completeTapitCallback(cb);
          toast.success(
            result.mode === 'link'
              ? 'Tapit wallet linked.'
              : result.mode === 'signup'
                ? 'Your account is made. Your Tapit wallet is how you sign in.'
                : 'Signed in with your Tapit wallet.',
          );
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Tapit sign-in failed');
        } finally {
          clearTapitCallbackUrl();
          if (active) setProcessing(false);
        }
      }
      const { data } = await supabase.auth.getSession();
      if (active) {
        setSession(data.session);
        setLoading(false);
      }
    }
    void boot();

    let hadSession = false;
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, s) => {
        if (event === 'PASSWORD_RECOVERY') setRecovering(true);
        // A SIGNED_OUT we didn't trigger ourselves means the token
        // expired -- tell the user instead of silently dropping them.
        if (event === 'SIGNED_OUT' && hadSession && !consumeIntentionalSignOut()) {
          toast.error('Your session expired. Please sign in again.');
        }
        hadSession = s != null;
        setSession(s);
      },
    );
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [toast]);

  if (loading || processing) return <LoadingScreen />;
  if (recovering) return <SetNewPassword onDone={() => setRecovering(false)} />;
  if (!session) return <Auth />;
  // Two-step sign-in: an account with an authenticator set up renders
  // nothing of the app until this session has entered a current code.
  if (mfa === 'checking') return <LoadingScreen />;
  if (mfa !== 'ok') return <MfaChallenge factorId={mfa.factorId} onVerified={() => setMfa('ok')} />;
  return <>{children(session)}</>;
}
