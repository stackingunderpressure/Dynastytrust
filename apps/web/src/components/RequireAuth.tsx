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

  useEffect(() => {
    repairPubkeys();
    let active = true;

    async function boot() {
      // If the Tapit wallet just redirected back, finish the handshake
      // before deciding what to render. Red is guidance only -- the sign-in
      // still succeeds; we surface the sweep instead of blocking.
      const cb = readTapitCallback();
      if (cb) {
        setProcessing(true);
        try {
          const result = await completeTapitCallback(cb);
          if (result.mode === 'link') {
            toast.success('Tapit wallet linked.');
          } else if (result.red) {
            toast.error(
              'Signed in. Your group flagged this wallet -- start the sweep to a clean wallet.' +
                (result.redReason ? ` (${result.redReason})` : ''),
            );
          } else {
            toast.success('Signed in with your Tapit wallet.');
          }
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
  return <>{children(session)}</>;
}
