import { useEffect, useState } from 'react';
import { supabase, type Session } from './lib/supabase';
import Auth from './pages/Auth';
import { repairPubkeys } from './lib/keystore';
import KeyManager from './pages/KeyManager';
import PolicyBuilder from './pages/PolicyBuilder';
import Dashboard from './pages/Dashboard';
import VaultDetail from './pages/VaultDetail';
import type { Vault } from './lib/api';
import { NAV_LINKS } from './config';
import { Layout } from './components/Layout';
import { PageHeader } from './components/PageHeader';
import { LoadingScreen } from './components/LoadingScreen';

type Tab = typeof NAV_LINKS[number]['id'];
type Page = { name: 'app'; tab: Tab } | { name: 'vault'; vault: Vault };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>({ name: 'app', tab: 'keys' });

  useEffect(() => {
    repairPubkeys();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  if (loading) return <LoadingScreen />;
  if (!session) return <Auth />;

  if (page.name === 'vault') {
    return (
      <VaultDetail
        vault={page.vault}
        onBack={() => setPage({ name: 'app', tab: 'vaults' })}
      />
    );
  }

  return (
    <Layout
      activeNavId={page.tab}
      onNavigate={id => setPage({ name: 'app', tab: id as Tab })}
      onSignOut={() => supabase.auth.signOut()}
    >
      {page.tab === 'keys' && (
        <>
          <PageHeader
            title="Key Manager"
            sub="Generate software keys and import hardware xpubs. Private keys never leave this browser."
          />
          <KeyManager />
        </>
      )}
      {page.tab === 'policy' && (
        <>
          <PageHeader
            title="Policy Builder"
            sub="Assemble keys into a vault policy and compile to a Bitcoin address via Fly.io."
          />
          <PolicyBuilder onVaultCreated={vault => setPage({ name: 'vault', vault })} />
        </>
      )}
      {page.tab === 'vaults' && (
        <>
          <PageHeader title="Vaults" sub="Live balances, spend proposals, and vault details." />
          <Dashboard onSelectVault={vault => setPage({ name: 'vault', vault })} />
        </>
      )}
    </Layout>
  );
}
