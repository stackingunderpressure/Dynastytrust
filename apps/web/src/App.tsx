import { useEffect, useState } from 'react';
import { supabase, type Session } from './lib/supabase';
import Auth from './pages/Auth';
import Dashboard from './pages/Dashboard';
import VaultDetail from './pages/VaultDetail';
import type { Vault } from './lib/api';

type Page = { name: 'dashboard' } | { name: 'vault'; vault: Vault };

export default function App() {
  const [session, setSession]   = useState<Session | null>(null);
  const [loading, setLoading]   = useState(true);
  const [page, setPage]         = useState<Page>({ name: 'dashboard' });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#07070F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontFamily: '"Playfair Display", serif', fontSize: 20, letterSpacing: '0.12em', color: '#C9A84C' }}>
          DYNASTYTRUST
        </span>
      </div>
    );
  }

  if (!session) return <Auth />;

  if (page.name === 'vault') {
    return (
      <VaultDetail
        vault={page.vault}
        onBack={() => setPage({ name: 'dashboard' })}
      />
    );
  }

  return (
    <Dashboard
      onSelectVault={(vault) => setPage({ name: 'vault', vault })}
    />
  );
}
