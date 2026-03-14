import { useEffect, useState } from 'react';
import { supabase, type Session } from './lib/supabase';
import Auth from './pages/Auth';
import { repairPubkeys } from './lib/keystore';
import KeyManager from './pages/KeyManager';
import PolicyBuilder from './pages/PolicyBuilder';
import Dashboard from './pages/Dashboard';
import VaultDetail from './pages/VaultDetail';
import type { Vault } from './lib/api';

type Tab  = 'keys' | 'policy' | 'vaults';
type Page = { name: 'app'; tab: Tab } | { name: 'vault'; vault: Vault };

const C = {
  bg: '#07070F', header: '#0A0A12', border: '#1E1E30',
  gold: '#C9A84C', text: '#E8E4D8', muted: '#5A5570',
};

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'keys',   label: 'Keys',           icon: '🔑' },
  { id: 'policy', label: 'Policy builder', icon: '⚙️' },
  { id: 'vaults', label: 'Vaults',         icon: '🏦' },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage]       = useState<Page>({ name: 'app', tab: 'keys' });

  useEffect(() => {
    repairPubkeys();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex',
        alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontFamily: '"Playfair Display", serif', fontSize: 22,
          letterSpacing: '0.14em', color: C.gold }}>DYNASTYTRUST</span>
      </div>
    );
  }

  if (!session) return <Auth />;

  if (page.name === 'vault') {
    return <VaultDetail vault={page.vault} onBack={() => setPage({ name: 'app', tab: 'vaults' })} />;
  }

  const tab    = page.tab;
  const setTab = (t: Tab) => setPage({ name: 'app', tab: t });

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: '"DM Sans", sans-serif' }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 32px', height: 60, borderBottom: `1px solid ${C.border}`,
        background: C.header, position: 'sticky', top: 0, zIndex: 100,
      }}>
        <span style={{ fontFamily: '"Playfair Display", serif', fontSize: 17,
          fontWeight: 700, letterSpacing: '0.12em', color: C.gold }}>DYNASTYTRUST</span>
        <nav style={{ display: 'flex', gap: 2 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: '6px 18px', border: 'none', borderRadius: 8, fontSize: 14,
              cursor: 'pointer', fontFamily: '"DM Sans", sans-serif',
              background: tab === t.id ? '#1E1E30' : 'transparent',
              color: tab === t.id ? C.text : C.muted,
              fontWeight: tab === t.id ? 600 : 400,
            }}>
              {t.icon} {t.label}
            </button>
          ))}
        </nav>
        <button onClick={() => supabase.auth.signOut()} style={{
          background: 'none', border: `1px solid ${C.border}`, borderRadius: 8,
          color: C.muted, fontSize: 13, padding: '6px 14px', cursor: 'pointer',
          fontFamily: '"DM Sans", sans-serif',
        }}>Sign out</button>
      </header>
      <main style={{ maxWidth: 1000, margin: '0 auto', padding: '36px 32px' }}>
        {tab === 'keys' && <>
          <PageHeader title="Key Manager" sub="Generate software keys and import hardware xpubs. Private keys never leave this browser." />
          <KeyManager />
        </>}
        {tab === 'policy' && <>
          <PageHeader title="Policy Builder" sub="Assemble keys into a vault policy and compile to a Bitcoin address via Fly.io." />
          <PolicyBuilder onVaultCreated={vault => setPage({ name: 'vault', vault })} />
        </>}
        {tab === 'vaults' && <>
          <PageHeader title="Vaults" sub="Live balances, spend proposals, and vault details." />
          <Dashboard onSelectVault={vault => setPage({ name: 'vault', vault })} />
        </>}
      </main>
    </div>
  );
}

function PageHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, color: C.text,
        fontFamily: '"Playfair Display", serif', margin: '0 0 6px' }}>{title}</h1>
      <p style={{ fontSize: 14, color: C.muted, margin: 0 }}>{sub}</p>
    </div>
  );
}
