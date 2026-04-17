import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { supabase } from './lib/supabase';
import KeyManager from './pages/KeyManager';
import PolicyBuilder from './pages/PolicyBuilder';
import Dashboard from './pages/Dashboard';
import VaultDetail from './pages/VaultDetail';
import { NAV_LINKS } from './config';
import { Layout } from './components/Layout';
import { PageHeader } from './components/PageHeader';
import { RequireAuth } from './components/RequireAuth';

export default function App() {
  return (
    <BrowserRouter>
      <RequireAuth>{() => <AuthedApp />}</RequireAuth>
    </BrowserRouter>
  );
}

function AuthedApp() {
  const location = useLocation();
  const activeNavId =
    NAV_LINKS.find(l => location.pathname.startsWith(l.path))?.id ?? '';

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/keys" replace />} />
      <Route
        path="/keys"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => supabase.auth.signOut()}>
            <PageHeader
              title="Key Manager"
              sub="Generate software keys and import hardware xpubs. Private keys never leave this browser."
            />
            <KeyManager />
          </Layout>
        }
      />
      <Route
        path="/policy"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => supabase.auth.signOut()}>
            <PageHeader
              title="Policy Builder"
              sub="Assemble keys into a vault policy and compile to a Bitcoin address via Fly.io."
            />
            <PolicyBuilder />
          </Layout>
        }
      />
      <Route
        path="/vaults"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => supabase.auth.signOut()}>
            <PageHeader
              title="Vaults"
              sub="Live balances, spend proposals, and vault details."
            />
            <Dashboard />
          </Layout>
        }
      />
      <Route path="/vaults/:id" element={<VaultDetail />} />
      <Route path="*" element={<Navigate to="/keys" replace />} />
    </Routes>
  );
}
