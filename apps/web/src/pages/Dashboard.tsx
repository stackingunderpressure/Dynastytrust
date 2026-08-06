import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Vault, type BalanceResult } from "../lib/api";
import { useRealtimeRefresh } from "../lib/realtime";
import { colors, fonts, radii, space } from "../theme";
import { Button, Input, Label, Textarea } from "../components/ui";
import { useToast } from "../components/toast";
import { useConfirm } from "../components/dialog";
import { RemindersBanner } from "../components/RemindersBanner";

function satsToBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0";
}

function blocksToLabel(blocks: number): string {
  if (!blocks) return "--";
  const days = Math.round((blocks * 10) / 60 / 24);
  if (days < 30) return "~" + days + "d";
  if (days < 365) return "~" + Math.round(days / 30) + "mo";
  return "~" + (days / 365).toFixed(1) + "yr";
}

// Role-aware rendering. Each vault card surfaces the caller's role
// in the vault (owner/founder = trustee, heir = successor, etc.)
// and a one-line status tuned to that role so users see "what's
// mine to do" at a glance instead of a homogenous vault list.
function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case "owner": return "Primary Trustee";
    case "founder": return "Trustee";
    case "heir": return "Successor";
    case "protector": return "Protector";
    case "beneficiary": return "Beneficiary";
    case "viewer": return "Observer";
    default: return "Member";
  }
}

function roleAccent(role: string | null | undefined): string {
  switch (role) {
    case "owner":
    case "founder": return colors.gold;
    case "heir": return colors.green;
    case "protector": return colors.blue;
    case "beneficiary": return colors.orange;
    default: return colors.muted;
  }
}

// Sort vaults so roles that need action (trustees) land first.
function rolePriority(role: string | null | undefined): number {
  switch (role) {
    case "owner": return 0;
    case "founder": return 1;
    case "protector": return 2;
    case "beneficiary": return 3;
    case "heir": return 4;
    case "viewer": return 5;
    default: return 6;
  }
}

