import { useEffect, useState, useCallback } from "react";
import { api, type Vault, type DistributionRule, type ScheduledStipend, type StipendInterval } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useToast } from "../../components/toast";
import { useConfirm } from "../../components/dialog";
import { colors, fonts, radii, } from "../../theme";
import { Button, Input, Label } from "../../components/ui";
import { useRealtimeRefresh } from "../../lib/realtime";
import { SendPrefill } from "./SendTab";
import { intervalLabel, satsToBtc } from "./shared";


// // -- Scheduled stipends (T-stipend mode)
// UX schedule layer over the existing proposal/signing pipeline.
// Not Bitcoin-enforced vesting -- every spend still requires real
// trustee signatures. This just surfaces what's due and prefills
// the Send form so nobody has to remember dates.

const INTERVAL_OPTIONS: StipendInterval[] = ["weekly", "monthly", "quarterly", "annually"];

export function StipendsSection({
  vault,
  onSendPrefill,
}: {
  vault: Vault;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  const toast = useToast();
  const askConfirm = useConfirm();
  const [list, setList] = useState<ScheduledStipend[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [session, setSession] = useState<{ user: { id: string } } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session as unknown as { user: { id: string } });
    });
  }, []);

  const isOwner = session?.user.id === vault.user_id;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.stipends.list(vault.id);
      setList(res.stipends);
    } catch {
      /* empty state is fine */
    } finally {
      setLoading(false);
    }
  }, [vault.id]);

  useEffect(() => { void load(); }, [load]);

  useRealtimeRefresh(
    { table: "scheduled_stipends", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  const now = Date.now();
  const overdueCount = list.filter(
    s => s.active && new Date(s.next_due_at).getTime() <= now,
  ).length;

  async function remove(id: string) {
    if (!(await askConfirm({ title: "Remove stipend", message: "Remove this scheduled stipend? Pending payouts from it will no longer be suggested.", confirmLabel: "Remove", danger: true }))) return;
    try {
      await api.stipends.remove(id);
      toast.success("Stipend removed");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  async function toggleActive(s: ScheduledStipend) {
    try {
      await api.stipends.update(s.id, { active: !s.active });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  function sendFrom(s: ScheduledStipend) {
    onSendPrefill({
      stipend_id: s.id,
      stipend_interval: s.interval_kind,
      destination: s.destination ?? undefined,
      amount_sats: s.amount_sats,
      rule_id: s.rule_id,
      memo: `Stipend: ${s.name}`,
      name: s.name,
    });
  }

  if (loading) return null;
  if (!isOwner && list.length === 0) return null;

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: list.length === 0 && !adding ? 0 : 10,
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: colors.muted,
            textTransform: "uppercase",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          Scheduled stipends
          {overdueCount > 0 && (
            <span
              style={{
                background: colors.orange,
                color: colors.bg,
                fontSize: 14,
                fontWeight: 700,
                borderRadius: 10,
                padding: "1px 6px",
              }}
            >
              {overdueCount} due
            </span>
          )}
        </div>
        {isOwner && !adding && (
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 15, padding: "3px 9px" }}
            onClick={() => setAdding(true)}
          >
            Add
          </Button>
        )}
      </div>

      {list.length === 0 && !adding && isOwner && (
        <div style={{ fontSize: 16, color: colors.muted, marginTop: 8 }}>
          None yet: regular payouts you want reminders for.
        </div>
      )}

      {list.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map(s => (
            <StipendRow
              key={s.id}
              stipend={s}
              isOwner={isOwner}
              editing={editing === s.id}
              onEdit={() => setEditing(s.id)}
              onCancelEdit={() => setEditing(null)}
              onSaved={() => { setEditing(null); void load(); }}
              onRemove={() => remove(s.id)}
              onToggle={() => toggleActive(s)}
              onSend={() => sendFrom(s)}
            />
          ))}
        </div>
      )}

      {adding && (
        <div style={{ marginTop: 10 }}>
          <StipendEditor
            vault={vault}
            onCancel={() => setAdding(false)}
            onSaved={() => { setAdding(false); void load(); }}
          />
        </div>
      )}
    </div>
  );
}

