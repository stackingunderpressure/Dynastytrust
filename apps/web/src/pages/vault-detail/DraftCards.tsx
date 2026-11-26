import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { DOWNLOAD } from "../../lib/download";
import { api, type Vault, type VaultMember, type VaultInvite } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useToast } from "../../components/toast";
import { colors, fonts, radii, } from "../../theme";
import { Button } from "../../components/ui";
import { useRealtimeRefresh } from "../../lib/realtime";
import { inviteLink } from "../../lib/invite-link";
import { autofillTrustDocIfEmpty } from "./shared";


export function DraftReadinessCard({
  vault,
  onOpenTab,
}: {
  vault: Vault;
  onOpenTab: (id: string) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [invites, setInvites] = useState<VaultInvite[]>([]);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<{ user: { id: string } } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session as unknown as { user: { id: string } });
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const [m, inv] = await Promise.all([
        api.members.list(vault.id),
        api.invites.list(vault.id),
      ]);
      setMembers(m.members);
      setInvites(inv.invites.filter(i => !i.claimed_at));
    } catch {
      /* best-effort */
    }
  }, [vault.id]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeRefresh({ table: "vault_members", filter: `vault_id=eq.${vault.id}` }, () => void load());
  useRealtimeRefresh({ table: "vault_invites", filter: `vault_id=eq.${vault.id}` }, () => void load());

  const isOwner = session?.user.id === vault.user_id;
  const ready = members.filter(m => m.xpub && m.fingerprint && m.pubkey && m.derivation_path);
  const foundersReady = ready.filter(m => m.role === "founder" || m.role === "owner").length;
  const heirsReady = ready.filter(m => m.role === "heir").length;
  const plannedF = vault.planned_founder_count ?? 0;
  const plannedH = vault.planned_heir_count ?? 0;
  const totalPlanned = plannedF + plannedH;
  const totalReady = foundersReady + heirsReady;
  const slotsFilled = foundersReady >= plannedF && heirsReady >= plannedH;
  const pctFilled = totalPlanned > 0 ? Math.min(100, Math.round((totalReady / totalPlanned) * 100)) : 0;

  async function compile() {
    setBusy(true);
    try {
      const res = await api.vaults.compile(vault.id);
      toast.success("Vault compiled -- ready to fund");
      autofillTrustDocIfEmpty(vault, res.vault);
      navigate(`/vaults/${res.vault.id}`, { state: { vault: res.vault } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Compile failed");
    } finally {
      setBusy(false);
    }
  }

  async function copyInviteLink(token: string, label?: string | null) {
    // The route is /invite/:token (App.tsx). This built /invite?token=...,
    // which fell through to the catch-all and dropped the invited person
    // on the vault builder.
    const url = inviteLink(token, { vaultName: vault.name, label: label ?? undefined });
    await navigator.clipboard.writeText(url);
    setCopied(token);
    setTimeout(() => setCopied(null), 1600);
  }

  function copyTrustCode(token: string) {
    navigator.clipboard.writeText(token);
    setCopied(token + "-code");
    setTimeout(() => setCopied(null), 1600);
  }

  // Build a unified "slot" list: claimed members first, then
  // outstanding invites, grouped by role.
  type Slot = {
    key: string;
    role: string;
    label: string;
    status: "claimed" | "pending";
    fingerprint?: string | null;
    invite?: VaultInvite;
  };
  const slots: Slot[] = [];
  for (const m of members) {
    const isReady = Boolean(m.xpub && m.fingerprint && m.pubkey && m.derivation_path);
    slots.push({
      key: m.id,
      role: m.role,
      label: m.label || "(unlabeled)",
      status: isReady ? "claimed" : "pending",
      fingerprint: m.fingerprint,
    });
  }
  for (const inv of invites) {
    slots.push({
      key: inv.id,
      role: inv.invited_role,
      label: inv.invited_label || inv.invited_email || "(unlabeled)",
      status: "pending",
      invite: inv,
    });
  }

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${slotsFilled ? colors.green : colors.gold}`,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: slotsFilled ? colors.green : colors.gold,
            textTransform: "uppercase",
            marginBottom: 4,
          }}
        >
          {slotsFilled ? "Ready to compile" : "Draft -- waiting on members"}
        </div>
        <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>
          {totalReady} of {totalPlanned} members joined
        </div>
      </div>

      <div
        style={{
          height: 6,
          background: colors.border,
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pctFilled}%`,
            height: "100%",
            background: slotsFilled ? colors.green : colors.gold,
            transition: "width 300ms",
          }}
        />
      </div>

      <div
        style={{
          padding: "10px 12px",
          background: colors.gold + "0C",
          border: `1px solid ${colors.gold}33`,
          borderRadius: radii.sm,
          fontSize: 16,
          color: colors.sub,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: colors.gold }}>One-shot compile.</strong> Every
        member's key is baked into the vault address at compile time. Add
        everyone first -- once compiled, the address is permanent. You can
        rotate to a new vault later without losing the trust document or
        history, but this specific vault's address cannot accept new members.
      </div>

      {slots.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {slots.map(s => (
            <div
              key={s.key}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 10px",
                border: `1px solid ${colors.border}`,
                borderRadius: radii.sm,
                background: s.status === "claimed" ? colors.green + "0C" : "transparent",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 17, color: colors.text, fontWeight: 500 }}>
                  {s.label}
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      color: colors.muted,
                      marginLeft: 8,
                      textTransform: "uppercase",
                    }}
                  >
                    {s.role}
                  </span>
                </div>
                <div style={{ fontSize: 15, color: colors.muted, fontFamily: fonts.mono, marginTop: 2 }}>
                  {s.status === "claimed"
                    ? `claimed . ${s.fingerprint || "fp missing"}`
                    : "pending"}
                </div>
              </div>
              {s.status === "pending" && s.invite && isOwner && (
                <div style={{ display: "flex", gap: 4 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{ fontSize: 15, padding: "4px 8px" }}
                    onClick={() => void copyInviteLink(s.invite!.token, s.invite!.invited_label)}
                  >
                    {copied === s.invite.token ? "Copied" : "Copy link"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{ fontSize: 15, padding: "4px 8px" }}
                    onClick={() => copyTrustCode(s.invite!.token)}
                  >
                    {copied === s.invite.token + "-code" ? "Copied" : "Copy code"}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {isOwner && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            onClick={() => void compile()}
            disabled={!slotsFilled || busy}
            style={{
              flex: 1,
              padding: "12px",
              background: slotsFilled ? colors.green : undefined,
            }}
          >
            {busy
              ? "Compiling..."
              : slotsFilled
                ? "Compile vault"
                : `Waiting on ${totalPlanned - totalReady} more member${totalPlanned - totalReady === 1 ? "" : "s"}`}
          </Button>
          {!slotsFilled && !DOWNLOAD && (
            <Button
              variant="ghost"
              style={{ padding: "12px 14px" }}
              onClick={() => onOpenTab("members")}
            >
              Manage invites
            </Button>
          )}
        </div>
      )}

      {!isOwner && !slotsFilled && (
        <div style={{ fontSize: 16, color: colors.muted, textAlign: "center" }}>
          The primary trustee compiles the vault once every member has joined.
        </div>
      )}
    </div>
  );
}

