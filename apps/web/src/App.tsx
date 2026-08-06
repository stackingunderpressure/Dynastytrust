import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { supabase } from './lib/supabase';
import { markIntentionalSignOut } from './lib/session-intent';
import KeyManager from './pages/KeyManager';
import PolicyBuilder from './pages/PolicyBuilder';
import BlocBuilder from './pages/BlocBuilder';
import StartVault from './pages/StartVault';
import Dashboard from './pages/Dashboard';
import VaultDetail from './pages/VaultDetail';
import ProposalDetail from './pages/ProposalDetail';
import TapitCosignCallback from './pages/TapitCosignCallback';
import InviteClaim from './pages/InviteClaim';
import Landing from './pages/Landing';
import Reminders from './pages/Reminders';
import ChatWizard from './pages/ChatWizard';
import { NAV_LINKS } from './config';
import { Layout } from './components/Layout';
import { PageHeader } from './components/PageHeader';
import { RequireAuth } from './components/RequireAuth';
import { ErrorBoundary } from './components/ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          {/* Public: the landing page is the first-lander marketing +
              inline login. Repeat visitors with an active session are
              auto-redirected to /vaults by the page itself. */}
          <Route path="/" element={<Landing />} />
          {/* Public: the claim page must load before the user is signed in. */}
          <Route path="/invite/:token" element={<InviteClaim />} />
          {/* Everything else sits behind RequireAuth. */}
          <Route
            path="*"
            element={<RequireAuth>{() => <AuthedApp />}</RequireAuth>}
          />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

function AuthedApp() {
  const location = useLocation();
  const activeNavId =
    NAV_LINKS.find(l => location.pathname.startsWith(l.path))?.id ?? '';

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/start" replace />} />
      <Route
        path="/start"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => { markIntentionalSignOut(); void supabase.auth.signOut(); }}>
            <PageHeader
              title="What do you want to protect?"
              sub="Pick what fits. We handle the Bitcoin part behind the scenes -- you just choose the outcome you want."
            />
            <StartVault />
          </Layout>
        }
      />
      <Route
        path="/keys"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => { markIntentionalSignOut(); void supabase.auth.signOut(); }}>
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
          <Layout activeNavId={activeNavId} onSignOut={() => { markIntentionalSignOut(); void supabase.auth.signOut(); }}>
            <PageHeader
              title="Policy Builder"
              sub="Assemble keys into a vault policy and compile to a Bitcoin address via Fly.io."
            />
            <PolicyBuilder />
          </Layout>
        }
      />
      <Route
        path="/policy/bloc"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => { markIntentionalSignOut(); void supabase.auth.signOut(); }}>
            <PageHeader
              title="Dynasty Bloc"
              sub="A decaying-multisig family vault: parents now, one parent + kids now, then timelocks for a single parent and for the kids to take over with a multisig that loosens over time."
            />
            <BlocBuilder />
          </Layout>
        }
      />
      <Route
        path="/vaults"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => { markIntentionalSignOut(); void supabase.auth.signOut(); }}>
            <PageHeader
              title="Vaults"
              sub="Live balances, spend proposals, and vault details."
            />
            <Dashboard />
          </Layout>
        }
      />
      <Route
        path="/assistant"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => { markIntentionalSignOut(); void supabase.auth.signOut(); }}>
            <PageHeader
              title="Assistant"
              sub="Sage teaches you Bitcoin vaults in plain language and proposes one to build. You decide with a tap -- no keys ever leave your browser."
            />
            <ChatWizard />
          </Layout>
        }
      />
      <Route path="/vaults/:id" element={<VaultDetail />} />
      <Route path="/vaults/:vaultId/proposals/:proposalId" element={<ProposalDetail />} />
      <Route path="/tapit-cosign-callback" element={<TapitCosignCallback />} />
      <Route
        path="/reminders"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => { markIntentionalSignOut(); void supabase.auth.signOut(); }}>
            <PageHeader
              title="Reminders"
              sub="Role-aware legal + governance reminders. Countdowns to timelocks, tax deadlines, annual reviews."
            />
            <Reminders />
          </Layout>
        }
      />
      <Route path="*" element={<Navigate to="/start" replace />} />
    </Routes>
  );
}
