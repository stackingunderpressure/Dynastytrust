import { useState } from "react";
import { api, type PursePayment, type PurseView, type Vault, type VaultMember, type VaultRequest } from "../../lib/api";
import { useToast } from "../../components/toast";
import { colors, fonts, radii } from "../../theme";
import { Button, Input, Label, Textarea } from "../../components/ui";
import { readInvoice, receiptMatches } from "../../lib/purse";
import { parseNwcUri, payInvoice } from "../../lib/nwc";
import { forgetPurseWallet, hasPurseWallet, openPurseWallet, savePurseWallet } from "../../lib/nwc-store";

/**
 * The treasurer pays an approved purse payout, and everyone sees the
 * receipt (family purse, slice 3). The treasurer's phone shows every check
 * it made before the Pay button appears; if any fails, there is no button.
 * The receipt is re-checked on every phone that shows it.
 */

type Check = { ok: boolean; text: string };

export function PursePay({
  vault,
  request: r,
  me,
  purse,
  goodYesCount,
  yesNames,
  payment,
  monthLeft,
  onChanged,
}: {
  vault: Vault;
  request: VaultRequest;
  me: VaultMember | undefined;
  purse: PurseView | null;
  goodYesCount: number;
  yesNames: string[];
  payment: PursePayment | undefined;
  monthLeft: number | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [uri, setUri] = useState("");
  const [password, setPassword] = useState("");
  const [connected, setConnected] = useState(() => hasPurseWallet(vault.id));
  const [note, setNote] = useState<string | null>(null);

  if (r.road !== "lightning") return null;

  if (r.status === "fulfilled" && payment?.status === "paid" && payment.preimage) {
    const real = !!r.payment_hash && receiptMatches(payment.preimage, r.payment_hash);
    return (
      <div style={{ fontSize: 15, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ color: colors.green, fontWeight: 600 }}>
          Paid {r.amount_sats.toLocaleString("en-US")} sats{payment.fee_sats != null ? `, fee ${payment.fee_sats.toLocaleString("en-US")} sats` : ""}
        </div>
        <div style={{ color: real ? colors.muted : colors.red }}>
          {real
            ? "Proof it was paid: the payment's receipt code, which only the person paid could have given back. Checked on this phone."
            : "The stored receipt does not match this invoice. Ask the treasurer."}
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.muted }}>
          {payment.preimage.slice(0, 8)}...{payment.preimage.slice(-6)}
        </div>
      </div>
    );
  }
  if (r.status !== "approved") return null;

  const settings = purse?.settings;
  const iAmTreasurer = !!me && !!settings?.treasurer_member_id && settings.treasurer_member_id === me.id;
  if (!iAmTreasurer) {
    return (
      <div style={{ fontSize: 15, color: colors.muted }}>
        {payment?.status === "started"
          ? "The treasurer has started paying this."
          : settings?.treasurer_member_id
            ? "Waiting for the treasurer to pay."
            : "No treasurer has been chosen yet, so nobody can pay this. The vault owner picks one in the purse rules."}
      </div>
    );
  }

  const inv = readInvoice(r.invoice ?? "", vault.network);
  const checks: Check[] = [
    { ok: goodYesCount >= (settings?.approvals_needed ?? Infinity), text: `${goodYesCount} of ${settings?.approvals_needed ?? "?"} yeses, each a genuine signature checked on this phone${yesNames.length ? `: ${yesNames.join(", ")}` : ""}.` },
    { ok: inv.ok && inv.sha256 === r.invoice_sha256, text: "They signed this exact invoice." },
    { ok: inv.ok && inv.amount_sats === r.amount_sats, text: `It asks for exactly ${r.amount_sats.toLocaleString("en-US")} sats.` },
    { ok: inv.ok && !!r.payment_hash && inv.payment_hash === r.payment_hash, text: "Its receipt can be checked when it is paid." },
    { ok: payment?.status !== "paid", text: "It has not been paid before." },
    {
      ok: monthLeft == null ? false : payment?.status === "started" || r.amount_sats <= monthLeft,
      text: monthLeft == null ? "Could not read the monthly cap." : `It fits under the monthly cap: ${monthLeft.toLocaleString("en-US")} sats left.`,
    },
  ];
  const allOk = checks.every(c => c.ok);

  async function connect() {
    const p = parseNwcUri(uri);
    if (!p.ok) {
      toast.error(p.error);
      return;
    }
    setBusy(true);
    try {
      await savePurseWallet(vault.id, uri, password);
      setConnected(true);
      setUri("");
      setPassword("");
      toast.success("The purse wallet is connected on this phone only.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the connection");
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!inv.ok || !r.payment_hash) return;
    setBusy(true);
    setNote(null);
    try {
      const saved = await openPurseWallet(vault.id, password);
      const p = parseNwcUri(saved);
      if (!p.ok) throw new Error(p.error);
      await api.vaultPurse.payStart(r.id);
      const out = await payInvoice({ conn: p.conn, invoice: inv.invoice, paymentHash: r.payment_hash });
      if (out.kind === "paid") {
        await api.vaultPurse.payDone(r.id, out.preimage, out.fee_sats);
        toast.success("Paid, and the receipt checks out.");
      } else if (out.kind === "failed") {
        await api.vaultPurse.payFailed(r.id, out.message);
        setNote(`${out.message} Nothing was sent.`);
      } else {
        setNote(out.message);
      }
      setPassword("");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not pay");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: radii.md, border: `1px solid ${colors.border}` }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>You are the treasurer. Checks before paying:</div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {checks.map(c => (
          <li key={c.text} style={{ fontSize: 15, color: c.ok ? colors.text : colors.red }}>
            {c.ok ? "[ok] " : "[no] "}
            {c.text}
          </li>
        ))}
      </ul>
      {!connected && (
        <>
          <Label htmlFor={`nwc-${r.id}`}>Connect the purse wallet</Label>
          <Textarea id={`nwc-${r.id}`} mono rows={3} value={uri} onChange={e => setUri(e.target.value)} placeholder="nostr+walletconnect://..." />
          <div style={{ fontSize: 14, color: colors.muted }}>
            Make a connection in the purse wallet (Alby Hub, Coinos and others call it Nostr Wallet Connect) and give it a monthly budget no
            bigger than the purse's cap. The wallet refuses anything over that budget on its own. The connection is kept on this phone only,
            locked with the password below.
          </div>
          <Label htmlFor={`nwcpw-${r.id}`}>Password to lock it</Label>
          <Input id={`nwcpw-${r.id}`} type="password" value={password} onChange={e => setPassword(e.target.value)} />
          <Button size="sm" onClick={() => void connect()} disabled={busy || !uri || password.length < 8}>
            Connect on this phone
          </Button>
        </>
      )}
      {connected && allOk && (
        <>
          <Label htmlFor={`nwcpw-${r.id}`}>Purse wallet password</Label>
          <Input id={`nwcpw-${r.id}`} type="password" value={password} onChange={e => setPassword(e.target.value)} />
          <Button onClick={() => void pay()} disabled={busy || !password}>
            {busy ? "Paying..." : payment?.status === "started" ? "Try paying again" : `Pay ${r.amount_sats.toLocaleString("en-US")} sats now`}
          </Button>
          {payment?.status === "started" && (
            <div style={{ fontSize: 14, color: colors.muted }}>
              A payment was started and its outcome is not known. Check the wallet first. Trying again cannot pay twice: a Lightning invoice
              can be paid only once.
            </div>
          )}
        </>
      )}
      {connected && !allOk && <div style={{ fontSize: 14, color: colors.muted }}>A check did not pass, so there is no Pay button.</div>}
      {note && <div style={{ fontSize: 15, color: colors.orange }}>{note}</div>}
      {connected && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            forgetPurseWallet(vault.id);
            setConnected(false);
          }}
        >
          Forget the wallet on this phone
        </Button>
      )}
    </div>
  );
}
