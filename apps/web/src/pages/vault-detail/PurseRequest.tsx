import { useState } from "react";
import { api, type PurseView, type PurseYes, type Vault, type VaultMember, type VaultRequest } from "../../lib/api";
import { useToast } from "../../components/toast";
import { usePrompt } from "../../components/dialog";
import { colors, fonts, radii } from "../../theme";
import { Button, Label, Textarea } from "../../components/ui";
import { payoutTargetHash, readInvoice, YES_TYPE } from "../../lib/purse";
import { verifyAttestation } from "../../lib/attest";
import { signWithLocalKey } from "../../lib/local-sign";

/**
 * The family purse on one request (slice 2). A Lightning request is paid
 * only after enough of the family say yes, and a yes is a signature by the
 * member's own vault key over this exact amount, road and invoice
 * fingerprint. Before signing, this phone re-reads the invoice itself and
 * refuses if its amount or fingerprint differ from the request. Every yes
 * shown is re-checked here too -- the count is this phone's, not the
 * server's word.
 */

export type PurseRoad = "" | "onchain" | "lightning";

/** Yeses on `r` whose signature checks out on this phone, for the exact target. */
function checkedYeses(vault: Vault, r: VaultRequest, yeses: PurseYes[]): PurseYes[] {
  if (r.road !== "lightning") return [];
  const target = payoutTargetHash({ vault_id: vault.id, request_id: r.id, amount_sats: r.amount_sats, road: r.road, invoice_sha256: r.invoice_sha256 ?? null });
  const seen = new Set<string>();
  return yeses.filter(y => {
    if (y.request_id !== r.id || y.target_hash !== target || seen.has(y.member_id)) return false;
    const ok = verifyAttestation({ attestationType: YES_TYPE, targetHash: target, signature: y.sig, pubkey: y.pubkey });
    if (ok) seen.add(y.member_id);
    return ok;
  });
}

