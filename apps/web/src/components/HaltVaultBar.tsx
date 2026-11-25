import { useEffect, useState } from 'react';
import { colors, radii, space } from '../theme';
import { api } from '../lib/api';
import { Button } from './ui';
import { useConfirm } from './dialog';

/**
 * HaltVaultBar -- the plain, one-tap "halt signing" control (2026-08-08
 * phone-callback follow-up, operator: "push the red button on the thing
 * and no one would sign. The app would shut down until everybody agreed").
 *
 * Sets vault.duress straight to true/false via PATCH /api/vaults. This is
 * deliberately the BLUNT instrument -- no phrase, no per-signer targeting,
 * one tap, for when a member can act freely and just needs to stop
 * everything on this vault right now. The fail-closed signing gate already
 * refuses every spend on a duress-flagged vault (see VaultDetail's signing
 * flow, `duress: effectiveDuress` passed into evaluateSigningGate) -- this
 * component only surfaces the control, it enforces nothing itself.
 *
 * Always visible, not tucked into a tab: a halt is exactly the kind of
 * action that must never require hunting through the UI to find.
 */
export function HaltVaultBar({
  duress,
  busy,
  onToggle,
  vaultId,
  isOwner,
}: {
  duress: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
  /** For a hold raised by the circle (vault-duress.js): its status, and the
   *  owner's "ask to lift". */
  vaultId?: string;
  isOwner?: boolean;
}) {
  const askConfirm = useConfirm();
  const [circle, setCircle] = useState<{ circle_hold: boolean; clears: number; needed: number; owner_cleared: boolean; raised_at: string | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askErr, setAskErr] = useState<string | null>(null);
  useEffect(() => {
    if (!duress || !vaultId) { setCircle(null); return; }
    let live = true;
    api.vaults.duressStatus(vaultId).then(r => { if (live) setCircle(r); }).catch(() => {});
    return () => { live = false; };
  }, [duress, vaultId]);

  async function askToLift() {
    if (!vaultId) return;
    setAsking(true);
    setAskErr(null);
    try {
      const r = await api.vaults.askToLiftDuress(vaultId);
      setCircle(r);
      if (!r.held) onToggle(false);
    } catch (e) {
      setAskErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setAsking(false);
    }
  }

  // A hold raised by someone in the circle (a checker heard the duress
  // phrase): lifting it takes the owner AND the circle (operator,
  // 2026-11-25), because the owner may be the one under pressure.
  if (duress && circle?.circle_hold) {
    return (
      <div style={{ background: colors.dangerBg, border: `1px solid ${colors.red}`, borderRadius: radii.md, padding: space[4], display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontWeight: 700, color: colors.red, fontSize: 17 }}>Someone in your circle reported duress</div>
        <div style={{ fontSize: 16, color: colors.sub, lineHeight: 1.5 }}>
          {circle.raised_at ? `${new Date(circle.raised_at).toLocaleString()}: ` : ''}a checker heard the duress phrase, so
          no spend can be signed on this vault -- by you or anyone. It lifts only when you ask AND {circle.needed} of your
          circle confirm in Tapit. {circle.clears} of {circle.needed} have confirmed{circle.owner_cleared ? '; you have asked.' : '.'}
        </div>
        {isOwner && !circle.owner_cleared && (
          <Button variant="danger" size="sm" style={{ alignSelf: 'flex-start', minHeight: 44 }} disabled={asking} onClick={() => void askToLift()}>
            {asking ? 'Asking...' : 'Ask to lift the hold'}
          </Button>
        )}
        {askErr && <div style={{ fontSize: 15, color: colors.red }}>{askErr}</div>}
      </div>
    );
  }

  async function handleHalt() {
    const ok = await askConfirm({
      title: 'Halt signing on this vault?',
      message:
        "No spend will be signable on this vault until you turn this back off. Use this if you're not sure it's really safe to sign right now -- from a phone call that didn't check out, a duress phrase, or anything else that gave you pause.",
      confirmLabel: 'Halt signing',
    });
    if (ok) onToggle(true);
  }

  async function handleResume() {
    const ok = await askConfirm({
      title: 'Resume signing on this vault?',
      message: 'Only do this once you and your circle have actually sorted out what caused the halt.',
      confirmLabel: 'Resume signing',
    });
    if (ok) onToggle(false);
  }

  if (duress) {
    return (
      <div
        style={{
          background: colors.dangerBg,
          border: `1px solid ${colors.red}`,
          borderRadius: radii.md,
          padding: space[4],
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space[2],
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ fontWeight: 700, color: colors.red, fontSize: 17 }}>
            Signing is halted on this vault
          </div>
          <div style={{ fontSize: 16, color: colors.sub, marginTop: 2 }}>
            No spend can be signed until this is turned back off.
          </div>
        </div>
        <Button variant="danger" size="sm" disabled={busy} onClick={handleResume}>
          Resume signing
        </Button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space[2],
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontSize: 16, color: colors.muted }}>
        Not sure a request is really safe to sign? Halt all signing on this vault immediately.
      </span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={handleHalt} style={{ color: colors.red }}>
        Halt signing
      </Button>
    </div>
  );
}
