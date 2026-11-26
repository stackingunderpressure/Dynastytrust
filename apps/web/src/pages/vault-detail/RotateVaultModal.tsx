import { useEffect, useState } from "react";
import { PANEL_FIT } from "../../components/ui/panelFit";
import { api, type Vault } from "../../lib/api";
import { useToast } from "../../components/toast";
import { colors, fonts, radii, space } from "../../theme";
import { Button, Input, Label } from "../../components/ui";
import { tipHeight } from "../../lib/chain";
import { rotateDateWords, ROTATE_EXTENSIONS } from "../../lib/timelock-words";


// // -- RotateVaultModal
// Create a successor draft vault that inherits the current vault's
// trust doc, member roster, quorums, and address type. Owner picks
// new timelocks (defaults to the current intent in blocks, or the
// same absolute heights translated to "blocks from now" via the
// chain tip). Members carry forward with their existing keys so
// the new vault is ready to compile immediately -- perfect for
// key rotation or for evolving the shape without losing history.
// For membership changes, open the Members tab on the successor
// draft AFTER rotation to add / remove members before compiling.

export function RotateVaultModal({
  vault,
  onClose,
  onRotated,
}: {
  vault: Vault;
  onClose: () => void;
  onRotated: (v: Vault) => void;
}) {
  const toast = useToast();
  const [tip, setTip] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    tipHeight(vault.network).then(setTip).catch(() => {});
  }, [vault.network]);

  // Convert the source vault's ABSOLUTE heights back to block
  // offsets so the rotation modal defaults to the same intent.
  const offsetFromAbs = (abs: number | null | undefined) => {
    if (!abs || abs <= 0) return 0;
    if (tip == null) return abs;
    return Math.max(0, abs - tip);
  };

  const [name, setName] = useState(`${vault.name} v2`);
  // Kept as raw text, not a number: a fully-controlled number input bound
  // straight to a number state snaps back to that number the instant the
  // field is empty (Number('') || 0 equals whatever it already was), so
  // backspacing to retype a new value never actually clears the field.
  // Text state lets it sit empty mid-edit; the numeric value used below
  // just treats "not yet hydrated" or "currently empty" as 0.
  const [recoveryOffsetText, setRecoveryOffsetText] = useState<string | null>(null);
  const [inheritanceOffsetText, setInheritanceOffsetText] = useState<string | null>(null);
  const recoveryOffset = recoveryOffsetText ? Number(recoveryOffsetText) || 0 : 0;
  const inheritanceOffset = inheritanceOffsetText ? Number(inheritanceOffsetText) || 0 : 0;

  useEffect(() => {
    if (tip == null) return;
    if (recoveryOffsetText == null) setRecoveryOffsetText(String(offsetFromAbs(vault.recovery_after)));
    if (inheritanceOffsetText == null) setInheritanceOffsetText(String(offsetFromAbs(vault.inheritance_after)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip]);

  const hasInheritance = vault.inheritance_after > 0 || vault.recovery_after > 0;

  async function rotate() {
    setBusy(true);
    try {
      const res = await api.vaults.rotate({
        vault_id: vault.id,
        overrides: {
          name: name.trim() || undefined,
          recovery_after: hasInheritance ? recoveryOffset : 0,
          inheritance_after: hasInheritance ? inheritanceOffset : 0,
        },
      });
      toast.success("Successor draft created. Compile when ready.");
      onRotated(res.vault);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rotation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: space[4],
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: "24px 28px",
          width: "100%",
          maxWidth: 520,
          ...PANEL_FIT,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, fontFamily: fonts.display, color: colors.text, marginBottom: 6 }}>
          Rotate vault
        </div>
        <div style={{ fontSize: 17, color: colors.muted, lineHeight: 1.5, marginBottom: 16 }}>
          Creates a successor draft that inherits this vault's trust document, members, and shape. A vault's dates are fixed for good, so this is also the only way to push the inheritance date out: choose a later date below, compile the new vault, then move the coins to it. Old and new stay linked in the audit trail.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <Label>New vault name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} />
          </div>
          {hasInheritance && (
            <>
              <div>
                <Label>Recovery timelock (blocks from compile)</Label>
                <Input
                  type="number"
                  min={0}
                  value={recoveryOffsetText ?? ''}
                  onChange={e => setRecoveryOffsetText(e.target.value)}
                />
                <div style={{ fontSize: 16, color: colors.sub, marginTop: 4, lineHeight: 1.5 }}>
                  {tip == null ? "Checking the chain..." : rotateDateWords(recoveryOffset, vault.recovery_after, tip, new Date())}
                </div>
              </div>
              <div>
                <Label>Inheritance timelock (blocks from compile)</Label>
                <Input
                  type="number"
                  min={0}
                  value={inheritanceOffsetText ?? ''}
                  onChange={e => setInheritanceOffsetText(e.target.value)}
                />
                <div style={{ fontSize: 16, color: colors.sub, marginTop: 4, lineHeight: 1.5 }}>
                  {tip == null ? "Checking the chain..." : rotateDateWords(inheritanceOffset, vault.inheritance_after, tip, new Date())}
                </div>
                {tip != null && vault.inheritance_after > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {ROTATE_EXTENSIONS.map(x => (
                      <Button
                        key={x.label}
                        type="button"
                        variant="ghost"
                        size="sm"
                        style={{ minHeight: 40 }}
                        onClick={() => setInheritanceOffsetText(String(Math.max(0, vault.inheritance_after - tip) + x.extraBlocks))}
                      >
                        {x.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          <div
            style={{
              padding: "10px 12px",
              background: colors.gold + "0C",
              border: `1px solid ${colors.gold}33`,
              borderRadius: radii.sm,
              fontSize: 16,
              color: colors.sub,
              lineHeight: 1.5,
              marginTop: 4,
            }}
          >
            Members and trust document carry forward. If you need to rotate keys or change membership, open the Members tab on the successor draft before compiling.
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={() => void rotate()} disabled={busy}>
              {busy ? "Rotating..." : "Create successor draft"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
