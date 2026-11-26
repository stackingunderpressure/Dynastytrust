import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Vault, type Proposal, type VaultRequest, type ScheduledStipend } from "../../lib/api";
import { listKeys } from "../../lib/keystore";
import { colors, radii, } from "../../theme";
import { Button } from "../../components/ui";
import { tipHeight } from "../../lib/chain";
import { durationWords, pathMoments } from "../../lib/timelock-words";
import { SendPrefill } from "./SendTab";
import { blocksToLabel, satsToBtc } from "./shared";


// // -- Timelock countdown
// Fetches the mempool.space tip block height and renders a live
// countdown for the recovery and inheritance branches. Refreshes
// every minute silently.

// // -- ActionGuide
// Role-aware "today's actions" strip at the top of the vault
// overview. Distills what's on the caller's plate into one concrete
// CTA per row so a trustee doesn't have to scan proposals +
// requests + stipends tabs to find out there's work pending.
//
// Data sources: proposals passed down from VaultDetailInner;
// stipends + requests fetched locally (small per-vault lists).
// Timelock countdowns computed against the stored absolute CLTV
// heights (tip from mempool.space via lib/chain.ts).

interface ActionItem {
  key: string;
  label: string;
  detail: string;
  cta: string;
  severity: "warn" | "info" | "danger";
  onClick: () => void;
}