function roleStatus(v: Vault): string {
  switch (v.my_role) {
    case "owner":
    case "founder":
      return "You can sign now";
    case "heir":
      return v.inheritance_after
        ? `Inheritance unlocks in ${blocksToLabel(v.inheritance_after)}`
        : "Successor on standby";
    case "protector":
      return v.protector_after
        ? `Protector path unlocks in ${blocksToLabel(v.protector_after)}`
        : "Protector role (no timelock)";
    case "beneficiary":
      return v.consent_quorum
        ? "Consent required for spends"
        : "Beneficiary (view + receive)";
    case "viewer":
      return "Read-only access";
    default:
      return "";
  }
}

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const openVault = (v: Vault) => navigate(`/vaults/${v.id}`, { state: { vault: v } });

  const [vaults, setVaults] = useState<Vault[]>([]);
  const [balances, setBalances] = useState<Record<string, BalanceResult>>({});
  const [balanceErrors, setBalanceErrors] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showTrustCode, setShowTrustCode] = useState(false);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<Vault | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function deleteVault(v: Vault) {
    // Soft confirm on the Dashboard: fast path for clearing out test
    // vaults. VaultDetail still has the name-match guard for vaults
    // that actually hold funds.
    const ok = await confirm({
      title: "Delete vault",
      message: `Delete "${v.name}"? This removes the vault, its members, and all proposals. It cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setDeletingId(v.id);
    try {
      await api.vaults.remove(v.id);
      setVaults(prev => prev.filter(x => x.id !== v.id));
      toast.success(`Deleted ${v.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeletingId(null);
    }
  }

  const load = useCallback(async () => {
    try {
      setError(null);
      // Always list every vault the user is a member of -- archiving
      // was removed in favor of explicit delete.
      const { vaults } = await api.vaults.list(true);
      setVaults(vaults);
      for (const v of vaults) {
        if (!v.address) continue; // drafts have no address yet
        api
          .balance(v.address, v.network)
          .then(b => {
            setBalances(prev => ({ ...prev, [v.id]: b }));
            setBalanceErrors(prev => (prev[v.id] ? { ...prev, [v.id]: false } : prev));
          })
          .catch(() => {
            // Best-effort, but flag it so the card can say "unavailable"
            // instead of showing a permanent "--" that looks like 0 BTC.
            setBalanceErrors(prev => ({ ...prev, [v.id]: true }));
          });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const drafts = vaults.filter(v => v.status === 'draft');
  const liveVaults = vaults.filter(v => v.status !== 'draft');

  const visible = liveVaults
    .filter(
      v =>
        !search ||
        v.name.toLowerCase().includes(search.toLowerCase()) ||
        (v.address ?? '').includes(search),
    )
    // Actionable roles (trustee, protector) first so the user
    // sees "what's mine to do" before passive memberships.
    .sort((a, b) => rolePriority(a.my_role) - rolePriority(b.my_role));

  return (
    <div style={{ fontFamily: fonts.sans }}>
      <RemindersBanner />
      <RoleSummary vaults={vaults} />
      <PendingFeed />
      {drafts.length > 0 && <DraftsSection drafts={drafts} />}

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <Input
          placeholder="Search vaults..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 180, padding: "8px 12px" }}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowTrustCode(true)}
        >
          Join with trust code
        </Button>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          + Add vault
        </Button>
      </div>

      {loading && <p style={{ color: colors.muted, fontSize: 14 }}>Loading...</p>}
      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <p style={{ color: colors.red, fontSize: 14, margin: 0 }}>{error}</p>
          <Button variant="ghost" size="sm" onClick={() => { setLoading(true); void load(); }}>
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && visible.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "64px 24px",
            background: colors.surface,
            borderRadius: 14,
            border: `1px solid ${colors.border}`,
          }}
        >
          <p style={{ fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
            {search ? "No vaults match" : "No vaults yet"}
          </p>
          <p
            style={{
              color: colors.muted,
              fontSize: 14,
              maxWidth: 360,
              margin: "0 auto 24px",
            }}
          >
            {search
              ? "Try a different name or address."
              : "A vault is a Bitcoin wallet governed by your trust policy. Build your first one, or join an existing vault with a trust code."}
          </p>
          {!search && (
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <Button onClick={() => navigate("/policy")}>Build your first vault</Button>
              <Button variant="ghost" onClick={() => setShowTrustCode(true)}>
                Join with trust code
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="dt-responsive-grid">
        {visible.map(v => {
          const bal = balances[v.id];
          return (
            <div
              key={v.id}
              style={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderRadius: 14,
                padding: 20,
                cursor: "pointer",
                position: "relative",
              }}
              onClick={() => openVault(v)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 4, wordBreak: "break-word" }}>{v.name}</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.1em",
                        padding: "3px 8px",
                        borderRadius: 4,
                        background: v.network === "bitcoin" ? colors.badgeMainnet : colors.badgeTestnet,
                        color: v.network === "bitcoin" ? colors.gold : colors.green,
                      }}
                    >
                      {v.network.toUpperCase()}
                    </span>
                    {v.bloc_policy && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: "0.1em",
                          padding: "3px 8px",
                          borderRadius: 4,
                          background: colors.blue + "22",
                          color: colors.blue,
                        }}
                      >
                        BLOC
                      </span>
                    )}
                    {v.my_role && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: "0.08em",
                          padding: "3px 8px",
                          borderRadius: 4,
                          background: roleAccent(v.my_role) + "22",
                          color: roleAccent(v.my_role),
                          textTransform: "uppercase",
                        }}
                      >
                        {roleLabel(v.my_role)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  color: colors.text,
                  fontFamily: fonts.display,
                  marginBottom: 2,
                }}
              >
                {bal ? satsToBtc(bal.total_sats) : "--"}
                <span style={{ fontSize: 13, color: colors.muted }}> BTC</span>
              </div>
              {!bal && v.address && balanceErrors[v.id] && (
                <div style={{ fontSize: 11, color: colors.orange, marginBottom: 6 }}>
                  Balance unavailable -- mempool.space did not respond. Refresh to retry.
                </div>
              )}
              {bal?.usd_value != null && (
                <div style={{ fontSize: 14, color: colors.sub, marginBottom: 8 }}>
                  ${bal.usd_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </div>
              )}
              <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, marginBottom: 6 }}>
                {v.address
                  ? `${v.address.slice(0, 14)}...${v.address.slice(-8)}`
                  : "Draft -- awaiting compile"}
              </div>
              {roleStatus(v) && (
                <div style={{ fontSize: 12, color: roleAccent(v.my_role), marginBottom: 12 }}>
                  {roleStatus(v)}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", borderTop: `1px solid ${colors.divider}`, paddingTop: 12 }}>
                {v.bloc_policy ? (
                  <>
                    <span style={{ fontSize: 11, color: colors.muted }}>
                      {v.bloc_policy.parents_together_quorum} of {v.bloc_policy.parent_pubkeys.length} parents
                    </span>
                    <span style={{ fontSize: 11, color: colors.muted }}>
                      Decaying kids ladder to {v.bloc_policy.kids_decay_floor_quorum}
                    </span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 11, color: colors.muted }}>
                      {v.founder_quorum}/{v.founder_keys.length} founders
                    </span>
                    <span style={{ fontSize: 11, color: colors.muted }}>
                      {v.heir_quorum}/{v.heir_keys.length} heirs
                    </span>
                    <span style={{ fontSize: 11, color: colors.muted }}>
                      Recovery {blocksToLabel(v.recovery_after)}
                    </span>
                  </>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }} onClick={e => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="sm"
                  style={{ fontSize: 12, padding: "5px 10px" }}
                  onClick={() => setRenaming(v)}
                >
                  Rename
                </Button>
                {v.my_role === "owner" && (
                  <Button
                    variant="danger"
                    size="sm"
                    style={{ fontSize: 12, padding: "5px 10px" }}
                    disabled={deletingId === v.id}
                    onClick={() => deleteVault(v)}
                  >
                    {deletingId === v.id ? "Deleting..." : "Delete"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showCreate && (
        <CreateVaultModal
          onClose={() => setShowCreate(false)}
          onCreated={v => {
            setShowCreate(false);
            void load();
            openVault(v);
          }}
        />
      )}
      {showTrustCode && (
        <TrustCodeModal onClose={() => setShowTrustCode(false)} />
      )}
      {renaming && (
        <RenameModal
          vault={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function RenameModal({
  vault,
  onClose,
  onDone,
}: {
  vault: Vault;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(vault.name);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.vaults.rename(vault.id, name.trim());
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename vault");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} maxWidth={400}>
      <h2
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: colors.text,
          fontFamily: fonts.display,
          marginBottom: 20,
        }}
      >
        Rename vault
      </h2>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={e => setName(e.target.value)} required autoFocus />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

function CreateVaultModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (v: Vault) => void;
}) {
  const [name, setName] = useState("My Vault");
  const [network, setNetwork] = useState<"testnet" | "bitcoin">("testnet");
  const [address, setAddress] = useState("");
  const [descriptor, setDescriptor] = useState("");
  const [policy, setPolicy] = useState("");
  const [founderKeys, setFK] = useState("");
  const [heirKeys, setHK] = useState("");
  const [founderQ, setFQ] = useState(2);
  const [heirQ, setHQ] = useState(1);
  const [recovery, setRecovery] = useState(26000);
  const [inherit, setInherit] = useState(52560);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { vault } = await api.vaults.create({
        name,
        network,
        address,
        descriptor,
        miniscript_policy: policy,
        founder_quorum: founderQ,
        heir_quorum: heirQ,
        recovery_after: recovery,
        inheritance_after: inherit,
        founder_keys: founderKeys.split("\n").map(k => k.trim()).filter(Boolean),
        heir_keys: heirKeys.split("\n").map(k => k.trim()).filter(Boolean),
      });
      onCreated(vault);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} maxWidth={680}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: colors.text, fontFamily: fonts.display, margin: 0 }}>
          Add vault manually
        </h2>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: colors.muted, fontSize: 18, cursor: "pointer" }}
        >
          x
        </button>
      </div>
      <p style={{ fontSize: 13, color: colors.muted, marginBottom: 20, lineHeight: 1.5 }}>
        Paste in a pre-compiled vault. Use Policy Builder to compile one automatically.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 2 }}>
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div style={{ flex: 1 }}>
            <Label>Network</Label>
            <select
              value={network}
              onChange={e => setNetwork(e.target.value as "testnet" | "bitcoin")}
              style={{
                width: "100%",
                padding: "11px 13px",
                background: colors.input,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                color: colors.text,
                fontSize: 14,
                fontFamily: fonts.sans,
                boxSizing: "border-box",
              }}
            >
              <option value="testnet">Testnet</option>
            <option value="signet">Signet</option>
              <option value="bitcoin">Mainnet</option>
            </select>
          </div>
        </div>
        <div>
          <Label>Bitcoin address</Label>
          <Input mono value={address} onChange={e => setAddress(e.target.value)} required />
        </div>
        <div>
          <Label>Output descriptor</Label>
          <Textarea mono value={descriptor} onChange={e => setDescriptor(e.target.value)} required rows={3} />
        </div>
        <div>
          <Label>Miniscript policy</Label>
          <Textarea mono value={policy} onChange={e => setPolicy(e.target.value)} required rows={2} />
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Label>Founder keys (one per line)</Label>
            <Textarea mono value={founderKeys} onChange={e => setFK(e.target.value)} rows={3} />
          </div>
          <div style={{ flex: 1 }}>
            <Label>Heir keys (one per line)</Label>
            <Textarea mono value={heirKeys} onChange={e => setHK(e.target.value)} rows={3} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Label>Founder quorum</Label>
            <Input type="number" min={1} value={founderQ} onChange={e => setFQ(+e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <Label>Heir quorum</Label>
            <Input type="number" min={1} value={heirQ} onChange={e => setHQ(+e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <Label>Recovery (blocks)</Label>
            <Input type="number" value={recovery} onChange={e => setRecovery(+e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <Label>Inheritance (blocks)</Label>
            <Input type="number" value={inherit} onChange={e => setInherit(+e.target.value)} />
          </div>
        </div>
        {error && <p style={{ color: colors.red, fontSize: 13 }}>{error}</p>}
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Creating..." : "Create vault"}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

// Trust code = the invite token. Useful when a member already has
// a DynastyTrust account and prefers pasting a code to clicking a
// one-time URL (works on a signer device that's already signed in,
// and sidesteps the "I never made an account" drift that happens
// when the invite URL is clicked in a fresh browser).
function TrustCodeModal({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState("");
  const navigate = useNavigate();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    // The invite route lives at /invite/:token (path segment, not
    // query param). Earlier versions used ?token= and silently
    // routed nowhere; this is the form the rest of the UI generates.
    navigate(`/invite/${encodeURIComponent(trimmed)}`);
    onClose();
  }

  return (
    <ModalShell onClose={onClose} maxWidth={460}>
      <div style={{ fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 6, fontFamily: fonts.display }}>
        Join a vault with a trust code
      </div>
      <div style={{ fontSize: 13, color: colors.muted, marginBottom: 14, lineHeight: 1.5 }}>
        Paste the invite code a trustee sent you. You must already be signed in -- the code associates this account with your slot in the vault.
      </div>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <Label>Trust code</Label>
          <Input
            mono
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
            autoFocus
          />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!code.trim()}>Continue</Button>
        </div>
      </form>
    </ModalShell>
  );
}

function ModalShell({
  onClose,
  maxWidth,
  children,
}: {
  onClose: () => void;
  maxWidth: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Above the sticky header (z=100) and above any tab-strip
        // stacking context. The modal was rendering behind the
        // header's background on some mobile browsers, producing
        // a "blackout" where only the overlay showed.
        zIndex: 500,
        padding: space[4],
        overscrollBehavior: "contain",
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
          maxWidth,
          maxHeight: "90dvh",
          overflowY: "auto",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// // -- Pending proposals feed
// Shows non-terminal proposals across every vault the user is a
// member of. Lets members act without clicking through each vault.

// // -- Role summary (cross-vault)
// Rolls up "who am I across my portfolio" at the top of the
// dashboard: count of vaults per role, soonest upcoming unlock
// (recovery for trustees, protector for protectors, inheritance
// for heirs), so the user sees what's coming without drilling
// into each vault.

function RoleSummary({ vaults }: { vaults: Vault[] }) {
  if (vaults.length === 0) return null;

  // Bucket vaults by caller's role (owners count as trustees).
  const byRole: Record<string, Vault[]> = {
    trustee: [],
    heir: [],
    protector: [],
    beneficiary: [],
    viewer: [],
  };
  for (const v of vaults) {
    const r = v.my_role;
    if (r === "owner" || r === "founder") byRole.trustee.push(v);
    else if (r === "heir") byRole.heir.push(v);
    else if (r === "protector") byRole.protector.push(v);
    else if (r === "beneficiary") byRole.beneficiary.push(v);
    else if (r === "viewer") byRole.viewer.push(v);
  }

  const cards: { label: string; count: number; detail: string; color: string }[] = [];

  if (byRole.trustee.length) {
    // Trustees can always spend on Path 1 -- no timelock countdown
    // here; the PendingFeed component below shows the signing
    // queue.
    cards.push({
      label: "Trustee",
      count: byRole.trustee.length,
      detail:
        byRole.trustee.length === 1
          ? "1 vault · you can sign now"
          : `${byRole.trustee.length} vaults · you can sign now`,
      color: colors.gold,
    });
  }
  if (byRole.heir.length) {
    const soonest = byRole.heir
      .map(v => v.inheritance_after)
      .filter(n => n > 0)
      .sort((a, b) => a - b)[0];
    cards.push({
      label: "Successor",
      count: byRole.heir.length,
      detail: soonest
        ? `soonest inheritance in ${blocksToLabel(soonest)}`
        : `${byRole.heir.length} vault${byRole.heir.length === 1 ? "" : "s"}`,
      color: colors.green,
    });
  }
  if (byRole.protector.length) {
    const soonest = byRole.protector
      .map(v => v.protector_after ?? 0)
      .filter(n => n > 0)
      .sort((a, b) => a - b)[0];
    cards.push({
      label: "Protector",
      count: byRole.protector.length,
      detail: soonest
        ? `soonest path unlocks in ${blocksToLabel(soonest)}`
        : `${byRole.protector.length} vault${byRole.protector.length === 1 ? "" : "s"}`,
      color: colors.blue,
    });
  }
  if (byRole.beneficiary.length) {
    const gated = byRole.beneficiary.filter(v => v.consent_quorum).length;
    cards.push({
      label: "Beneficiary",
      count: byRole.beneficiary.length,
      detail: gated
        ? `${gated} vault${gated === 1 ? "" : "s"} require your consent`
        : "passive beneficiary",
      color: colors.orange,
    });
  }
  if (byRole.viewer.length) {
    cards.push({
      label: "Observer",
      count: byRole.viewer.length,
      detail:
        byRole.viewer.length === 1
          ? "1 vault · read-only"
          : `${byRole.viewer.length} vaults · read-only`,
      color: colors.muted,
    });
  }

  if (cards.length === 0) return null;

  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: colors.muted,
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        Your portfolio
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(200px, 100%), 1fr))",
          gap: 10,
        }}
      >
        {cards.map(c => (
          <div
            key={c.label}
            style={{
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderLeft: `3px solid ${c.color}`,
              borderRadius: 10,
              padding: "10px 14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: colors.text, fontFamily: fonts.display }}>
                {c.count}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  color: c.color,
                  textTransform: "uppercase",
                }}
              >
                {c.label}
              </span>
            </div>
            <div style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>
              {c.detail}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type PendingProposal = Awaited<ReturnType<typeof api.proposalsMine>>["proposals"][number];

function PendingFeed() {
  const navigate = useNavigate();
  const [items, setItems] = useState<PendingProposal[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    api
      .proposalsMine()
      .then(res => setItems(res.proposals))
      .catch(() => {
        /* silent; feed is optional */
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Refresh on any proposal or signature change across all vaults.
  useRealtimeRefresh({ table: "proposals", channel: "pending-feed:proposals" }, reload);
  useRealtimeRefresh({ table: "signer_sessions", channel: "pending-feed:sigs" }, reload);

  if (!loaded || items.length === 0) return null;

  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: colors.orange,
          marginBottom: 10,
          textTransform: "uppercase",
        }}
      >
        Waiting for your signature ({items.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map(p => (
          <PendingRow
            key={p.id}
            item={p}
            onOpen={() => navigate(`/vaults/${p.vault_id}/proposals/${p.id}`)}
          />
        ))}
      </div>
    </div>
  );
}

function PendingRow({ item, onOpen }: { item: PendingProposal; onOpen: () => void }) {
  const amount = (item.amount_sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0";
  const signed = (item.signer_sessions ?? []).filter(s => s.signed).length;
  const quorum = item.vault.founder_quorum;
  return (
    <div
      onClick={onOpen}
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${colors.orange}`,
        borderRadius: 12,
        padding: "12px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        cursor: "pointer",
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
          {item.vault.name}
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>
          Send {amount} BTC
          {item.destination ? ` to ${item.destination.slice(0, 8)}...${item.destination.slice(-6)}` : ""}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 12, color: colors.orange, fontWeight: 600 }}>
          {signed} / {quorum} signed
        </div>
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>
          {item.vault.network.toUpperCase()}
        </div>
      </div>
    </div>
  );
}

// // -- Drafts section
// Vaults in status='draft' -- either the owner hasn't compiled yet
// or co-signers haven't all provisioned their keys. One row per
// draft; clicking goes straight to the vault.

function DraftsSection({ drafts }: { drafts: Vault[] }) {
  const navigate = useNavigate();
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: colors.gold,
          marginBottom: 10,
          textTransform: "uppercase",
        }}
      >
        Drafts in progress ({drafts.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {drafts.map(v => (
          <div
            key={v.id}
            onClick={() =>
              navigate(`/vaults/${v.id}`, { state: { vault: v } })
            }
            style={{
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderLeft: `3px solid ${colors.gold}`,
              borderRadius: 12,
              padding: "12px 16px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              cursor: "pointer",
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
                {v.name}
              </div>
              <div style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>
                {v.bloc_policy ? (
                  <>Dynasty Bloc / {v.network.toUpperCase()}</>
                ) : (
                  <>
                    {v.planned_founder_count ?? 0} founder
                    {(v.planned_founder_count ?? 0) === 1 ? "" : "s"}
                    {(v.planned_heir_count ?? 0) > 0
                      ? ` / ${v.planned_heir_count} heir${(v.planned_heir_count ?? 0) === 1 ? "" : "s"}`
                      : ""}
                    {" / "}
                    {v.network.toUpperCase()}
                  </>
                )}
              </div>
            </div>
            <div style={{ fontSize: 11, color: colors.gold, fontWeight: 600 }}>
              DRAFT
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
