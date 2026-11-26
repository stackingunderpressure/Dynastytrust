import { useEffect, useState, useCallback } from "react";
import { PANEL_FIT } from "../../components/ui/panelFit";
import { api, type Vault, type VaultMember, type VaultInvite } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { listKeys } from "../../lib/keystore";
import { keyNetworkMatches } from "../../lib/network";
import { fetchTapitDisplayNames } from "../../lib/tapit-profile-lookup";
import { useToast } from "../../components/toast";
import { useConfirm } from "../../components/dialog";
import { colors, fonts, radii, space } from "../../theme";
import { Button, Input, Label } from "../../components/ui";
import { useRealtimeRefresh } from "../../lib/realtime";
import { pubkeyFromXpub } from "../../lib/xpub";
import { inviteLink } from "../../lib/invite-link";
import { VaultMembershipSetup } from "../../components/VaultMembershipSetup";
import { InviteModal, InviteRow } from "./Invites";
import { roleLabel } from "./shared";


// // -- Members tab

export function MembersTab({ vault }: { vault: Vault }) {
  const toast = useToast();
  const askConfirm = useConfirm();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [invites, setInvites] = useState<VaultInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [recentLink, setRecentLink] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [showMyKey, setShowMyKey] = useState(false);
  const [memberTapitNames, setMemberTapitNames] = useState<Map<string, string>>(new Map());

  // Resolve each member's real Tapit identity the same way the Spending
  // paths card already does (2026-08-15, operator: "the name showing up...
  // not showing up as the actual identity. The name the person put in that
  // would be cool"). vault_members.label is whatever the vault owner typed
  // in when adding them -- often stale or a placeholder -- while the
  // person's own Tapit wallet publishes a self-authored kind-0 name. Both
  // still render (see MemberRow): the resolved identity leads, the local
  // label follows as a parenthetical so a mismatch is visible rather than
  // silently overwritten.
  const memberPubkeysKey = members.map(m => m.pubkey).filter((p): p is string => !!p).join(",");
  useEffect(() => {
    let cancelled = false;
    if (memberPubkeysKey.length === 0) { setMemberTapitNames(new Map()); return; }
    fetchTapitDisplayNames(memberPubkeysKey.split(","))
      .then(names => { if (!cancelled) setMemberTapitNames(names); })
      .catch(() => { /* best-effort -- members fall back to their local label */ });
    return () => { cancelled = true; };
  }, [memberPubkeysKey]);

  // "Make sure there's no branch work left over somewhere" -- a member
  // whose pubkey doesn't appear in any of the vault's current compiled
  // leaves is either mid-invite (no key uploaded yet, pubkey is null and
  // this correctly doesn't flag them) or a leftover: the vault was
  // recompiled with a different key set after they joined, or their key
  // was swapped out, and this app-access row never got cleaned up to
  // match. Owner-only path stays exempt -- an owner always has founder
  // standing even before their key is on file.
  const compiledPubkeys = new Set([
    ...vault.founder_keys, ...vault.heir_keys,
    ...vault.backup_keys, ...vault.consent_keys, ...vault.second_heir_keys,
  ]);
  const staleMembers = members.filter(
    m => m.role !== "owner" && m.status === "active" && m.pubkey && !compiledPubkeys.has(m.pubkey),
  );

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSessionUserId(data.session?.user?.id ?? null);
    });
  }, []);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [m, i] = await Promise.allSettled([
        api.members.list(vault.id),
        api.invites.list(vault.id),
      ]);
      if (m.status === "fulfilled") setMembers(m.value.members);
      // Invite list is owner-only; non-owner members get 403 here, which
      // is expected and not an error.
      if (i.status === "fulfilled") setInvites(i.value.invites);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [vault.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates when someone joins or a new invite lands.
  useRealtimeRefresh(
    { table: "vault_members", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );
  useRealtimeRefresh(
    { table: "vault_invites", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  async function revoke(invite: VaultInvite) {
    if (!(await askConfirm({ title: "Revoke invite", message: "Revoke this invite? The link will stop working and the recipient won't be able to join with it.", confirmLabel: "Revoke", danger: true }))) return;
    try {
      await api.invites.revoke(invite.id);
      toast.success("Invite revoked");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke invite");
    }
  }

  async function removeMember(m: VaultMember) {
    if (m.role === "owner") return;
    if (!(await askConfirm({ title: "Remove member", message: `Remove ${m.label ?? "this member"} from the vault? If the vault is already compiled their key stays in the on-chain policy; this only removes their app access.`, confirmLabel: "Remove", danger: true }))) return;
    try {
      await api.members.remove(m.id);
      toast.success("Member removed");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove member");
    }
  }

  if (loading) return <p style={{ color: colors.muted, fontSize: 17 }}>Loading members...</p>;
  if (err) return <p style={{ color: colors.red, fontSize: 17 }}>{err}</p>;

  const pendingInvites = invites.filter(i => !i.claimed_at && new Date(i.expires_at).getTime() > Date.now());
  const myself = members.find(m => m.user_id === sessionUserId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {vault.status === "compiled" && (
        <VaultMembershipSetup
          vaultId={vault.id}
          vaultDescriptor={vault.descriptor}
          vaultName={vault.name}
          founderKeys={vault.founder_keys}
          heirKeys={vault.heir_keys}
          backupKeys={vault.backup_keys}
          consentKeys={vault.consent_keys}
          secondHeirKeys={vault.second_heir_keys}
          leaves={vault.leaves}
          leafScripts={vault.leaf_scripts}
          vaultMultipath={vault.descriptor_version === 2 ? vault.descriptor_multipath : null}
          changeVault={vault}
          keyLabels={vault.key_labels}
          isOwner={sessionUserId === vault.user_id}
        />
      )}
      {myself && (
        <YourMembershipCard
          me={myself}
          vault={vault}
          onEdit={() => setShowMyKey(true)}
        />
      )}
      {recentLink && (
        <div
          style={{
            padding: "12px 14px",
            background: `${colors.gold}11`,
            border: `1px solid ${colors.gold}44`,
            borderRadius: radii.md,
            fontSize: 17,
            color: colors.sub,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div>Share this link with the new signer. They have 14 days to claim.</div>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 15,
              background: colors.inset,
              padding: "8px 10px",
              borderRadius: radii.sm,
              wordBreak: "break-all",
            }}
          >
            {recentLink}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(recentLink);
                toast.success("Link copied");
              }}
            >
              Copy link
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRecentLink(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Members list */}
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>
            Members ({members.length})
          </div>
          <Button size="sm" onClick={() => setShowInvite(true)}>
            + Invite
          </Button>
        </div>
        {members.map(m => (
          <MemberRow
            key={m.id}
            member={m}
            tapitName={m.pubkey ? memberTapitNames.get(m.pubkey) : undefined}
            stale={staleMembers.some(sm => sm.id === m.id)}
            vaultCompiled={vault.status !== "draft"}
            onRemove={() => void removeMember(m)}
          />
        ))}
      </div>

      {staleMembers.length > 0 && (
        <div
          style={{
            background: `${colors.gold}0d`,
            border: `1px solid ${colors.gold}44`,
            borderRadius: 12,
            padding: "12px 16px",
            fontSize: 16,
            color: colors.sub,
          }}
        >
          <div style={{ fontWeight: 600, color: colors.gold, marginBottom: 4 }}>
            {staleMembers.length} member{staleMembers.length === 1 ? "" : "s"} out of sync with the compiled vault
          </div>
          <div>
            {staleMembers.map(m => m.label ?? "Unlabeled").join(", ")} still {staleMembers.length === 1 ? "has" : "have"} app
            access here, but their key isn't in this vault's current compiled leaves -- either the vault was recompiled with a
            different key set since they joined, or their key changed. Remove their access below if they no longer belong, or
            have them re-add their current key if they do.
          </div>
        </div>
      )}

      {/* Pending invites */}
      {pendingInvites.length > 0 && (
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: `1px solid ${colors.border}`,
              fontSize: 17,
              fontWeight: 600,
              color: colors.text,
            }}
          >
            Pending invites ({pendingInvites.length})
          </div>
          {pendingInvites.map(inv => (
            <InviteRow
              key={inv.id}
              invite={inv}
              onCopyLink={() => {
                const url = inviteLink(inv.token, { vaultName: vault.name, label: inv.invited_label ?? undefined });
                navigator.clipboard.writeText(url);
                toast.success("Link copied");
              }}
              onCopyCode={() => {
                navigator.clipboard.writeText(inv.token);
                toast.success("Trust code copied");
              }}
              onRevoke={() => void revoke(inv)}
            />
          ))}
        </div>
      )}

      {showInvite && (
        <InviteModal
          vault={vault}
          onClose={() => setShowInvite(false)}
          onCreated={invite => {
            setShowInvite(false);
            setRecentLink(inviteLink(invite.token, { vaultName: vault.name, label: invite.invited_label ?? undefined }));
            void load();
          }}
        />
      )}
      {showMyKey && myself && (
        <MyKeyModal
          vault={vault}
          me={myself}
          onClose={() => setShowMyKey(false)}
          onSaved={() => {
            setShowMyKey(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

// The vault's own signing keys (as pubkey hex) that this browser holds a
// local key for. The owner's member row carries no key of its own when the
// keys went straight into the vault (the path builder, and the standard
// wizard's direct keys), so "no key on your row" is not "you can't sign":
// what decides it is whether any of the vault's keys are here.
function vaultKeysHeldHere(vault: Vault): { held: number; total: number } {
  const all = new Set<string>();
  const add = (x: unknown) => {
    if (typeof x !== "string") return;
    if (/^0[23][0-9a-fA-F]{64}$/.test(x)) { all.add(x.toLowerCase()); return; }
    try { all.add(pubkeyFromXpub(x).toLowerCase()); } catch { /* not a key */ }
  };
  for (const leaf of vault.leaves ?? []) {
    leaf.keys.forEach(add);
    (leaf.required_keys ?? []).forEach(add);
  }
  for (const list of [vault.founder_keys, vault.heir_keys, vault.backup_keys, vault.second_heir_keys, vault.consent_keys]) {
    (list ?? []).forEach(add);
  }
  vault.bloc_policy?.parent_pubkeys.forEach(add);
  vault.bloc_policy?.kid_pubkeys.forEach(add);
  const here = new Set(
    listKeys().filter(k => k.status === "active" && k.origin !== "tapit").map(k => k.pubkey.toLowerCase()),
  );
  let held = 0;
  for (const pk of all) if (here.has(pk)) held++;
  return { held, total: all.size };
}

// YourMembershipCard -- shown at the top of the Members tab for the
// current user. Makes it unambiguous which member row is "you" and
// gives a one-click path to update the xpub when a member claimed
// without providing one (or needs to rotate their key).
function YourMembershipCard({
  me,
  vault,
  onEdit,
}: {
  me: VaultMember;
  vault: Vault;
  onEdit: () => void;
}) {
  const hasKey = !!me.xpub && !!me.fingerprint && !!me.pubkey && !!me.derivation_path;
  const netLabel = vault.network.toUpperCase();
  // The owner who put the keys straight into the vault: say how many of
  // them are on this device instead of "no key yet" (signet walk
  // 2026-11-19: the dashboard said "You can sign now" while this card said
  // the opposite, for keys generated in this very browser).
  const ownerKeys = !hasKey && me.role === "owner" ? vaultKeysHeldHere(vault) : null;
  if (ownerKeys) {
    const some = ownerKeys.held > 0;
    return (
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderLeft: `3px solid ${some ? colors.green : colors.orange}`,
          borderRadius: 12,
          padding: "14px 16px",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: colors.gold, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Your slot
        </div>
        <div style={{ fontSize: 17, color: colors.text, marginTop: 2 }}>
          {me.label ?? "Unnamed"} <span style={{ color: colors.muted }}>({roleLabel(me.role)})</span>
        </div>
        <div style={{ fontSize: 16, color: some ? colors.sub : colors.orange, marginTop: 4 }}>
          {some
            ? `${ownerKeys.held} of this vault's ${ownerKeys.total} keys ${ownerKeys.held === 1 ? "is" : "are"} on this device -- you can sign with ${ownerKeys.held === 1 ? "it" : "them"} here.`
            : `None of this vault's ${ownerKeys.total} keys are on this device. To sign here, restore one in Keys, or sign with the hardware wallet that holds it.`}
        </div>
      </div>
    );
  }
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${hasKey ? colors.green : colors.orange}`,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: colors.gold, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Your slot
        </div>
        <div style={{ fontSize: 17, color: colors.text, marginTop: 2 }}>
          {me.label ?? "Unnamed"} <span style={{ color: colors.muted }}>({roleLabel(me.role)})</span>
        </div>
        <div style={{ fontSize: 16, color: hasKey ? colors.sub : colors.orange, marginTop: 4 }}>
          {hasKey
            ? `Key ready -- fingerprint ${me.fingerprint} on ${netLabel}`
            : `No key yet -- you won't be able to sign until you add one`}
        </div>
      </div>
      <Button size="sm" variant={hasKey ? "ghost" : "primary"} onClick={onEdit}>
        {hasKey ? "Change key" : "Add your key"}
      </Button>
    </div>
  );
}

// MyKeyModal -- lets the current member attach or replace the key
// material on their own vault_members row. Reads from the browser
// keystore and calls api.members.update() to PATCH the row.
function MyKeyModal({
  vault,
  me,
  onClose,
  onSaved,
}: {
  vault: Vault;
  me: VaultMember;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string>("");
  const [label, setLabel] = useState(me.label ?? "");
  const [busy, setBusy] = useState(false);
  const eligibleKeys = listKeys().filter(
    k => k.status === "active" && keyNetworkMatches(k.network, vault.network),
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) {
      toast.error("Pick a key to attach to your slot");
      return;
    }
    const chosen = eligibleKeys.find(k => k.keyId === selectedId);
    if (!chosen) return;
    setBusy(true);
    try {
      await api.members.update(me.id, {
        label: label.trim() || undefined,
        xpub: chosen.xpub,
        fingerprint: chosen.masterFingerprint ?? chosen.fingerprint,
        pubkey: chosen.pubkey,
        derivation_path: chosen.derivationPath,
        key_label: chosen.label,
      }, vault.id);
      toast.success("Key attached to your slot");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 500,
        padding: space[4],
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: "24px 28px",
          width: "100%",
          maxWidth: 480,
          ...PANEL_FIT,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
          {me.xpub ? "Change your key" : "Add your key"}
        </div>
        <p style={{ fontSize: 17, color: colors.sub, lineHeight: 1.5, marginBottom: 14 }}>
          Pick an {vault.network.toUpperCase()} key from your local keystore to
          attach to your slot in {vault.name}. Private material stays in this
          browser -- only the xpub and derivation metadata go to the server.
        </p>
        {eligibleKeys.length === 0 ? (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              background: colors.input,
              color: colors.orange,
              fontSize: 17,
              marginBottom: 12,
            }}
          >
            No active {vault.network.toUpperCase()} keys in your keystore.
            Open the Keys tab first to generate or import one.
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <Label>Your display label</Label>
              <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={me.label ?? "Your name"} />
            </div>
            <div>
              <Label>Key to attach</Label>
              <select
                value={selectedId}
                onChange={e => setSelectedId(e.target.value)}
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
                <option value="">-- pick a key --</option>
                {eligibleKeys.map(k => (
                  <option key={k.keyId} value={k.keyId}>
                    {k.label} -- {k.fingerprint}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !selectedId}>
                {busy ? "Saving..." : me.xpub ? "Replace key" : "Attach key"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function MemberRow({
  member: m,
  tapitName,
  stale,
  vaultCompiled,
  onRemove,
}: {
  member: VaultMember;
  /** The owner's own row carries no key when the keys went straight into
   *  the vault, so on a compiled vault it is not "no key yet". */
  vaultCompiled?: boolean;
  /** The person's own chosen identity from their Tapit wallet's kind-0
   *  profile, if their key resolved to one. Leads the row when present;
   *  m.label (the owner-typed local label) follows as a parenthetical. */
  tapitName?: string;
  /** True when this member's key isn't in the vault's current compiled
   *  leaves -- see the "no branch work left over" audit in MembersTab. */
  stale?: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div>
        <div style={{ fontSize: 17, fontWeight: 500, color: colors.text }}>
          {tapitName ?? m.label ?? "Unnamed"}
          {tapitName && m.label && tapitName !== m.label && (
            <span style={{ fontWeight: 400, color: colors.muted }}> ({m.label})</span>
          )}
          {m.role === "owner" && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 14,
                fontWeight: 700,
                padding: "2px 6px",
                borderRadius: 4,
                background: `${colors.gold}22`,
                color: colors.gold,
                letterSpacing: "0.06em",
              }}
            >
              PRIMARY TRUSTEE
            </span>
          )}
          {stale && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 14,
                fontWeight: 700,
                padding: "2px 6px",
                borderRadius: 4,
                background: `${colors.gold}22`,
                color: colors.gold,
                letterSpacing: "0.06em",
              }}
            >
              KEY OUT OF SYNC
            </span>
          )}
        </div>
        <div style={{ fontSize: 15, color: colors.muted }}>
          {roleLabel(m.role)}
          {m.fingerprint
            ? ` / ${m.fingerprint}`
            : m.role === "owner" && vaultCompiled
              // Signet walk 2026-11-19: "Primary trustee / no key yet" on a
              // vault whose 3 keys were all on this device.
              ? " / keys set in the vault"
              : " / no key yet"}
        </div>
      </div>
      {m.role !== "owner" && (
        <Button variant="ghost" size="sm" style={{ fontSize: 16 }} onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  );
}