export function ActionGuide({
  vault,
  proposals,
  onOpenTab,
  onSendPrefill,
}: {
  vault: Vault;
  proposals: Proposal[];
  onOpenTab: (id: string) => void;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  const navigate = useNavigate();
  const [stipends, setStipends] = useState<ScheduledStipend[]>([]);
  const [requests, setRequests] = useState<VaultRequest[]>([]);
  const [tip, setTip] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.stipends
      .list(vault.id)
      .then(r => !cancelled && setStipends(r.stipends))
      .catch(() => {});
    api.vaultRequests
      .list(vault.id)
      .then(r => !cancelled && setRequests(r.requests))
      .catch(() => {});
    if (vault.network) {
      tipHeight(vault.network)
        .then(h => !cancelled && setTip(h))
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [vault.id, vault.network]);

  const role = (vault as Vault & { my_role?: string }).my_role;
  const isTrustee = role === "owner" || role === "founder";
  const isBeneficiary = role === "beneficiary";
  const isHeir = role === "heir";

  const now = Date.now();
  const overdueStipends = stipends.filter(
    s => s.active && new Date(s.next_due_at).getTime() <= now,
  );
  const pendingRequests = requests.filter(r => r.status === "pending");
  const pendingProposals = proposals.filter(
    p => p.status !== "broadcast" && p.status !== "cancelled",
  );

  const blocksLeftToUnlock = (abs: number | null | undefined) => {
    if (!abs || abs <= 0 || tip == null) return null;
    return Math.max(0, abs - tip);
  };
  const approachingDays = 60 * 24 * 6; // ~60 days in blocks
  const recoveryLeft = blocksLeftToUnlock(vault.recovery_after);
  const inheritanceLeft = blocksLeftToUnlock(vault.inheritance_after);

  const items: ActionItem[] = [];

  if (isTrustee) {
    if (pendingProposals.length > 0) {
      items.push({
        key: "trustee-sign",
        label: `${pendingProposals.length} proposal${pendingProposals.length === 1 ? "" : "s"} awaiting signatures`,
        // "Go to Send" used to open a BLANK new-send form, not the spend
        // that is waiting. One waiting: open it. Several: the History tab
        // lists them.
        detail: pendingProposals.length === 1 ? "Open it to check the details and add your signature." : "Open History to see each one and add your signature.",
        cta: pendingProposals.length === 1 ? "Open it" : "See them",
        severity: "warn",
        onClick: () =>
          pendingProposals.length === 1
            ? navigate(`/vaults/${vault.id}/proposals/${pendingProposals[0].id}`)
            : onOpenTab("history"),
      });
    }
    if (pendingRequests.length > 0) {
      items.push({
        key: "trustee-requests",
        label: `${pendingRequests.length} distribution request${pendingRequests.length === 1 ? "" : "s"} pending review`,
        detail: "A beneficiary has asked for funds. Approve, deny, or ask for more info.",
        cta: "Review requests",
        severity: "warn",
        onClick: () => onOpenTab("requests"),
      });
    }
    if (overdueStipends.length > 0) {
      const first = overdueStipends[0];
      items.push({
        key: "trustee-stipends",
        label: `${overdueStipends.length} stipend${overdueStipends.length === 1 ? " is" : "s are"} overdue`,
        detail: `Next: "${first.name}" for ${satsToBtc(first.amount_sats)} BTC.`,
        cta: "Send now",
        severity: "warn",
        onClick: () =>
          onSendPrefill({
            stipend_id: first.id,
            stipend_interval: first.interval_kind,
            destination: first.destination ?? undefined,
            amount_sats: first.amount_sats,
            rule_id: first.rule_id,
            memo: `Stipend: ${first.name}`,
            name: first.name,
          }),
      });
    }
    if (recoveryLeft != null && recoveryLeft > 0 && recoveryLeft <= approachingDays) {
      items.push({
        key: "trustee-recovery",
        label: `Recovery path unlocks in ${blocksToLabel(recoveryLeft)}`,
        detail: "Once unlocked, trustees can spend at reduced quorum. Ensure the vault is still staffed.",
        cta: "Review members",
        severity: "info",
        onClick: () => onOpenTab("members"),
      });
    }
  }

  if (isBeneficiary) {
    const mine = stipends.filter(s => s.active);
    if (mine.length > 0) {
      const nextDue = [...mine].sort(
        (a, b) => new Date(a.next_due_at).getTime() - new Date(b.next_due_at).getTime(),
      )[0];
      const days = Math.ceil(
        (new Date(nextDue.next_due_at).getTime() - now) / (1000 * 60 * 60 * 24),
      );
      items.push({
        key: "beneficiary-stipend",
        label: days <= 0
          ? `Your stipend "${nextDue.name}" is due now`
          : `Your next stipend in ${days} day${days === 1 ? "" : "s"}`,
        detail: `${satsToBtc(nextDue.amount_sats)} BTC, every ${nextDue.interval_kind}.`,
        cta: "See schedule",
        severity: days <= 0 ? "warn" : "info",
        onClick: () => onOpenTab("overview"),
      });
    }
    if (pendingRequests.length === 0) {
      items.push({
        key: "beneficiary-request",
        label: "Need funds?",
        detail: "File a distribution request -- trustees will review it against the trust doc.",
        cta: "File request",
        severity: "info",
        onClick: () => onOpenTab("requests"),
      });
    }
  }

  // inheritance_after is a bare database default on a leaf-list vault,
  // and a vault with no successor keys has no inheritance path at all.
  const hasInheritance = !(Array.isArray(vault.leaves) && vault.leaves.length > 0) && (vault.heir_keys?.length ?? 0) > 0;
  const founderHeadsUp = 180 * 24 * 6; // ~6 months: rotating takes every signer
  if (isTrustee && hasInheritance && inheritanceLeft != null && inheritanceLeft <= founderHeadsUp) {
    items.push({
      key: "trustee-inheritance",
      label: inheritanceLeft === 0 ? "Inheritance is open" : `Inheritance opens in ${durationWords(inheritanceLeft)}`,
      detail: inheritanceLeft === 0
        ? "Your successors can now spend without you. If that is not what you want, rotate this vault (top of the page) and move the coins today."
        : "The date is fixed: after it your successors can spend without you, whether or not you are active. To push it out, rotate this vault (top of the page) and move the coins before then.",
      cta: "See who can sign",
      severity: "warn",
      onClick: () => onOpenTab("members"),
    });
  }
  // The moment the whole product exists for. This prompt used to
  // DISAPPEAR when the path opened (it was only built while blocks
  // remained), leaving an heir with a card and no next step.
  if (isHeir && hasInheritance && inheritanceLeft === 0) {
    items.push({
      key: "heir-open",
      label: "The inheritance path is open",
      detail: `${vault.heir_quorum} of ${vault.heir_keys.length} successors can now move the coins without the trustees. Open Send, choose the Inheritance path, enter an address you control, and sign with your key.`,
      cta: "Go to Send",
      severity: "warn",
      onClick: () => onSendPrefill({ path: "inheritance" }),
    });
  }

  // Vaults from the path builder have no heir role: the prompt goes to
  // whoever holds one of the path's keys on this device.
  if (Array.isArray(vault.leaves) && vault.leaves.length > 0 && vault.status !== "draft") {
    const mine = listKeys().filter(k => k.status === "active").map(k => k.pubkey);
    for (const m of pathMoments(vault.leaves, tip, mine, new Date())) {
      items.push(
        m.kind === "open"
          ? { key: `path-open-${m.pathId}`, label: m.label, detail: m.detail, cta: "Go to Send", severity: "warn", onClick: () => onSendPrefill({ path: m.pathId }) }
          : { key: `path-near-${m.pathId}`, label: m.label, detail: m.detail, cta: "See the keys", severity: "warn", onClick: () => onOpenTab("members") },
      );
    }
  }

  if (isHeir && inheritanceLeft != null && inheritanceLeft > 0) {
    items.push({
      key: "heir-countdown",
      label: `Inheritance path unlocks in ${blocksToLabel(inheritanceLeft)}`,
      detail:
        inheritanceLeft <= approachingDays
          ? "Your window is approaching. Confirm your successor keys are backed up."
          : "The date is fixed. From then on you and the other successors can spend without the original trustees.",
      cta: "Review your key",
      severity: inheritanceLeft <= approachingDays ? "warn" : "info",
      onClick: () => onOpenTab("members"),
    });
  }

  if (items.length === 0) return null;

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: colors.muted,
          textTransform: "uppercase",
        }}
      >
        Today
      </div>
      {items.map(it => {
        const accent = it.severity === "danger"
          ? colors.red
          : it.severity === "warn"
            ? colors.orange
            : colors.gold;
        return (
          <div
            key={it.key}
            style={{
              borderLeft: `3px solid ${accent}`,
              background: accent + "0C",
              borderRadius: radii.sm,
              padding: "10px 12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>
                {it.label}
              </div>
              <div style={{ fontSize: 15, color: colors.muted, marginTop: 2 }}>
                {it.detail}
              </div>
            </div>
            <Button size="sm" style={{ fontSize: 15, padding: "5px 10px" }} onClick={it.onClick}>
              {it.cta}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
