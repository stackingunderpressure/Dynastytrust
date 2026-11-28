import { useEffect, useState, useCallback } from "react";
import { PANEL_FIT } from "../../components/ui/panelFit";
import { api, type Vault, type VaultMember, type VaultRequest, type VaultRequestStatus } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useToast } from "../../components/toast";
import { usePrompt } from "../../components/dialog";
import { colors, fonts, radii, space } from "../../theme";
import { Button, Input, Label, Textarea } from "../../components/ui";
import { useRealtimeRefresh } from "../../lib/realtime";
import { SendPrefill } from "./SendTab";
import { isTrusteeRole, satsToBtc } from "./shared";
import { PursePanel } from "./PursePanel";


// // -- Requests tab
// Distribution request queue. Beneficiaries (or any member) file
// a request; trustees approve -> creates a draft proposal
// pre-filled with the amount + rule, or decline with a note.

export function RequestsTab({ vault, onSendPrefill }: { vault: Vault; onSendPrefill: (p: SendPrefill) => void }) {
  const toast = useToast();
  const askPrompt = usePrompt();
  const [requests, setRequests] = useState<VaultRequest[]>([]);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, m] = await Promise.all([
        api.vaultRequests.list(vault.id),
        api.members.list(vault.id),
      ]);
      setRequests(r.requests);
      setMembers(m.members);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [vault.id]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setCurrentUserId(data.session?.user.id ?? null);
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeRefresh(
    { table: "vault_requests", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  const me = members.find(m => m.user_id === currentUserId);
  const iAmTrustee = me ? isTrusteeRole(me.role) : false;

  async function resolve(r: VaultRequest, status: VaultRequestStatus, note?: string) {
    try {
      await api.vaultRequests.update(r.id, {
        status,
        resolution_note: note,
      }, r.vault_id);
      toast.success(`Request ${status}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  function startProposalFromRequest(r: VaultRequest) {
    // There's no destination address on a distribution request --
    // only the trustee decides where funds actually go -- so amount
    // and context prefill, the address stays for the trustee to
    // enter. request_id rides along so a successful broadcast can
    // close the loop: mark this request fulfilled and link it to
    // the proposal that paid it (see SendTab's broadcast()).
    onSendPrefill({
      amount_sats: r.amount_sats,
      rule_id: r.rule_id,
      name: r.rule_name ?? undefined,
      memo: r.reason
        ? `Distribution: ${r.reason}`
        : r.recipient_name
          ? `Distribution for ${r.recipient_name}`
          : "Distribution request",
      request_id: r.id,
    });
    toast.info("Request loaded into the Send tab -- enter the destination address to finish.");
  }

  if (loading) return <p style={{ color: colors.muted, fontSize: 17 }}>Loading...</p>;

  const pending = requests.filter(r => r.status === "pending");
  const resolved = requests.filter(r => r.status !== "pending");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PursePanel vault={vault} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ fontSize: 17, color: colors.muted }}>
          {pending.length} pending, {resolved.length} resolved
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          + New request
        </Button>
      </div>

      {pending.length > 0 ? (
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
              padding: "10px 16px",
              borderBottom: `1px solid ${colors.border}`,
              fontSize: 17,
              fontWeight: 600,
              color: colors.text,
            }}
          >
            Pending
          </div>
          {pending.map(r => (
            <RequestRow
              key={r.id}
              request={r}
              requesterLabel={members.find(m => m.user_id === r.requested_by)?.label ?? "Member"}
              iAmTrustee={iAmTrustee}
              iAmRequester={r.requested_by === currentUserId}
              onApprove={() => {
                void resolve(r, "approved", "Create the proposal in Send.");
                startProposalFromRequest(r);
              }}
              onDecline={() => {
                void (async () => {
                  const note = (await askPrompt({
                    title: "Decline request",
                    message: "Add a reason for declining (optional). The requester will see this.",
                    placeholder: "Reason (optional)",
                    confirmLabel: "Decline",
                  })) ?? undefined;
                  await resolve(r, "declined", note);
                })();
              }}
              onCancel={() => void resolve(r, "cancelled")}
            />
          ))}
        </div>
      ) : (
        <p style={{ color: colors.muted, fontSize: 17 }}>
          No pending requests. {iAmTrustee ? "Beneficiaries file here." : "Tap + New request to ask for a distribution."}
        </p>
      )}

      {resolved.length > 0 && (
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
              padding: "10px 16px",
              borderBottom: `1px solid ${colors.border}`,
              fontSize: 17,
              fontWeight: 600,
              color: colors.muted,
            }}
          >
            History
          </div>
          {resolved.map(r => (
            <RequestRow
              key={r.id}
              request={r}
              requesterLabel={members.find(m => m.user_id === r.requested_by)?.label ?? "Member"}
              iAmTrustee={false}
              iAmRequester={false}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <NewRequestModal
          vault={vault}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function RequestRow({
  request: r,
  requesterLabel,
  iAmTrustee,
  iAmRequester,
  onApprove,
  onDecline,
  onCancel,
}: {
  request: VaultRequest;
  requesterLabel: string;
  iAmTrustee: boolean;
  iAmRequester: boolean;
  onApprove?: () => void;
  onDecline?: () => void;
  onCancel?: () => void;
}) {
  const color =
    r.status === "approved" || r.status === "fulfilled"
      ? colors.green
      : r.status === "declined" || r.status === "cancelled"
        ? colors.red
        : colors.orange;

  return (
    <div
      style={{
        padding: "12px 16px",
        borderBottom: `1px solid ${colors.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div>
          <span style={{ fontSize: 17, fontWeight: 600, color: colors.text, fontFamily: fonts.display }}>
            {(r.amount_sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0"} BTC
          </span>
          {r.rule_name && (
            <span style={{ color: colors.muted, fontSize: 16, marginLeft: 8 }}>
              via {r.rule_name}
            </span>
          )}
        </div>
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            padding: "2px 7px",
            borderRadius: 4,
            background: color + "22",
            color,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {r.status}
        </span>
      </div>
      <div style={{ fontSize: 16, color: colors.muted }}>
        Requested by {requesterLabel}
        {r.recipient_name ? ` for ${r.recipient_name}` : ""}
        {" / "}
        {new Date(r.created_at).toLocaleDateString()}
      </div>
      {r.reason && (
        <div style={{ fontSize: 17, color: colors.sub, whiteSpace: "pre-wrap" }}>{r.reason}</div>
      )}
      {r.resolution_note && (
        <div style={{ fontSize: 16, color: colors.muted, fontStyle: "italic" }}>
          Note: {r.resolution_note}
        </div>
      )}
      {r.status === "pending" && (iAmTrustee || iAmRequester) && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          {iAmTrustee && onApprove && (
            <Button size="sm" style={{ fontSize: 16 }} onClick={onApprove}>
              Approve + create proposal
            </Button>
          )}
          {iAmTrustee && onDecline && (
            <Button variant="danger" size="sm" style={{ fontSize: 16 }} onClick={onDecline}>
              Decline
            </Button>
          )}
          {iAmRequester && onCancel && (
            <Button variant="ghost" size="sm" style={{ fontSize: 16 }} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function NewRequestModal({
  vault,
  onClose,
  onCreated,
}: {
  vault: Vault;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const rules = vault.trust_doc?.rules ?? [];
  const [ruleId, setRuleId] = useState<string>(rules[0]?.id ?? "");
  const [amountBtc, setAmountBtc] = useState("");
  const [recipient, setRecipient] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedRule = rules.find(r => r.id === ruleId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const sats = Math.round(parseFloat(amountBtc || "0") * 1e8);
    if (sats < 546) {
      setErr("Minimum 546 sats");
      return;
    }
    if (selectedRule?.max_sats && sats > selectedRule.max_sats) {
      setErr(
        `Exceeds "${selectedRule.name}" cap of ${satsToBtc(selectedRule.max_sats)} BTC per request.`,
      );
      return;
    }
    if (selectedRule?.requires_comment && !reason.trim()) {
      setErr(`"${selectedRule.name}" requires a reason.`);
      return;
    }
    setBusy(true);
    try {
      await api.vaultRequests.create({
        vault_id: vault.id,
        rule_id: selectedRule?.id,
        rule_name: selectedRule?.name,
        amount_sats: sats,
        recipient_name: recipient.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      toast.success("Request filed");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
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
          maxWidth: 460,
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
          File a distribution request
        </h2>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {rules.length > 0 && (
            <div>
              <Label>Distribution rule</Label>
              <select
                value={ruleId}
                onChange={e => setRuleId(e.target.value)}
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
                <option value="">-- pick a rule --</option>
                {rules.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.max_sats ? ` (max ${satsToBtc(r.max_sats)} BTC)` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <Label>Amount (BTC)</Label>
            <Input
              type="number"
              step="0.00000001"
              min="0.00000546"
              value={amountBtc}
              onChange={e => setAmountBtc(e.target.value)}
              required
              placeholder="0.01"
            />
          </div>
          <div>
            <Label>Recipient (optional)</Label>
            <Input
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              placeholder="e.g. Emma (daughter), University of X"
            />
          </div>
          <div>
            <Label>
              Reason{selectedRule?.requires_comment ? " (required)" : " (optional)"}
            </Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Why this distribution? Which clause of the trust does it satisfy?"
            />
          </div>
          {err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}
          <div style={{ display: "flex", gap: 10 }}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Filing..." : "File request"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