export function PurseYesBlock({
  vault,
  request: r,
  me,
  members,
  purse,
  yeses,
  onChanged,
}: {
  vault: Vault;
  request: VaultRequest;
  me: VaultMember | undefined;
  members: VaultMember[];
  purse: PurseView | null;
  yeses: PurseYes[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const askPrompt = usePrompt();
  const [busy, setBusy] = useState(false);
  if (r.road !== "lightning") return null;

  const good = checkedYeses(vault, r, yeses);
  const needed = purse?.settings.approvals_needed ?? 0;
  const voters = purse?.settings.voters ?? [];
  const mine = me ? good.some(y => y.member_id === me.id) : false;
  const mayVote =
    !!me && me.status === "active" && me.user_id !== r.requested_by && (voters.length === 0 || voters.includes(me.id));
  const names = good.map(y => members.find(m => m.id === y.member_id)?.label || "A member");
  const lapsed = r.expires_at ? new Date(r.expires_at).getTime() < Date.now() : false;

  async function sayYes() {
    if (!me) return;
    setBusy(true);
    try {
      const inv = readInvoice(r.invoice ?? "", vault.network);
      if (!inv.ok) throw new Error(inv.error);
      if (inv.sha256 !== r.invoice_sha256) throw new Error("This invoice is not the one the request was filed with. Do not sign it.");
      if (inv.amount_sats !== r.amount_sats) {
        throw new Error(`The invoice asks for ${inv.amount_sats.toLocaleString("en-US")} sats but the request says ${r.amount_sats.toLocaleString("en-US")}. Do not sign it.`);
      }
      const targetHash = payoutTargetHash({ vault_id: vault.id, request_id: r.id, amount_sats: r.amount_sats, road: "lightning", invoice_sha256: inv.sha256 });
      const { signature, pubkey } = await signWithLocalKey({
        pubkey: me.pubkey,
        attestationType: YES_TYPE,
        targetHash,
        network: vault.network,
        requestPassword: label =>
          askPrompt({ title: "Unlock key", message: `Enter the password for "${label}" to sign your yes.`, password: true, confirmLabel: "Sign" }),
      });
      const res = await api.vaultPurse.sayYes({ request_id: r.id, signature, pubkey });
      toast.success(res.status === "approved" ? "That was the last yes needed. The treasurer can pay it." : `Your yes is in: ${res.yeses} of ${res.needed}.`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not sign your yes");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", borderRadius: radii.md, background: colors.input }}>
      <div style={{ fontSize: 16 }}>
        Lightning purse, {r.amount_sats.toLocaleString("en-US")} sats. {good.length} of {needed || "?"} yes
        {names.length ? `: ${names.join(", ")}` : ""}
      </div>
      {r.invoice_sha256 && (
        <div style={{ fontSize: 14, color: colors.muted, fontFamily: fonts.mono }}>
          Invoice fingerprint {r.invoice_sha256.slice(0, 8)}...{r.invoice_sha256.slice(-6)}
        </div>
      )}
      {r.status === "approved" && <div style={{ fontSize: 15, color: colors.green }}>Enough yeses. Waiting for the treasurer to pay.</div>}
      {r.status === "pending" && lapsed && <div style={{ fontSize: 15, color: colors.muted }}>This request has lapsed.</div>}
      {r.status === "pending" && !lapsed && mayVote && !mine && (
        <>
          <div style={{ fontSize: 14, color: colors.muted }}>
            Your yes is a signature on this exact amount and this exact invoice. If either changes, your yes no longer counts.
          </div>
          <Button size="sm" onClick={() => void sayYes()} disabled={busy || !me?.pubkey}>
            {busy ? "Signing..." : "Say yes"}
          </Button>
          {!me?.pubkey && <div style={{ fontSize: 14, color: colors.muted }}>You need a vault key on this vault to say yes.</div>}
        </>
      )}
      {r.status === "pending" && mine && <div style={{ fontSize: 15, color: colors.green }}>You said yes.</div>}
      {r.status === "pending" && !mayVote && me && me.user_id === r.requested_by && (
        <div style={{ fontSize: 14, color: colors.muted }}>This is your request, so the family decides it, not you.</div>
      )}
    </div>
  );
}

/** Road picker + invoice box for the new-request form. */
export function PurseRoadFields({
  vault,
  road,
  setRoad,
  invoice,
  setInvoice,
}: {
  vault: Vault;
  road: PurseRoad;
  setRoad: (r: PurseRoad) => void;
  invoice: string;
  setInvoice: (s: string) => void;
}) {
  const read = road === "lightning" && invoice.trim() ? readInvoice(invoice, vault.network) : null;
  return (
    <>
      <div>
        <Label htmlFor="purse-road">How it is paid</Label>
        <select
          id="purse-road"
          value={road}
          onChange={e => setRoad(e.target.value as PurseRoad)}
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
          <option value="">A trustee decides (as before)</option>
          <option value="lightning">Family purse, Lightning (small, family says yes)</option>
          <option value="onchain">From the vault, on-chain (large)</option>
        </select>
      </div>
      {road === "lightning" && (
        <div>
          <Label htmlFor="purse-invoice">Lightning invoice</Label>
          <Textarea
            id="purse-invoice"
            mono
            rows={3}
            value={invoice}
            onChange={e => setInvoice(e.target.value)}
            placeholder="lnbc... from the wallet being paid, with the amount in it"
          />
          <div style={{ fontSize: 14, color: read && !read.ok ? colors.red : colors.muted, marginTop: 4 }}>
            {read
              ? read.ok
                ? `This invoice asks for ${read.amount_sats.toLocaleString("en-US")} sats. That is the amount the family will be asked to say yes to.`
                : read.error
              : "Make the invoice in the wallet being paid (Coinos: Receive, type the amount). The amount comes from the invoice."}
          </div>
        </div>
      )}
    </>
  );
}
