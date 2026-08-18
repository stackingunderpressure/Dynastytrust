import { useState, type CSSProperties } from 'react';
import { startTapitFlow, WALLET_BASE_URL } from '../lib/wallet-signin';
import { Button } from './ui';
import { useToast } from './toast';
import { colors, fonts, radii, space } from '../theme';

/**
 * WalletLinkCard -- two distinct entry points into the Tapit relationship,
 * split (2026-08-18, operator request) because they were previously one
 * button doing two different things depending on whether the person
 * already had a wallet: someone who already has Tapit wants to prove key
 * control and link it (the real challenge/response flow below); someone
 * who doesn't has nothing to sign yet and just needs to go create one,
 * then come back. Bundling both into a single redirect meant a brand-new
 * user's very first Tapit visit carried a DynastyTrust sign-in challenge
 * that made no sense yet.
 */
export function WalletLinkCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function link() {
    setBusy(true);
    try {
      await startTapitFlow('link');
      // Success navigates to the wallet; only reached on a thrown error.
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start linking');
      setBusy(false);
    }
  }

  function createAccount() {
    // New tab, not a redirect: creating a wallet has no callback path back
    // to a specific DynastyTrust URL, so this tab stays put -- the person
    // comes back to it and taps "Link an existing wallet" once they have one.
    window.open(WALLET_BASE_URL, '_blank', 'noopener,noreferrer');
  }

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={s.dot} />
        <span style={s.title}>Tapit wallet</span>
      </div>
      <p style={s.body}>
        Sign in by proving you control your Tapit key -- no password to remember, no key ever
        leaves the wallet.
      </p>
      <div style={{ display: 'flex', gap: space[2], marginTop: space[3], flexWrap: 'wrap' }}>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void link()}>
          Link an existing wallet
        </Button>
        <Button variant="ghost" size="sm" onClick={createAccount}>
          New to Tapit? Create an account
        </Button>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: radii.lg,
    padding: '16px 18px',
    marginBottom: space[5],
    fontFamily: fonts.sans,
  },
  head: { display: 'flex', alignItems: 'center', gap: space[3], marginBottom: space[2] },
  dot: { width: 9, height: 9, borderRadius: '50%', background: colors.gold, flex: '0 0 auto' },
  title: { fontSize: 15, fontWeight: 700, color: colors.text },
  body: { margin: 0, fontSize: 13.5, lineHeight: 1.6, color: colors.sub },
};
