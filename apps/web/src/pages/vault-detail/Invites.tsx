import { useState } from "react";
import { PANEL_FIT } from "../../components/ui/panelFit";
import { api, type Vault, type VaultInvite, type VaultRole } from "../../lib/api";
import { colors, fonts, radii, space } from "../../theme";
import { Button, Input, Label } from "../../components/ui";
import { roleLabel } from "./shared";


export function InviteRow({
  invite,
  onCopyLink,
  onCopyCode,
  onRevoke,
}: {
  invite: VaultInvite;
  onCopyLink: () => void;
  onCopyCode: () => void;
  onRevoke: () => void;
}) {
  const expires = new Date(invite.expires_at);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: `1px solid ${colors.border}`,
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      <div>
        <div style={{ fontSize: 17, color: colors.text }}>
          {invite.invited_label ?? "Unnamed"} ({roleLabel(invite.invited_role)})
        </div>
        <div style={{ fontSize: 15, color: colors.muted }}>
          Expires {expires.toLocaleDateString()}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 16 }} onClick={onCopyLink}>
          Copy link
        </Button>
        <Button variant="ghost" size="sm" style={{ fontSize: 16 }} onClick={onCopyCode}>
          Copy code
        </Button>
        <Button variant="danger" size="sm" style={{ fontSize: 16 }} onClick={onRevoke}>
          Revoke
        </Button>
      </div>
    </div>
  );
}

export function InviteModal({
  vault,
  onClose,
  onCreated,
}: {
  vault: Vault;
  onClose: () => void;
  onCreated: (invite: VaultInvite) => void;
}) {
  const [role, setRole] = useState<Exclude<VaultRole, "owner">>("founder");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api.invites.create({
        vault_id: vault.id,
        invited_role: role,
        invited_label: label.trim() || undefined,
      });
      onCreated(res.invite);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create invite");
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
        zIndex: 200,
        padding: space[4],
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: "28px 32px",
          width: "100%",
          maxWidth: 420,
          ...PANEL_FIT,
        }}
      >
        <h2
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: colors.text,
            fontFamily: fonts.display,
            margin: 0,
            marginBottom: 20,
          }}
        >
          Invite co-signer
        </h2>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <Label>Role</Label>
            <select
              value={role}
              onChange={e => setRole(e.target.value as typeof role)}
              style={{
                width: "100%",
                padding: "11px 13px",
                background: colors.input,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                color: colors.text,
                fontSize: 17,
                fontFamily: fonts.sans,
                boxSizing: "border-box",
              }}
            >
              <option value="founder">Trustee (can sign immediately)</option>
              <option value="heir">Successor trustee (inheritance path)</option>
              <option value="beneficiary">Beneficiary (receives distributions, files requests)</option>
              <option value="viewer">Observer (read-only)</option>
            </select>
          </div>
          <div>
            <Label>Display name (optional)</Label>
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Dad, Sister, Lawyer"
            />
          </div>
          {err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}
          <div style={{ display: "flex", gap: 10 }}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create invite link"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
