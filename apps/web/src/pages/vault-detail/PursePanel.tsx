import { useEffect, useState } from "react";
import { api, type PurseSettings, type PurseView, type Vault } from "../../lib/api";
import { useToast } from "../../components/toast";
import { useConfirm } from "../../components/dialog";
import { colors, fonts, radii } from "../../theme";
import { Button, Input, Label } from "../../components/ui";

/**
 * The family purse's rules, at the top of the Requests tab. The vault
 * owner sets them; once the owner hands them to the family, every change
 * needs the family's yeses (a later slice) and this panel only shows
 * them. Operator, 2026-11-28: "Game master sets it at the start, family
 * vote later" / "With all inputs configurable".
 *
 * Slice 1 of the family purse: rules only. Nothing here moves money yet.
 */

const selectStyle = {
  width: "100%",
  padding: "11px 13px",
  background: colors.input,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  color: colors.text,
  fontSize: 17,
  fontFamily: fonts.sans,
  boxSizing: "border-box" as const,
};

type Draft = { [K in keyof PurseSettings]: PurseSettings[K] extends number ? string : PurseSettings[K] };

const NUMBER_FIELDS: { key: keyof PurseSettings; label: string; hint: string }[] = [
  { key: "approvals_needed", label: "Yeses needed for a payout", hint: "How many family members must agree before anything is paid." },
  { key: "per_payout_limit_sats", label: "Most one Lightning payout can be (sats)", hint: "Anything bigger is refused." },
  { key: "monthly_cap_sats", label: "Monthly cap (sats)", hint: "The purse pays no more than this in a month, whatever is agreed." },
  { key: "onchain_threshold_sats", label: "Use the vault itself from (sats)", hint: "Payouts this big or bigger go on-chain from the vault, signed by the family." },
  { key: "refill_sats", label: "Refill size (sats)", hint: "How much a refill moves from the vault into the purse, by family vote." },
  { key: "request_expiry_days", label: "A request lasts (days)", hint: "After this, an unanswered request lapses." },
];

function toDraft(s: PurseSettings): Draft {
  return {
    ...s,
    approvals_needed: String(s.approvals_needed),
    per_payout_limit_sats: String(s.per_payout_limit_sats),
    monthly_cap_sats: String(s.monthly_cap_sats),
    onchain_threshold_sats: String(s.onchain_threshold_sats),
    refill_sats: String(s.refill_sats),
    request_expiry_days: String(s.request_expiry_days),
  } as Draft;
}

function fromDraft(d: Draft): PurseSettings {
  const n = (v: string) => Number(v.replace(/[,\s_]/g, ""));
  return {
    approvals_needed: n(d.approvals_needed as unknown as string),
    voters: d.voters,
    treasurer_member_id: d.treasurer_member_id,
    per_payout_limit_sats: n(d.per_payout_limit_sats as unknown as string),
    monthly_cap_sats: n(d.monthly_cap_sats as unknown as string),
    onchain_threshold_sats: n(d.onchain_threshold_sats as unknown as string),
    refill_sats: n(d.refill_sats as unknown as string),
    request_expiry_days: n(d.request_expiry_days as unknown as string),
  };
}

