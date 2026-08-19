import { useEffect, useState, type CSSProperties } from 'react';
import { WALLET_BASE_URL } from '../lib/wallet-signin';
import { TapitConnectModal } from './TapitConnectModal';
import { Button } from './ui';
import { api } from '../lib/api';
import { colors, fonts, radii, space } from '../theme';

function shortPubkey(hex: string): string {
  return hex.length <= 12 ? hex : `${hex.slice(0, 8)}...${hex.slice(-6)}`;
}

/**
 * WalletLinkCard -- two distinct entry points into the Tapit relationship,
 * split (2026-08-18, operator request) because they were previously one
 * button doing two different things depending on whether the person
 * already had a wallet: someone who already has Tapit wants to prove key
 * control and link it; someone who doesn't has nothing to sign yet and
 * just needs to go create one, then come back.
 *
 * "Link an existing wallet" opens TapitConnectModal (a QR + Nostr
 * response_channel, operator request 2026-08-18: "send nostr message ...
 * with separate button for new to tapit create an account") -- scanning
 * it on a phone approves in a completely separate browser context, with
 * no page-redirect round trip needed for THIS tab. The modal's own "open
 * Tapit directly on this device" link is the same-device fallback (the
 * old full-page redirect, still exactly the flow it always was).
 */
export function WalletLinkCard() {
  const [connecting, setConnecting] = useState(false);
  const [linkedPubkey, setLinkedPubkey] = useState<string | null | undefined>(undefined);
  const [unlinking, setUnlinking] = useState(false);

  function refreshLinkStatus() {
    void api.walletLink.get()
      .then(res => setLinkedPubkey(res.pubkey))
      .catch(() => setLinkedPubkey(null));
  }

  useEffect(refreshLinkStatus, []);

  function createAccount() {
    // New tab, not a redirect: creating a wallet has no callback path back
    // to a specific DynastyTrust URL, so this tab stays put -- the person
    // comes back to it and taps "Link an existing wallet" once they have one.
    window.open(WALLET_BASE_URL, '_blank', 'noopener,noreferrer');
  }

  function handleUnlink() {
    setUnlinking(true);
    void api.walletLink.unlink()
      .then(() => setLinkedPubkey(null))
      .finally(() => setUnlinking(false));
  }

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={{ ...s.dot, background: linkedPubkey ? colors.green : colors.gold }} />
        <span style={s.title}>Tapit wallet</span>
      </div>
      {linkedPubkey ? (
        <>
          <p style={s.body}>
            Linked -- sign in with this Tapit key any time instead of a password.
          </p>
          <p style={{ ...s.body, fontFamily: fonts.mono, fontSize: 12.5, marginTop: 6 }}>
            {shortPubkey(linkedPubkey)}
          </p>
          <div style={{ display: 'flex', gap: space[2], marginTop: space[3], flexWrap: 'wrap' }}>
            <Button variant="ghost" size="sm" onClick={() => setConnecting(true)}>
              Link a different wallet
            </Button>
            <Button variant="ghost" size="sm" onClick={handleUnlink} disabled={unlinking}>
              {unlinking ? 'Unlinking...' : 'Unlink'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p style={s.body}>
            Sign in by proving you control your Tapit key -- no password to remember, no key ever
            leaves the wallet.
          </p>
          <div style={{ display: 'flex', gap: space[2], marginTop: space[3], flexWrap: 'wrap' }}>
            <Button variant="primary" size="sm" onClick={() => setConnecting(true)}>
              Link an existing wallet
            </Button>
            <Button variant="ghost" size="sm" onClick={createAccount}>
              New to Tapit? Create an account
            </Button>
          </div>
        </>
      )}
      {connecting && (
        <TapitConnectModal
          mode="link"
          onClose={() => setConnecting(false)}
          onDone={() => {
            setConnecting(false);
            refreshLinkStatus();
          }}
        />
      )}
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
