import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { supabase } from './lib/supabase';
import { markIntentionalSignOut } from './lib/session-intent';
import { startNostrOutboxWorker } from './lib/nostrOutboxWorker';
import KeyManager from './pages/KeyManager';
import VaultWizard from './pages/VaultWizard';
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

  // Durable Nostr outbox (2026-08-08, operator: "it needs to be constantly
  // aware... always looking"). Started once for the whole authenticated
  // session so a psbt-cosign request or a circle safety-phrase send that
  // couldn't reach any relay at send time keeps retrying in the
  // background for as long as the app is open, not just at the moment
  // the operator clicked "send." Stopped on sign-out / unmount so it
  // never runs against a session that's gone.
  useEffect(() => {
    const worker = startNostrOutboxWorker();
    return () => worker.stop();
  }, []);

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
      {/* /policy used to route to PolicyBuilder, a separate /policy/bloc
          routed to BlocBuilder -- two pages, two visual languages, for
          the same job (docs/ux-coherence-redesign.md step 2). Both are
          retired; VaultWizard covers both shapes as one guided flow. A
          bookmark to the old /policy/bloc falls through to the catch-all
          below and lands on /start, same as any other unknown path. */}
      <Route
        path="/policy"
        element={
          <Layout activeNavId={activeNavId} onSignOut={() => { markIntentionalSignOut(); void supabase.auth.signOut(); }}>
            <PageHeader
              title="Build your vault"
              sub="Pick a shape, add your keys now or later, and we handle compiling and funding along the way."
            />
            <VaultWizard />
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