function StipendRow({
  stipend: s,
  isOwner,
  editing,
  onEdit,
  onCancelEdit,
  onSaved,
  onRemove,
  onToggle,
  onSend,
}: {
  stipend: ScheduledStipend;
  isOwner: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onSend: () => void;
}) {
  // editing branch renders the editor inline
  if (editing) {
    return (
      <StipendEditor
        vault={null}
        stipend={s}
        onCancel={onCancelEdit}
        onSaved={onSaved}
      />
    );
  }

  const due = new Date(s.next_due_at).getTime();
  const overdue = s.active && due <= Date.now();
  const dueLabel = new Date(s.next_due_at).toLocaleDateString();

  return (
    <div
      style={{
        border: `1px solid ${overdue ? colors.orange + "66" : colors.border}`,
        background: overdue ? colors.orange + "11" : "transparent",
        borderRadius: 10,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>
          {s.name}
          {!s.active && (
            <span style={{ color: colors.muted, fontSize: 15, marginLeft: 6 }}>paused</span>
          )}
        </div>
        <div style={{ fontSize: 16, color: overdue ? colors.orange : colors.sub }}>
          {overdue ? "Due " : "Next "} {dueLabel}
        </div>
      </div>
      <div style={{ fontSize: 16, color: colors.muted, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span>{satsToBtc(s.amount_sats)} BTC</span>
        <span>{intervalLabel(s.interval_kind)}</span>
        {s.recipient_name && <span>{s.recipient_name}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
        {s.active && (
          <Button size="sm" style={{ fontSize: 15 }} onClick={onSend}>
            {overdue ? "Send now" : "Prefill send"}
          </Button>
        )}
        {isOwner && (
          <>
            <Button variant="ghost" size="sm" style={{ fontSize: 15 }} onClick={onEdit}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" style={{ fontSize: 15 }} onClick={onToggle}>
              {s.active ? "Pause" : "Resume"}
            </Button>
            <Button variant="danger" size="sm" style={{ fontSize: 15 }} onClick={onRemove}>
              Remove
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function StipendEditor({
  vault,
  stipend,
  onCancel,
  onSaved,
}: {
  vault: Vault | null;
  stipend?: ScheduledStipend;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const existing = !!stipend;
  const [name, setName] = useState(stipend?.name ?? "");
  const [recipient, setRecipient] = useState(stipend?.recipient_name ?? "");
  const [destination, setDestination] = useState(stipend?.destination ?? "");
  const [amountBtc, setAmountBtc] = useState(
    stipend ? satsToBtc(stipend.amount_sats) : "",
  );
  const [interval, setInterval] = useState<StipendInterval>(stipend?.interval_kind ?? "monthly");
  const [ruleId, setRuleId] = useState<string>(stipend?.rule_id ?? "");
  const [startsAt, setStartsAt] = useState<string>(
    stipend
      ? new Date(stipend.next_due_at).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);

  const rules: DistributionRule[] = vault?.trust_doc?.rules ?? [];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const amountSats = Math.round(parseFloat(amountBtc || "0") * 1e8);
    if (!name.trim()) return toast.error("Name required");
    if (amountSats < 546) return toast.error("Amount must be at least 546 sats");
    setSaving(true);
    try {
      if (existing && stipend) {
        await api.stipends.update(stipend.id, {
          name: name.trim(),
          recipient_name: recipient.trim() || null,
          destination: destination.trim() || null,
          rule_id: ruleId || null,
          amount_sats: amountSats,
          interval_kind: interval,
          next_due_at: new Date(startsAt + "T00:00:00Z").toISOString(),
        }, stipend.vault_id);
        toast.success("Stipend updated");
      } else if (vault) {
        await api.stipends.create({
          vault_id: vault.id,
          name: name.trim(),
          recipient_name: recipient.trim() || undefined,
          destination: destination.trim() || undefined,
          rule_id: ruleId || undefined,
          amount_sats: amountSats,
          interval_kind: interval,
          starts_at: new Date(startsAt + "T00:00:00Z").toISOString(),
        });
        toast.success("Stipend created");
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={save}
      style={{
        border: `1px solid ${colors.gold}44`,
        borderRadius: 10,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div>
        <Label>Name</Label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Monthly living expenses"
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <Label>Recipient (optional)</Label>
          <Input
            value={recipient}
            onChange={e => setRecipient(e.target.value)}
            placeholder="Sarah"
          />
        </div>
        <div>
          <Label>Amount (BTC)</Label>
          <Input
            mono
            value={amountBtc}
            onChange={e => setAmountBtc(e.target.value)}
            placeholder="0.01"
          />
        </div>
      </div>
      <div>
        <Label>Destination address (optional)</Label>
        <Input
          mono
          value={destination}
          onChange={e => setDestination(e.target.value)}
          placeholder="bc1q..."
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <Label>Interval</Label>
          <select
            value={interval}
            onChange={e => setInterval(e.target.value as StipendInterval)}
            style={{
              width: "100%",
              padding: "8px 10px",
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              color: colors.text,
              fontFamily: fonts.sans,
              fontSize: 17,
            }}
          >
            {INTERVAL_OPTIONS.map(k => (
              <option key={k} value={k}>{intervalLabel(k)}</option>
            ))}
          </select>
        </div>
        <div>
          <Label>Next due</Label>
          <Input
            type="date"
            value={startsAt}
            onChange={e => setStartsAt(e.target.value)}
          />
        </div>
      </div>
      {rules.length > 0 && (
        <div>
          <Label>Trust rule (optional)</Label>
          <select
            value={ruleId}
            onChange={e => setRuleId(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 10px",
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              color: colors.text,
              fontFamily: fonts.sans,
              fontSize: 17,
            }}
          >
            <option value="">No rule</option>
            {rules.map(r => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 16 }} type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" style={{ fontSize: 16 }} disabled={saving} type="submit">
          {saving ? "Saving..." : existing ? "Save" : "Create"}
        </Button>
      </div>
    </form>
  );
}
