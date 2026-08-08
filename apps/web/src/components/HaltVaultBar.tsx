import { colors, radii, space } from '../theme';
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
}: {
  duress: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const askConfirm = useConfirm();

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
          <div style={{ fontWeight: 700, color: colors.red, fontSize: 14 }}>
            Signing is halted on this vault
          </div>
          <div style={{ fontSize: 12, color: colors.sub, marginTop: 2 }}>
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
      <span style={{ fontSize: 12, color: colors.muted }}>
        Not sure a request is really safe to sign? Halt all signing on this vault immediately.
      </span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={handleHalt} style={{ color: colors.red }}>
        Halt signing
      </Button>
    </div>
  );
}
