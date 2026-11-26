import { useEffect, useState } from "react";
import { api, type Vault, type TrustDoc, type DistributionRule } from "../../lib/api";
import { useToast } from "../../components/toast";
import { colors, radii, } from "../../theme";
import { Button, Input, Label, Textarea } from "../../components/ui";
import { satsToBtc } from "./shared";


// // -- Trust document
// Purpose, beneficiaries, distribution rules, succession notes.
// Every member sees it; only the vault owner can edit.

export function TrustDocSection({ vault }: { vault: Vault }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [doc, setDoc] = useState<TrustDoc>(vault.trust_doc ?? {});
  const [session, setSession] = useState<{ user: { id: string } } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Lightweight: we only need to compare user_id to decide if
    // the edit button should appear. Session comes from Supabase.
    import("../../lib/supabase").then(({ supabase }) => {
      supabase.auth.getSession().then(({ data }) => {
        setSession(data.session as unknown as { user: { id: string } });
      });
    });
  }, []);

  const isOwner = session?.user.id === vault.user_id;
  const empty =
    !doc.purpose && !doc.distribution_rules && !doc.succession_notes && !(doc.beneficiaries ?? []).length;

  async function save() {
    setSaving(true);
    try {
      await api.vaults.updateTrustDoc(vault.id, doc);
      toast.success("Trust document saved");
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
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
            marginBottom: empty ? 0 : 10,
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
            Trust document
          </div>
          {isOwner && (
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 15, padding: "3px 9px" }}
              onClick={() => setEditing(true)}
            >
              {empty ? "Add" : "Edit"}
            </Button>
          )}
        </div>
        {empty ? (
          <div style={{ fontSize: 16, color: colors.muted, marginTop: 8 }}>
            {isOwner ? "None yet: the purpose and rules every member signs with." : "None yet."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {doc.purpose && (
              <TrustField label="Purpose" value={doc.purpose} />
            )}
            {(doc.beneficiaries ?? []).length > 0 && (
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: colors.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                  Beneficiaries
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {(doc.beneficiaries ?? []).map((b, i) => (
                    <div key={i} style={{ fontSize: 17, color: colors.text }}>
                      {b.name}
                      {b.relation ? (
                        <span style={{ color: colors.muted }}> -- {b.relation}</span>
                      ) : null}
                      {b.notes ? (
                        <div style={{ fontSize: 15, color: colors.muted }}>
                          {b.notes}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {doc.distribution_rules && (
              <TrustField label="Distribution rules" value={doc.distribution_rules} />
            )}
            {(doc.rules ?? []).length > 0 && (
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: colors.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                  Enforced rules
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(doc.rules ?? []).map(r => (
                    <div key={r.id} style={{ fontSize: 17, color: colors.text }}>
                      {r.name}
                      {r.max_sats ? (
                        <span style={{ color: colors.muted }}>
                          {" "} / max {satsToBtc(r.max_sats)} BTC per spend
                        </span>
                      ) : null}
                      {r.requires_comment && (
                        <span style={{ color: colors.orange, marginLeft: 6, fontSize: 15 }}>
                          requires reason
                        </span>
                      )}
                      {r.notes && (
                        <div style={{ fontSize: 15, color: colors.muted }}>
                          {r.notes}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {doc.succession_notes && (
              <TrustField label="Succession" value={doc.succession_notes} />
            )}
          </div>
        )}
      </div>
    );
  }

  // Edit mode
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.gold}44`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: colors.gold,
          marginBottom: 12,
          textTransform: "uppercase",
        }}
      >
        Edit trust document
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <Label>Purpose</Label>
          <Textarea
            rows={2}
            value={doc.purpose ?? ""}
            onChange={e => setDoc({ ...doc, purpose: e.target.value })}
            placeholder="Why this trust exists. One or two sentences."
          />
        </div>
        <div>
          <Label>Beneficiaries (one per line: Name, Relation, Notes)</Label>
          <Textarea
            rows={3}
            mono
            value={(doc.beneficiaries ?? [])
              .map(b => [b.name, b.relation ?? "", b.notes ?? ""].join(" | "))
              .join("\n")}
            onChange={e => {
              const list = e.target.value
                .split("\n")
                .map(l => l.split("|").map(s => s.trim()))
                .filter(cols => cols[0])
                .map(cols => ({
                  name: cols[0],
                  relation: cols[1] || undefined,
                  notes: cols[2] || undefined,
                }));
              setDoc({ ...doc, beneficiaries: list });
            }}
            placeholder="Sarah Smith | daughter | receives educational distributions"
          />
        </div>
        <div>
          <Label>Distribution rules</Label>
          <Textarea
            rows={3}
            value={doc.distribution_rules ?? ""}
            onChange={e => setDoc({ ...doc, distribution_rules: e.target.value })}
            placeholder="When and why the trust spends. E.g. 'Up to 0.1 BTC quarterly for education; medical emergencies up to 0.5 BTC with 2-trustee approval.'"
          />
        </div>
        <div>
          <Label>Succession notes</Label>
          <Textarea
            rows={2}
            value={doc.succession_notes ?? ""}
            onChange={e => setDoc({ ...doc, succession_notes: e.target.value })}
            placeholder="Who takes over if the primary trustee is incapacitated. Refers to the inheritance timelock path."
          />
        </div>
        <TrustRulesEditor
          rules={doc.rules ?? []}
          onChange={rules => setDoc({ ...doc, rules })}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <Button variant="ghost" onClick={() => { setDoc(vault.trust_doc ?? {}); setEditing(false); }}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Saving..." : "Save trust document"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TrustField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: colors.muted,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 17, color: colors.text, whiteSpace: "pre-wrap" }}>
        {value}
      </div>
    </div>
  );
}

// // -- Trust rules editor
// Structured distribution-rules list. Used inside the trust doc
// editor; the resulting rules gate the Send form client-side.

function TrustRulesEditor({
  rules,
  onChange,
}: {
  rules: DistributionRule[];
  onChange: (next: DistributionRule[]) => void;
}) {
  function update(i: number, patch: Partial<DistributionRule>) {
    const next = rules.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  }
  function remove(i: number) {
    onChange(rules.filter((_, j) => j !== i));
  }
  function add() {
    onChange([
      ...rules,
      { id: crypto.randomUUID(), name: "", requires_comment: false },
    ]);
  }

  return (
    <div>
      <Label>Enforced distribution rules</Label>
      <div style={{ fontSize: 16, color: colors.muted, marginBottom: 10 }}>
        Each rule gives the Send form a named category trustees must pick
        from. Optional amount cap; optional required reason. These are
        soft-enforced client-side, not on-chain.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rules.map((r, i) => (
          <div
            key={r.id}
            style={{
              background: colors.inset,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Input
                value={r.name}
                onChange={e => update(i, { name: e.target.value })}
                placeholder="Rule name (e.g. Quarterly educational distribution)"
                style={{ flex: 2 }}
              />
              <Input
                type="number"
                min="0"
                step="0.00000001"
                value={r.max_sats != null ? (r.max_sats / 1e8).toString() : ""}
                onChange={e => {
                  const parsed = parseFloat(e.target.value);
                  update(i, {
                    max_sats: Number.isFinite(parsed) && parsed > 0
                      ? Math.round(parsed * 1e8)
                      : null,
                  });
                }}
                placeholder="Max BTC"
                style={{ flex: 1 }}
              />
            </div>
            <Input
              value={r.notes ?? ""}
              onChange={e => update(i, { notes: e.target.value })}
              placeholder="Notes (tax category, trust clause reference...)"
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  cursor: "pointer",
                  fontSize: 16,
                  color: colors.sub,
                }}
              >
                <input
                  type="checkbox"
                  checked={!!r.requires_comment}
                  onChange={e => update(i, { requires_comment: e.target.checked })}
                />
                Requires a reason note
              </label>
              <Button variant="ghost" size="sm" style={{ fontSize: 15 }} onClick={() => remove(i)}>
                Remove
              </Button>
            </div>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={add}>
          + Add rule
        </Button>
      </div>
    </div>
  );
}
