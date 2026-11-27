// The Send screen's form: path, send to, amount, fee, rule, memo, and
// choosing coins. Markup only: the values and setters are SendTab's, and
// "Review & sign" calls SendTab's buildAndSign. Its own state is only the
// coins list's open/closed.
import { useState, type Dispatch, type SetStateAction } from "react";
import type { Vault, BalanceResult } from "../../lib/api";
import { whoSignsShort } from "../../lib/path-words";
import type { blocDecayLadder } from "../../lib/blocks";
import { selectStyle } from "../../components/vault-builder";
import { colors, fonts, radii } from "../../theme";
import { Button, Input, Label } from "../../components/ui";
import { UtxosSection } from "./UtxosSection";
import { satsToBtc } from "./shared";
import type { SendPrefill } from "./SendTab";
import type { BlocPath } from "./send-types";

type Rule = NonNullable<NonNullable<Vault["trust_doc"]>["rules"]>[number];
type Set<T> = Dispatch<SetStateAction<T>>;

export function SendForm({
  vault, balance, prefill, onPickCoins, bp, blocLadder, blocPath, setBlocPath, blocRungIdx, setBlocRungIdx,
  isLeafList, hasRecovery, hasInheritance, hasBackup, hasSecondInheritance, standardPath, setStandardPath,
  dest, setDest, sweep, setSweep, amountBtc, setAmountBtc, confirmedSats, feeRate, setFeeRate,
  rules, ruleId, setRuleId, selectedRule, memo, setMemo, err, busy, slowHint, buildAndSign,
}: {
  vault: Vault;
  balance: BalanceResult | null;
  prefill?: SendPrefill | null;
  onPickCoins?: (p: SendPrefill) => void;
  bp: Vault["bloc_policy"];
  blocLadder: ReturnType<typeof blocDecayLadder>;
  blocPath: BlocPath;
  setBlocPath: Set<BlocPath>;
  blocRungIdx: number;
  setBlocRungIdx: Set<number>;
  isLeafList: boolean;
  hasRecovery: boolean;
  hasInheritance: boolean;
  hasBackup: boolean;
  hasSecondInheritance: boolean;
  standardPath: string;
  setStandardPath: Set<string>;
  dest: string;
  setDest: Set<string>;
  sweep: boolean;
  setSweep: Set<boolean>;
  amountBtc: string;
  setAmountBtc: Set<string>;
  confirmedSats: number;
  feeRate: string;
  setFeeRate: Set<string>;
  rules: Rule[];
  ruleId: string;
  setRuleId: Set<string>;
  selectedRule: Rule | undefined;
  memo: string;
  setMemo: Set<string>;
  err: string | null;
  busy: boolean;
  slowHint: boolean;
  buildAndSign: (e: React.FormEvent) => Promise<void>;
}) {
  const [pickCoins, setPickCoins] = useState(false);
  return (
    <>
    {/* Operator's chips, 2026-11-24: the coins and when each path opens for
        each one; picking coins is optional -- the app picks the fewest. */}
    {/* Optional, so closed: the form comes first (operator, 2026-11-25,
        docs/screen-cleanse-build-note.md). */}
    {vault.status !== "draft" && onPickCoins && (
      <div style={{ marginBottom: 14, maxWidth: 480 }}>
        <button
          type="button"
          onClick={() => setPickCoins(v => !v)}
          aria-expanded={pickCoins}
          style={{ background: "none", border: "none", padding: "10px 0", minHeight: 44, fontSize: 16, color: colors.sub, cursor: "pointer", textDecoration: "underline", textAlign: "left" }}
        >
          {pickCoins ? "Hide the coins" : "Choose which coins to spend (optional -- the app picks if you don't)"}
        </button>
        {pickCoins && (
          <div style={{ fontSize: 15, color: colors.muted, lineHeight: 1.5, marginBottom: 8 }}>
            Left to itself, the app spends your largest confirmed coins first. If you are not spending the full
            balance, that can join separate deposits in one public transaction. Pick coins here if that matters.
          </div>
        )}
        {pickCoins && (
          <UtxosSection vault={vault} onSendPrefill={p => onPickCoins({ ...(prefill ?? {}), ...p })} refreshKey={`${balance?.total_sats ?? ""}:${balance?.utxo_count ?? ""}`} balance={balance} />
        )}
      </div>
    )}
    <form
      onSubmit={e => void buildAndSign(e)}
      style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 480 }}
    >
      {prefill?.selected_utxos && prefill.selected_utxos.length > 0 && (
        <div
          style={{
            padding: "8px 10px",
            background: colors.gold + "11",
            border: `1px solid ${colors.gold}44`,
            borderRadius: radii.md,
            fontSize: 16,
            color: colors.gold,
          }}
        >
          Locked to {prefill.selected_utxos.length} UTXO
          {prefill.selected_utxos.length === 1 ? "" : "s"}:{" "}
          <span style={{ fontFamily: fonts.mono, fontSize: 15 }}>
            {prefill.selected_utxos.map(u => `${u.txid.slice(0, 8)}:${u.vout}`).join(", ")}
          </span>
          {prefill.selected_utxos.length > 1 && (
            <div style={{ marginTop: 4, color: colors.muted }}>
              Spending these together publicly links them to the same
              owner forever, even if they arrived separately.
            </div>
          )}
          {onPickCoins && (
            <div style={{ marginTop: 6 }}>
              <Button type="button" variant="ghost" size="sm" style={{ fontSize: 15, minHeight: 44 }}
                onClick={() => onPickCoins({ ...(prefill ?? {}), selected_utxos: undefined })}>
                Let the app choose the coins
              </Button>
            </div>
          )}
        </div>
      )}

      {bp && (
        <div>
          <Label>Spend path</Label>
          <select
            value={blocPath}
            onChange={e => { setBlocPath(e.target.value as typeof blocPath); setBlocRungIdx(0); }}
            style={selectStyle}
          >
            <option value="parents_now">Parents together ({bp.parents_together_quorum} of {bp.parent_pubkeys.length}) -- now</option>
            <option value="coparent_kids">One parent + the kids ({bp.coparent_quorum} parent + {bp.kids_with_parent_quorum} of {bp.kid_pubkeys.length} kids) -- now</option>
            <option value="parent_solo">One parent alone ({bp.parent_solo_quorum} of {bp.parent_pubkeys.length}) -- after timelock</option>
            <option value="kids_decay">Kids alone (decaying quorum) -- after timelock</option>
          </select>
          {blocPath === "kids_decay" && (
            <select
              value={blocRungIdx}
              onChange={e => setBlocRungIdx(Number(e.target.value))}
              style={{ ...selectStyle, marginTop: 8 }}
            >
              {blocLadder.map((rung, i) => (
                <option key={i} value={i}>
                  {rung.q} of {bp.kid_pubkeys.length} kids -- after block {rung.absAfter.toLocaleString()}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {!bp && (hasRecovery || hasInheritance || hasBackup || hasSecondInheritance) && (
        <div>
          <Label>Spend path</Label>
          <select
            value={standardPath}
            onChange={e => setStandardPath(e.target.value as typeof standardPath)}
            style={selectStyle}
          >
            <option value="founders_now">
              Founders now ({vault.founder_quorum} of {vault.founder_keys.length}) -- no waiting
            </option>
            {hasRecovery && (
              <option value="recovery">
                Recovery ({vault.recovery_quorum ?? vault.founder_quorum} of {vault.founder_keys.length} founders) -- after timelock
              </option>
            )}
            {hasInheritance && (
              <option value="inheritance">
                Inheritance ({vault.heir_quorum} of {vault.heir_keys.length} heirs) -- after timelock
              </option>
            )}
            {hasBackup && (
              <option value="backup">
                Backup ({vault.backup_quorum} of {vault.backup_keys.length}) -- anytime, no timelock
              </option>
            )}
            {hasSecondInheritance && (
              <option value="second_inheritance">
                Second inheritance ({vault.second_heir_quorum} of {vault.second_heir_keys.length} heirs) -- after its own timelock
              </option>
            )}
          </select>
          {standardPath !== "founders_now" && (
            <div style={{ fontSize: 15, color: colors.muted, marginTop: 5 }}>
              {standardPath === "backup"
                ? "This path has no timelock, but it needs a separate set of keys from the day-to-day founders."
                : standardPath === "second_inheritance"
                  ? "This path is a separate heir group from the main inheritance path, with its own timelock -- only spendable once that timelock has passed."
                  : "This path is only spendable once its timelock has passed -- the compiler will reject the build otherwise."}
            </div>
          )}
        </div>
      )}

      {/* Leaf-list vault: the path picker uses each leaf's own id, not the
          named-field ids above -- see isLeafList's header comment. Hidden
          entirely for a single-leaf vault, matching the named-field
          dropdown's own "only show a picker once there's a real choice"
          behavior. */}
      {!bp && isLeafList && vault.leaves!.length > 1 && (
        <div>
          <Label>Spend path</Label>
          <select
            value={standardPath}
            onChange={e => setStandardPath(e.target.value)}
            style={selectStyle}
          >
            {vault.leaves!.map(leaf => (
              <option key={leaf.id} value={leaf.id}>
                {leaf.label} ({whoSignsShort(leaf.quorum, leaf.keys.length, leaf.required_keys?.length ?? 0)})
                {leaf.unlock.type === "immediate"
                  ? " -- no waiting"
                  : leaf.unlock.type === "after"
                    ? ` -- after block ${leaf.unlock.blocks.toLocaleString()}`
                    : " -- once untouched for a while"}
              </option>
            ))}
          </select>
          {vault.leaves!.find(l => l.id === standardPath)?.unlock.type !== "immediate" && (
            <div style={{ fontSize: 15, color: colors.muted, marginTop: 5 }}>
              This path is only spendable once its timelock has passed -- the compiler will reject
              the build otherwise.
            </div>
          )}
        </div>
      )}

      <div>
        <Label>Send to</Label>
        <Input
          mono
          value={dest}
          onChange={e => setDest(e.target.value)}
          required
          placeholder="tb1p... or bc1p..."
        />
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 2 }}>
          <Label>Amount (BTC)</Label>
          {sweep ? (
            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 17,
                color: colors.text,
              }}
            >
              Entire confirmed balance -- exact amount is computed when you build (fee comes off the top, no change back to the vault)
            </div>
          ) : (
            <Input
              type="number"
              step="0.00000001"
              min="0.00000546"
              value={amountBtc}
              onChange={e => setAmountBtc(e.target.value)}
              required
              placeholder="0.001"
            />
          )}
          {confirmedSats > 0 && (
            <div style={{ fontSize: 15, color: colors.muted, marginTop: 5 }}>
              {satsToBtc(confirmedSats)} BTC available
              <button
                type="button"
                style={{
                  background: "none",
                  border: "none",
                  color: colors.gold,
                  cursor: "pointer",
                  fontSize: 15,
                  marginLeft: 8,
                }}
                onClick={() => {
                  setSweep(s => !s);
                  setAmountBtc("");
                }}
              >
                {sweep ? "Enter amount instead" : "Max"}
              </button>
            </div>
          )}
        </div>
        <div style={{ flex: 1 }}>
          <Label>Fee (sat/vb)</Label>
          <Input
            type="number"
            step="0.1"
            min="1"
            value={feeRate}
            onChange={e => setFeeRate(e.target.value)}
            placeholder="Auto"
          />
        </div>
      </div>

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
          {selectedRule?.notes && (
            <div style={{ fontSize: 15, color: colors.muted, marginTop: 6 }}>
              {selectedRule.notes}
            </div>
          )}
        </div>
      )}

      <div>
        <Label>
          {selectedRule?.requires_comment
            ? "Reason (required by this rule)"
            : "Memo (optional)"}
        </Label>
        <Input
          value={memo}
          onChange={e => setMemo(e.target.value)}
          placeholder={
            selectedRule?.requires_comment
              ? "Why this spend? Which clause of the trust does it satisfy?"
              : "Note"
          }
        />
      </div>

      {err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}

      <Button
        type="submit"
        disabled={busy}
        style={{ padding: "14px", fontSize: 17 }}
      >
        {busy ? (slowHint ? "Waking compiler..." : "Building transaction...") : "Review & sign"}
      </Button>
    </form>
    </>
  );
}
