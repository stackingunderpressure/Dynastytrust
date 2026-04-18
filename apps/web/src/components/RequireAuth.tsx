import { useEffect, useState, type ReactNode } from 'react';
import { supabase, type Session } from '../lib/supabase';
import { repairPubkeys } from '../lib/keystore';
import Auth from '../pages/Auth';
import { LoadingScreen } from './LoadingScreen';

interface RequireAuthProps {
  children: (session: Session) => ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    repairPubkeys();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, s) => setSession(s),
    );
    return () => subscription.unsubscribe();
  }, []);

  if (loading) return <LoadingScreen />;
  if (!session) return <Auth />;
  return <>{children(session)}</>;
}
