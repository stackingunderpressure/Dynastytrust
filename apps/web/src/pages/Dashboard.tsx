import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Vault, type BalanceResult } from "../lib/api";
import { useRealtimeRefresh } from "../lib/realtime";
import { colors, fonts, radii, space } from "../theme";
import { Button, Input, Label, Textarea } from "../components/ui";

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

export default function Dashboard() {
  const navigate = useNavigate();
  const openVault = (v: Vault) => navigate(`/vaults/${v.id}`, { state: { vault: v } });

  const [vaults, setVaults] = useState<Vault[]>([]);
  const [balances, setBalances] = useState<Record<string, BalanceResult>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<Vault | null>(null);

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
          .then(b => setBalances(prev => ({ ...prev, [v.id]: b })))
          .catch(() => {
            /* balance lookups are best-effort */
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

  const visible = liveVaults.filter(
    v =>
      !search ||
      v.name.toLowerCase().includes(search.toLowerCase()) ||
      (v.address ?? '').includes(search),
  );

  return (
    <div style={{ fontFamily: fonts.sans }}>
      <PendingFeed />
      {drafts.length > 0 && <DraftsSection drafts={drafts} />}

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <Input
          placeholder="Search vaults..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 180, padding: "8px 12px" }}
        />
        <Button size="sm" onClick={() => setShowCreate(true)}>
          + Add vault
        </Button>
      </div>

      {loading && <p style={{ color: colors.muted, fontSize: 14 }}>Loading...</p>}
      {error && <p style={{ color: colors.red, fontSize: 14 }}>{error}</p>}

      {!loading && visible.length === 0 && (
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
            Use the Policy Builder tab to compile your first vault.
          </p>
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 3 }}>{v.name}</div>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.1em",
                      padding: "3px 8px",
                      borderRadius: 4,
                      background: v.network === "bitcoin" ? "#2A1F0A" : "#0A1F14",
                      color: v.network === "bitcoin" ? colors.gold : colors.green,
                    }}
                  >
                    {v.network.toUpperCase()}
                  </span>
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
              {bal?.usd_value != null && (
                <div style={{ fontSize: 14, color: colors.sub, marginBottom: 8 }}>
                  ${bal.usd_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </div>
              )}
              <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, marginBottom: 12 }}>
                {v.address
                  ? `${v.address.slice(0, 14)}...${v.address.slice(-8)}`
                  : "Draft -- awaiting compile"}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", borderTop: "1px solid #1A1A28", paddingTop: 12 }}>
                <span style={{ fontSize: 11, color: colors.muted }}>
                  {v.founder_quorum}/{v.founder_keys.length} founders
                </span>
                <span style={{ fontSize: 11, color: colors.muted }}>
                  {v.heir_quorum}/{v.heir_keys.length} heirs
                </span>
                <span style={{ fontSize: 11, color: colors.muted }}>
                  Recovery {blocksToLabel(v.recovery_after)}
                </span>
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
        zIndex: 100,
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
          maxWidth,
          maxHeight: "90vh",
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
                {v.planned_founder_count ?? 0} founder
                {(v.planned_founder_count ?? 0) === 1 ? "" : "s"}
                {(v.planned_heir_count ?? 0) > 0
                  ? ` / ${v.planned_heir_count} heir${(v.planned_heir_count ?? 0) === 1 ? "" : "s"}`
                  : ""}
                {" / "}
                {v.network.toUpperCase()}
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
