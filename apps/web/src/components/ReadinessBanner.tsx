import { useEffect, useState, type CSSProperties } from 'react';
import { api, type ReadinessState } from '../lib/api';
import { colors, fonts, radii, space } from '../theme';

/**
 * ReadinessBanner -- the guided-sweep surface for a flagged wallet.
 *
 * Green/red is GUIDANCE ONLY. When the signed-in user's own wallet has been
 * flagged red by a co-member, we surface the sweep-to-a-clean-wallet steps.
 * We never block login, signing, quorum, or base spend on this -- it is a
 * heads-up that makes a possible compromise visible and points at recovery.
 * Renders nothing when the wallet is green, unlinked, or the read fails.
 */
export function ReadinessBanner() {
  const [state, setState] = useState<ReadinessState | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.readiness
      .get()
      .then((r) => { if (!cancelled) setState(r); })
      // Readiness is advisory -- never break the app if the read fails.
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!state || state.me.readiness !== 'red') return null;

  return (
    <div style={s.wrap} role="status">
      <div style={s.head}>
        <span style={s.dot} />
        <span style={s.title}>Your group flagged this wallet</span>
      </div>
      <p style={s.body}>
        Someone in your vault marked this wallet as possibly compromised
        {state.me.reason ? `: "${state.me.reason}"` : ''}. This is a heads-up,
        not a lock -- you can still sign in and use DynastyTrust, and it never
        touches your own multisig spend. The safe move is to sweep your funds to
        a clean wallet, then have your group clear the flag.
      </p>
      <ol style={s.steps}>
        <li>Create a fresh key in the Key Manager (new seed, backed up).</li>
        <li>Move your funds to an address you control from that clean key.</li>
        <li>Re-link the clean wallet, then ask a co-member to clear your flag.</li>
      </ol>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    border: `1px solid ${colors.borderDanger}`,
    background: colors.dangerBg,
    borderRadius: radii.lg,
    padding: space[5],
    marginBottom: space[5],
    fontFamily: fonts.sans,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    marginBottom: space[3],
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: colors.red,
    flex: '0 0 auto',
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: colors.red,
  },
  body: {
    fontSize: 14,
    lineHeight: 1.6,
    color: colors.sub,
    margin: 0,
  },
  steps: {
    margin: `${space[4]}px 0 0`,
    paddingLeft: space[5],
    fontSize: 14,
    lineHeight: 1.7,
    color: colors.text,
  },
};
