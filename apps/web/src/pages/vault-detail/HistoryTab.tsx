import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Vault, type Proposal } from "../../lib/api";
import { explorerTxUrl } from "../../config";
import { useToast } from "../../components/toast";
import { useConfirm } from "../../components/dialog";
import { colors, fonts, } from "../../theme";
import { Button } from "../../components/ui";
import { txConfirmations } from "../../lib/chain";
import { satsToBtc, statusColor } from "./shared";


// // -- History tab

export function HistoryTab({
  vault,
  proposals,
  onRefresh,
}: {
  vault: Vault;
  proposals: Proposal[];
  onRefresh: () => void;
}) {
  if (proposals.length === 0) {
    return <p style={{ color: colors.muted, fontSize: 17 }}>No transactions yet.</p>;
  }
  // A proposal still waiting on signatures or broadcast is the thing the
  // operator actually needs to act on -- it should never sit buried below
  // old, finished (broadcast/cancelled) history just because those happen
  // to be more recent rows. Active first (newest first within that group),
  // then finished (newest first).
  const sorted = [...proposals].sort((a, b) => {
    const aTerminal = a.status === "broadcast" || a.status === "cancelled";
    const bTerminal = b.status === "broadcast" || b.status === "cancelled";
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {sorted.map(p => (
        <ProposalCard key={p.id} proposal={p} vault={vault} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

function signerRoleLabel(role: string): string {
  if (role === "founder") return "Founder";
  if (role === "heir") return "Heir";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function ProposalCard({
  proposal: p,
  vault,
  onRefresh,
}: {
  proposal: Proposal;
  vault: Vault;
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const sc = statusColor(p.status);
  const terminal = p.status === "broadcast" || p.status === "cancelled";
  const isTrancheClaim = p.path === "tranche_claim";

  async function cancelProposal() {
    if (!(await askConfirm({
      title: "Cancel proposal",
      message: "Cancel this proposal? Collected signatures will be discarded.",
      confirmLabel: "Cancel proposal",
      danger: true,
    }))) return;
    setCancelling(true);
    try {
      await api.proposals.update(p.id, { status: "cancelled" });
      toast.success("Proposal cancelled");
      onRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to cancel");
    } finally {
      setCancelling(false);
    }
  }

  // Confirmation count for a broadcast spend -- fetched straight from
  // mempool.space (txConfirmations), same as the countdown timers
  // elsewhere on this page. null while loading/unknown, 0 means
  // broadcast but still unconfirmed. Polled every 30s only while this
  // proposal is still short of the 6-confirmation "settled" mark most
  // wallets treat as final -- no point re-fetching forever once it's
  // deep enough that another confirmation doesn't change anything the
  // owner needs to see.
  const [confirmations, setConfirmations] = useState<number | null>(null);
  useEffect(() => {
    if (p.status !== "broadcast" || !p.txid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        const n = await txConfirmations(vault.network, p.txid!);
        if (cancelled) return;
        setConfirmations(n);
        if (n !== null && n < 6) timer = setTimeout(() => void poll(), 30_000);
      } catch {
        // best-effort -- the row just won't show a count
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [vault.network, p.status, p.txid]);

  return (
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
          padding: "14px 16px",
          cursor: "pointer",
        }}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: sc }} />
          <div>
            <div
              style={{
                fontSize: 17,
                fontWeight: 600,
                color: colors.text,
                fontFamily: fonts.display,
              }}
            >
              {satsToBtc(p.amount_sats)} BTC
            </div>
            <div style={{ fontSize: 15, color: colors.muted }}>
              {new Date(p.created_at).toLocaleDateString()}
              {p.status === "broadcast" && (
                <>
                  {" · "}
                  {confirmations == null
                    ? "checking confirmations..."
                    : confirmations === 0
                      ? "unconfirmed"
                      : confirmations < 6
                        ? `${confirmations} confirmation${confirmations === 1 ? "" : "s"}`
                        : `${confirmations} confirmations ✓`}
                </>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: "0.06em",
              padding: "3px 8px",
              borderRadius: 4,
              background: `${sc}22`,
              color: sc,
              textTransform: "uppercase",
            }}
          >
            {p.status}
          </span>
          <span
            style={{
              color: colors.muted,
              fontSize: 16,
              padding: 8,
              margin: -8,
              lineHeight: 1,
            }}
          >
            {expanded ? "^" : "v"}
          </span>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${colors.border}` }}>
          <div
            style={{
              fontSize: 16,
              color: colors.muted,
              marginBottom: 8,
              marginTop: 12,
              fontFamily: fonts.mono,
              wordBreak: "break-all",
            }}
          >
            To: {p.destination}
          </div>
          {p.memo && (
            <div style={{ fontSize: 16, color: colors.sub, marginBottom: 8 }}>
              Note: {p.memo}
            </div>
          )}
          {!terminal && p.signer_sessions && p.signer_sessions.length > 0 && (
            <div
              style={{
                marginBottom: 10,
                padding: 10,
                borderRadius: 8,
                background: colors.inset,
                border: `1px solid ${colors.border}`,
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
                {p.signer_sessions.filter(s => s.signed).length} of {p.signer_sessions.length} signed
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {p.signer_sessions.map(s => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      fontSize: 16,
                    }}
                  >
                    <span style={{ color: colors.sub }}>
                      {s.label || signerRoleLabel(s.signer_role)} <span style={{ color: colors.muted }}>({signerRoleLabel(s.signer_role)})</span>
                    </span>
                    <span style={{ color: s.signed ? colors.green : colors.muted, fontWeight: 600 }}>
                      {s.signed ? "Signed" : "Waiting"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {p.txid && (
            <a
              href={explorerTxUrl(vault.network, p.txid)}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 17, color: colors.gold, textDecoration: "none" }}
            >
              View on mempool.space
            </a>
          )}
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              variant={terminal ? "ghost" : "primary"}
              size="sm"
              style={{ fontSize: 16 }}
              onClick={() => navigate(`/vaults/${vault.id}/proposals/${p.id}`)}
            >
              {terminal ? "View votes & history" : "Sign / manage"}
            </Button>
            {p.psbt_hex && (
              <Button
                variant="ghost"
                size="sm"
                style={{ fontSize: 16 }}
                onClick={() => navigator.clipboard.writeText(p.psbt_hex!)}
              >
                Copy PSBT
              </Button>
            )}
            {!terminal && !isTrancheClaim && (
              <Button
                variant="danger"
                size="sm"
                disabled={cancelling}
                style={{ fontSize: 16 }}
                onClick={() => void cancelProposal()}
              >
                {cancelling ? "Cancelling..." : "Cancel"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