export function DraftCompileButton({ vault }: { vault: Vault }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.members.list(vault.id);
      setMembers(res.members);
    } catch {
      /* the Members tab will surface errors; keep this quiet */
    }
  }, [vault.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeRefresh(
    { table: "vault_members", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  const ready = members.filter(
    m => m.xpub && m.fingerprint && m.pubkey && m.derivation_path,
  );
  const foundersReady = ready.filter(m => m.role === "founder" || m.role === "owner").length;
  const heirsReady = ready.filter(m => m.role === "heir").length;
  const plannedF = vault.planned_founder_count ?? 0;
  const plannedH = vault.planned_heir_count ?? 0;
  // Bloc drafts have no vault_members rows at all -- they're single-owner,
  // keys come in directly through the wizard -- and no planned_founder/
  // heir_count either, so this readiness math doesn't apply to them at
  // all (plannedF would read 0 and slotsFilled would go true with zero
  // keys attached, offering a "Compile vault" button that calls the wrong
  // endpoint). Route Bloc drafts straight to the wizard instead.
  const isBloc = vault.bloc_policy != null;
  const slotsFilled = !isBloc && plannedF > 0 && foundersReady >= plannedF && heirsReady >= plannedH;

  async function compile() {
    setBusy(true);
    try {
      const res = await api.vaults.compile(vault.id);
      toast.success("Vault compiled -- ready to fund");
      autofillTrustDocIfEmpty(vault, res.vault);
      navigate(`/vaults/${res.vault.id}`, { state: { vault: res.vault } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Compile failed");
    } finally {
      setBusy(false);
    }
  }

  // "Continue setup" is the fix for the 2026-08-13 draft-save bug --
  // before this, a solo owner who picked keys in the wizard's Keys step
  // and hit "Save and finish later" landed here with no way back: this
  // button previously only understood the separate vault_members invite
  // flow, so an owner who brought their own keys directly (direct_keys
  // compile mode) had nothing to click. It always renders for a draft,
  // filled slots or not, and routes back into VaultWizard at the Keys
  // step for this same vault (VaultWizard.tsx's resumeVaultId effect).
  return (
    <div style={{ display: "flex", gap: 8, flex: 1 }}>
      {!isBloc && (
        <Button
          disabled={!slotsFilled || busy}
          style={{ flex: 1, padding: "12px", background: slotsFilled ? colors.green : undefined }}
          onClick={() => void compile()}
        >
          {busy
            ? "Compiling..."
            : slotsFilled
              ? "Compile vault"
              : `Waiting on ${plannedF - foundersReady} founder${plannedF - foundersReady === 1 ? "" : "s"}${plannedH > 0 ? `, ${plannedH - heirsReady} heir${plannedH - heirsReady === 1 ? "" : "s"}` : ""}`}
        </Button>
      )}
      <Button
        variant="ghost"
        style={isBloc ? { flex: 1, padding: "12px" } : { padding: "12px" }}
        onClick={() => navigate("/policy", { state: { resumeVaultId: vault.id } })}
      >
        Continue setup
      </Button>
    </div>
  );
}
