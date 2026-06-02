import { useEffect, useState, type ReactNode } from 'react';
import { supabase, type Session } from '../lib/supabase';
import { repairPubkeys } from '../lib/keystore';
import { consumeIntentionalSignOut } from '../lib/session-intent';
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

  useEffect(() => {
    repairPubkeys();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
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
    return () => subscription.unsubscribe();
  }, [toast]);

  if (loading) return <LoadingScreen />;
  if (recovering) return <SetNewPassword onDone={() => setRecovering(false)} />;
  if (!session) return <Auth />;
  return <>{children(session)}</>;
}
