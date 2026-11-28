import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Vault, type VaultMember } from "../../lib/api";
import { colors } from "../../theme";
import { useRealtimeRefresh } from "../../lib/realtime";
import { ledgerEventWords } from "../../lib/ledger-verify";


// // -- Activity tab

type VaultEvent = Awaited<ReturnType<typeof api.vaultEvents.list>>["events"][number];

export function ActivityTab({ vault, onOpenTab }: { vault: Vault; onOpenTab: (id: string) => void }) {
  const [events, setEvents] = useState<VaultEvent[]>([]);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [ev, mem] = await Promise.all([
        api.vaultEvents.list(vault.id, 100),
        api.members.list(vault.id),
      ]);
      setEvents(ev.events);
      setMembers(mem.members);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load activity");
    } finally {
      setLoading(false);
    }
  }, [vault.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeRefresh(
    { table: "vault_events", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  if (loading) return <p style={{ color: colors.muted, fontSize: 17 }}>Loading activity...</p>;
  if (err) return <p style={{ color: colors.red, fontSize: 17 }}>{err}</p>;
  if (events.length === 0)
    return <p style={{ color: colors.muted, fontSize: 17 }}>No activity yet.</p>;

  const memberLabel = (userId: string): string => {
    const m = members.find(m => m.user_id === userId);
    if (!m) return "A former member";
    return m.label || (m.role ? m.role.charAt(0).toUpperCase() + m.role.slice(1) : "A member");
  };

  const goToDestination = (dest: EventDestination) => {
    if (!dest) return;
    if (dest.kind === "proposal") navigate(`/vaults/${vault.id}/proposals/${dest.proposalId}`);
    else onOpenTab(dest.tab);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ fontSize: 16, color: colors.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Every action taken on this vault, who took it, and a link to the full
        record -- the proposal it belongs to, or the Trust / Requests /
        Members tab that holds the source-of-truth detail.
      </div>
      {events.map(e => (
        <EventRow key={e.id} event={e} actor={memberLabel(e.user_id)} onOpen={goToDestination} />
      ))}
    </div>
  );
}

type EventDestination =
  | { kind: "proposal"; proposalId: string }
  | { kind: "tab"; tab: string }
  | null;

function eventDestination(e: VaultEvent): EventDestination {
  const meta = e.metadata || {};
  if (typeof meta.proposal_id === "string") {
    return { kind: "proposal", proposalId: meta.proposal_id };
  }
  if (typeof meta.attestation_id === "string" || e.event_type.startsWith("attestation_")) {
    return { kind: "tab", tab: "trust" };
  }
  if (typeof meta.request_id === "string" || e.event_type.startsWith("request_")) {
    return { kind: "tab", tab: "requests" };
  }
  if (["invite_created", "invite_revoked", "member_joined", "member_removed", "key_confirmed", "grant_sent", "grant_accepted", "grant_declined", "grant_left"].includes(e.event_type)) {
    return { kind: "tab", tab: "members" };
  }
  return null;
}

function EventRow({
  event,
  actor,
  onOpen,
}: {
  event: VaultEvent;
  actor: string;
  onOpen: (dest: EventDestination) => void;
}) {
  const { icon, title, color } = describeEvent(event, actor);
  const dest = eventDestination(event);
  const clickable = dest !== null;
  return (
    <div
      onClick={clickable ? () => onOpen(dest) : undefined}
      style={{
        display: "flex",
        gap: 12,
        padding: "12px 4px",
        borderBottom: `1px solid ${colors.border}`,
        cursor: clickable ? "pointer" : "default",
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          flexShrink: 0,
          background: `${color}22`,
          color: color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 17,
          fontWeight: 700,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, color: colors.text }}>{title}</div>
        <div style={{ fontSize: 15, color: colors.muted, marginTop: 2 }}>
          {new Date(event.created_at).toLocaleString()}
        </div>
      </div>
      {clickable && (
        <div style={{ color: colors.muted, fontSize: 17, alignSelf: "center", flexShrink: 0 }}>
          &gt;
        </div>
      )}
    </div>
  );
}

function describeEvent(e: VaultEvent, actor: string): { icon: string; title: string; color: string } {
  const meta = e.metadata || {};
  switch (e.event_type) {
    case "created":
      return { icon: "+", title: "Vault created", color: colors.gold };
    case "invite_created":
      return { icon: "i", title: `${actor} sent an invite (${String(meta.role ?? "member")})`, color: colors.blue };
    case "member_joined":
      return { icon: "@", title: `${actor} joined as ${String(meta.role ?? "member")}`, color: colors.green };
    case "member_removed":
      return { icon: "-", title: `${actor} was removed`, color: colors.red };
    case "psbt_generated":
      return {
        icon: "T",
        title: `${actor} created a proposal${meta.amount_sats ? ` (${(Number(meta.amount_sats) / 1e8).toFixed(8).replace(/\.?0+$/, "")} BTC)` : ""}`,
        color: colors.orange,
      };
    case "signed": {
      // Since 2026-11-12 a signature is sealed with the signer's role and
      // the capacity their key signed in on the path.
      const as = Array.isArray(meta.signed_as) ? (meta.signed_as as { as?: string | null }[]) : [];
      const how = as.some(a => a.as === "must_sign") ? " with a must-sign key"
        : as.some(a => a.as === "consent") ? " as a consenting key"
        : "";
      const role = typeof meta.role === "string" ? ` (${meta.role})` : "";
      return { icon: "S", title: `${actor}${role} signed${how}`, color: colors.gold };
    }
    case "key_confirmed":
      return { icon: "K", title: `${actor} confirmed a member's key`, color: colors.green };
    case "invite_revoked":
      return { icon: "x", title: `${actor} withdrew an invite (${String(meta.role ?? "member")})`, color: colors.muted };
    case "grant_sent":
      return { icon: "i", title: `${actor} offered membership to ${String(meta.recipient_label ?? "a member")}`, color: colors.blue };
    case "grant_accepted":
      return { icon: "@", title: `${String(meta.recipient_label ?? "A member")} accepted membership`, color: colors.green };
    case "grant_declined":
      return { icon: "x", title: `${String(meta.recipient_label ?? "A member")} declined membership`, color: colors.muted };
    case "grant_left":
      return { icon: "-", title: `${String(meta.recipient_label ?? "A member")} stepped away`, color: colors.red };
    case "duress_raised":
      return { icon: "!", title: `${actor} raised the duress alarm`, color: colors.red };
    case "duress_cleared":
      return { icon: "o", title: `${actor} cleared the duress alarm`, color: colors.orange };
    case "halt_on":
      return { icon: "!", title: `${actor} halted the vault -- signing paused`, color: colors.red };
    case "halt_off":
      return { icon: "o", title: `${actor} lifted the halt`, color: colors.green };
    case "vault_renamed":
      return { icon: "N", title: `${actor} renamed the vault${meta.to ? ` to "${String(meta.to)}"` : ""}`, color: colors.sub };
    case "vault_archived":
      return { icon: "A", title: `${actor} archived the vault`, color: colors.muted };
    case "vault_unarchived":
      return { icon: "A", title: `${actor} brought the vault back from the archive`, color: colors.sub };
    case "trust_doc_updated":
      return { icon: "T", title: `${actor} changed the trust document`, color: colors.orange };
    case "key_label_changed":
      return { icon: "K", title: `${actor} renamed a key${meta.to ? ` to "${String(meta.to)}"` : ""}`, color: colors.sub };
    case "key_origins_repaired":
      return { icon: "K", title: `${actor} changed a key's hardware wallet details`, color: colors.orange };
    case "purse_rules_set":
      return { icon: "P", title: `${actor} changed the family purse's rules`, color: colors.orange };
    case "purse_rules_handed_to_family":
      return { icon: "P", title: `${actor} handed the family purse's rules to the family`, color: colors.orange };
    case "purse_yes":
      return { icon: "P", title: `${actor} said yes to a purse payout${meta.amount_sats ? ` of ${Number(meta.amount_sats).toLocaleString("en-US")} sats` : ""}`, color: colors.sub };
    case "purse_payout_paid":
      return { icon: "P", title: `${actor} paid a purse payout${meta.amount_sats ? ` of ${Number(meta.amount_sats).toLocaleString("en-US")} sats` : ""}${meta.fee_sats != null ? `, fee ${String(meta.fee_sats)} sats` : ""}`, color: colors.green };
    case "purse_payment_failed":
      return { icon: "P", title: `The purse wallet refused a payout; nothing was sent${meta.reason ? ` (${String(meta.reason)})` : ""}`, color: colors.orange };
    case "purse_payout_approved":
      return { icon: "P", title: `Enough of the family said yes to a purse payout${meta.yeses ? ` (${String(meta.yeses)} yeses)` : ""}`, color: colors.green };
    case "broadcast":
      return {
        icon: "B",
        title: `${actor} broadcast the transaction${meta.txid ? ` (${String(meta.txid).slice(0, 12)}...)` : ""}`,
        color: colors.green,
      };
    case "cancelled":
      return { icon: "x", title: `${actor} cancelled the proposal`, color: colors.muted };
    case "commented":
      return { icon: "c", title: `${actor} commented`, color: colors.sub };
    case "voted_approve":
      return { icon: "+", title: `${actor} voted to approve`, color: colors.green };
    case "voted_abstain":
      return { icon: "o", title: `${actor} abstained`, color: colors.muted };
    case "voted_decline":
      return { icon: "-", title: `${actor} voted to decline`, color: colors.red };
    case "request_created":
      return {
        icon: "R",
        title: `${actor} filed a distribution request${meta.rule_name ? ` (${String(meta.rule_name)})` : ""}${meta.amount_sats ? ` -- ${(Number(meta.amount_sats) / 1e8).toFixed(8).replace(/\.?0+$/, "")} BTC` : ""}`,
        color: colors.orange,
      };
    case "request_approved":
      return { icon: "+", title: `${actor} approved the request`, color: colors.green };
    case "request_declined":
      return { icon: "x", title: `${actor} declined the request`, color: colors.red };
    case "request_fulfilled":
      return { icon: "!", title: "Request fulfilled", color: colors.green };
    case "request_cancelled":
      return { icon: "o", title: `${actor} cancelled the request`, color: colors.muted };
    case "attestation_trust_doc":
      return { icon: "T", title: `${actor} signed the trust doc`, color: colors.gold };
    case "attestation_proof_of_life":
      return { icon: "L", title: `${actor} checked in (proof of life)`, color: colors.green };
    case "attestation_death_declaration":
      return { icon: "!", title: `${actor} signed a death declaration`, color: colors.red };
    case "attestation_descriptor":
      return { icon: "D", title: `${actor} attested to the vault descriptor`, color: colors.blue };
    case "attestation_revoked":
      return { icon: "x", title: `${actor} revoked an attestation`, color: colors.muted };
    default:
      // Same plain words as the sealed record page, never the raw event
      // name (operator's screenshot showed "Owner: message_sent").
      return { icon: "*", title: `${actor}: ${ledgerEventWords(e.event_type)}`, color: colors.sub };
  }
}
