import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import { startTapitFlow } from '../lib/wallet-signin';
import { Button } from './ui';
import { useToast } from './toast';
import { colors, fonts, radii, space } from '../theme';

/**
 * WalletLinkCard -- start the bind flow that links a Tapit wallet to this
 * account, so the user can later sign in by proving key control and join the
 * green/red readiness. This is the entry point for the whole Tapit path: a
 * person with no wallet yet clicks Link, the wallet walks them through creating
 * one, and the wallet returns them here to finish binding. Shows the current
 * link state so a linked user isn't prompted again.
 */
export function WalletLinkCard() {
  const toast = useToast();
  const [linked, setLinked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.readiness
      .get()
      .then((r) => { if (!cancelled) setLinked(r.me.linked); })
      // No readiness data (or pre-migration) -- treat as not linked so the
      // prompt still shows; the link call will surface any real error.
      .catch(() => { if (!cancelled) setLinked(false); });
    return () => { cancelled = true; };
  }, []);

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
        <span style={{ ...s.dot, background: linked ? colors.green : colors.gold }} />
        <span style={s.title}>Tapit wallet</span>
        {linked === true && <span style={s.tag}>linked</span>}
      </div>

      {linked === true ? (
        <p style={s.body}>
          Your Tapit wallet is linked. You can sign in by proving you control
          your key from the login screen -- no password needed.
        </p>
      ) : (
        <>
          <p style={s.body}>
            Link a Tapit wallet to sign in by proving you control your key, and to
            join your family's green/red readiness. No Tapit wallet yet? You'll
            create one in a moment and come right back here to finish linking.
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || linked === null}
            onClick={() => void link()}
            style={{ marginTop: space[3] }}
          >
            {linked === null ? 'Checking...' : 'Link your Tapit wallet'}
          </Button>
        </>
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
  dot: { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto' },
  title: { fontSize: 15, fontWeight: 700, color: colors.text },
  tag: { fontSize: 12, color: colors.green },
  body: { margin: 0, fontSize: 13.5, lineHeight: 1.6, color: colors.sub },
};