export function PursePanel({ vault }: { vault: Vault }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [view, setView] = useState<PurseView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.vaultPurse.get(vault.id).then(
      (v) => {
        if (!live) return;
        setView(v);
        setDraft(toDraft(v.settings));
      },
      (e) => live && setErr(e instanceof Error ? e.message : "Could not load the purse rules"),
    );
    return () => {
      live = false;
    };
  }, [vault.id]);

  if (err) return <div style={{ color: colors.muted, fontSize: 15 }}>Family purse: {err}</div>;
  if (!view || !draft) return null;

  const nameOf = (id: string | null) => {
    if (!id) return "Not chosen yet";
    const m = view.members.find((x) => x.id === id);
    return m?.label || m?.role || "A member";
  };
  const voterCount = view.settings.voters.length || view.members.length;
  const s = view.settings;

  async function save() {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      const v = await api.vaultPurse.save(vault.id, fromDraft(draft));
      setView(v);
      setDraft(toDraft(v.settings));
      toast.success("Purse rules saved and sealed in the vault record.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the purse rules");
    } finally {
      setBusy(false);
    }
  }

  async function handOver() {
    const ok = await confirm({
      title: "Hand the rules to the family?",
      message:
        "From now on, changing any purse rule needs the family's yeses, the same as a payout. You cannot take this back on your own: switching it back would also need the family.",
      confirmLabel: "Hand them over",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const v = await api.vaultPurse.handOver(vault.id);
      setView(v);
      toast.success("The purse rules now belong to the family.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not hand the rules over");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Family purse</div>
          <div style={{ fontSize: 15, color: colors.muted }}>
            {s.approvals_needed} of {voterCount} yes for a payout, cap {s.monthly_cap_sats.toLocaleString("en-US")} sats a month,{" "}
            {view.governance === "family" ? "rules belong to the family" : "the owner sets the rules"}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? "Hide" : view.can_edit ? "Set rules" : "See rules"}
        </Button>
      </div>

      {open && !view.can_edit && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 16 }}>
          <div>Yeses needed: {s.approvals_needed} of {voterCount}</div>
          <div>Who votes: {s.voters.length ? s.voters.map(nameOf).join(", ") : "every member"}</div>
          <div>Treasurer: {nameOf(s.treasurer_member_id)}</div>
          <div>Most one payout can be: {s.per_payout_limit_sats.toLocaleString("en-US")} sats</div>
          <div>Monthly cap: {s.monthly_cap_sats.toLocaleString("en-US")} sats</div>
          <div>Through the vault from: {s.onchain_threshold_sats.toLocaleString("en-US")} sats</div>
          <div>Refill size: {s.refill_sats.toLocaleString("en-US")} sats</div>
          <div>A request lasts: {s.request_expiry_days} days</div>
          <div style={{ color: colors.muted, fontSize: 15 }}>
            {view.governance === "family"
              ? `Handed to the family ${view.handed_over_at ? new Date(view.handed_over_at).toLocaleDateString() : ""}. A change needs the family's yeses.`
              : "Only the vault owner can change these until they hand them to the family."}
          </div>
        </div>
      )}

      {open && view.can_edit && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {NUMBER_FIELDS.map((f) => (
            <div key={f.key}>
              <Label htmlFor={`purse-${f.key}`}>{f.label}</Label>
              <Input
                id={`purse-${f.key}`}
                inputMode="numeric"
                value={draft[f.key] as unknown as string}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
              <div style={{ fontSize: 14, color: colors.muted, marginTop: 4 }}>{f.hint}</div>
            </div>
          ))}
          <div>
            <Label htmlFor="purse-treasurer">Treasurer</Label>
            <select
              id="purse-treasurer"
              style={selectStyle}
              value={draft.treasurer_member_id ?? ""}
              onChange={(e) => setDraft({ ...draft, treasurer_member_id: e.target.value || null })}
            >
              <option value="">Not chosen yet</option>
              {view.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label || m.role}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 14, color: colors.muted, marginTop: 4 }}>The person whose Lightning wallet pays, once the family has said yes.</div>
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Who votes</legend>
            {view.members.map((m) => {
              const on = draft.voters.length === 0 || draft.voters.includes(m.id);
              return (
                <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, fontSize: 16 }}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      const all = view.members.map((x) => x.id);
                      const current = draft.voters.length ? draft.voters : all;
                      const next = on ? current.filter((x) => x !== m.id) : [...current, m.id];
                      setDraft({ ...draft, voters: next.length === all.length ? [] : next });
                    }}
                    style={{ width: 22, height: 22 }}
                  />
                  {m.label || m.role}
                </label>
              );
            })}
          </fieldset>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? "Saving..." : "Save rules"}
            </Button>
            <Button variant="danger" onClick={() => void handOver()} disabled={busy || !view.saved}>
              Hand the rules to the family
            </Button>
          </div>
          <div style={{ fontSize: 14, color: colors.muted }}>
            Every change is sealed into this vault's record with who made it and when, and stamped into Bitcoin. Save once before handing
            the rules over. The purse does not move money yet: payouts come next.
          </div>
        </div>
      )}
    </section>
  );
}
