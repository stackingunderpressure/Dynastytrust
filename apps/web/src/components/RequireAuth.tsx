import { useEffect, useState, type ReactNode } from 'react';
import { supabase, type Session } from '../lib/supabase';
import { repairPubkeys } from '../lib/keystore';
import Auth, { SetNewPassword } from '../pages/Auth';
import { LoadingScreen } from './LoadingScreen';

interface RequireAuthProps {
  children: (session: Session) => ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
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
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, s) => {
        if (event === 'PASSWORD_RECOVERY') setRecovering(true);
        setSession(s);
      },
    );
    return () => subscription.unsubscribe();
  }, []);

  if (loading) return <LoadingScreen />;
  if (recovering) return <SetNewPassword onDone={() => setRecovering(false)} />;
  if (!session) return <Auth />;
  return <>{children(session)}</>;
}
