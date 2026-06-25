import { useState, type CSSProperties } from 'react';
import { startTapitFlow } from '../lib/wallet-signin';
import { Button } from './ui';
import { useToast } from './toast';
import { colors, fonts, radii, space } from '../theme';

/**
 * WalletLinkCard -- start the bind flow that links a Tapit wallet to this
 * account, so the user can later sign in by proving key control. This is the
 * entry point for the whole Tapit path: a person with no wallet yet clicks
 * Link, the wallet walks them through creating one, and (with the wallet's
 * return-path fix) brings them back here to finish binding.
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

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={s.dot} />
        <span style={s.title}>Tapit wallet</span>
      </div>
      <p style={s.body}>
        Link a Tapit wallet to sign in by proving you control your key. No Tapit
        wallet yet? You'll create one in a moment and come right back here to
        finish linking.
      </p>
      <Button
        variant="primary"
        size="sm"
        disabled={busy}
        onClick={() => void link()}
        style={{ marginTop: space[3] }}
      >
        Link your Tapit wallet
      </Button>
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
