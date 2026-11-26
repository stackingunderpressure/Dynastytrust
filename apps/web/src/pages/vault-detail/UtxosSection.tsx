import { useEffect, useState, useCallback } from "react";
import { api, type Vault, type BalanceResult } from "../../lib/api";
import { explorerTxUrl } from "../../config";
import { useToast } from "../../components/toast";
import { colors, fonts, radii, } from "../../theme";
import { Button } from "../../components/ui";
import { coinUnlocks, vaultPaths, waitWords } from "../../lib/coin-unlock";
import { SendPrefill } from "./SendTab";
import { satsToBtc } from "./shared";


// // -- UTXO list (per-coin view + coin-control)
// Every confirmed or unconfirmed output sitting at the vault
// address, shown individually so trustees can see exactly what
// they hold and (for confirmed UTXOs) click "Spend" to lock the
// Send flow to that one coin.

export function UtxosSection({
  vault,
  onSendPrefill,
  refreshKey,
  balance,
}: {
  vault: Vault;
  onSendPrefill: (p: SendPrefill) => void;
  /** Reloads the list when this changes (the balance reloaded). */
  refreshKey?: string;
  /** A fresh-address vault's balance already carries its coins (one scan
   *  for both, 2026-11-24); then the card shows those and does not scan. */
  balance?: BalanceResult | null;
}) {
  const toast = useToast();
  const [utxos, setUtxos] = useState<Array<{
    txid: string;
    vout: number;
    value_sats: number;
    confirmed: boolean;
    block_height: number | null;
    block_time: number | null;
    confirmations: number;
    branch?: number;
    index?: number;
  }>>([]);
  const [tip, setTip] = useState<number | null>(null);
  const paths = vaultPaths(vault);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const fromBalance = balance?.coins ?? null;
  const load = useCallback(async () => {
    if (fromBalance) {
      setUtxos(fromBalance);
      setTip(balance?.tip ?? null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.utxos(vault.id);
      setUtxos(res.utxos);
      setTip(res.tip);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load UTXOs");
    } finally {
      setLoading(false);
    }
  }, [vault.id, toast, fromBalance, balance?.tip]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  if (loading && utxos.length === 0) {
    return (
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: "14px 16px",
          fontSize: 16,
          color: colors.muted,
        }}
      >
        Loading UTXOs...
      </div>
    );
  }

  if (utxos.length === 0) return null;

  const total = utxos.reduce((n, u) => n + u.value_sats, 0);

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1600);
  }

  function spendOnly(u: typeof utxos[number]) {
    onSendPrefill({
      selected_utxos: [{ txid: u.txid, vout: u.vout }],
      memo: `Spend UTXO ${u.txid.slice(0, 8)}:${u.vout}`,
    });
  }

  function toggle(id: string) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setPicked(new Set(utxos.filter(u => u.confirmed).map(u => `${u.txid}:${u.vout}`)));
  }

  function clearPicked() { setPicked(new Set()); }

  function spendPicked() {
    const chosen = utxos.filter(u => picked.has(`${u.txid}:${u.vout}`) && u.confirmed);
    if (chosen.length === 0) return;
    const total = chosen.reduce((n, u) => n + u.value_sats, 0);
    onSendPrefill({
      selected_utxos: chosen.map(u => ({ txid: u.txid, vout: u.vout })),
      amount_sats: Math.max(546, total - 500), // leaves headroom for fee, user edits
      memo: `Spend ${chosen.length} UTXO${chosen.length === 1 ? "" : "s"}`,
    });
  }

  const pickedTotal = utxos
    .filter(u => picked.has(`${u.txid}:${u.vout}`) && u.confirmed)
    .reduce((n, u) => n + u.value_sats, 0);
  const pickedCount = Array.from(picked).filter(id =>
    utxos.some(u => `${u.txid}:${u.vout}` === id && u.confirmed),
  ).length;

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
          marginBottom: 10,
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
          }}
        >
          Coins ({utxos.length}) . {satsToBtc(total)} BTC total
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 15, padding: "3px 9px" }}
            onClick={selectAll}
          >
            All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 15, padding: "3px 9px" }}
            onClick={clearPicked}
            disabled={picked.size === 0}
          >
            None
          </Button>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 15, padding: "3px 9px" }}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        </div>
      </div>

      {pickedCount > 0 && (
        <div
          style={{
            padding: "8px 10px",
            background: colors.gold + "11",
            border: `1px solid ${colors.gold}44`,
            borderRadius: radii.md,
            fontSize: 16,
            marginBottom: 10,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ color: colors.gold }}>
              {pickedCount} selected . {satsToBtc(pickedTotal)} BTC
            </span>
            <Button size="sm" style={{ fontSize: 15 }} onClick={spendPicked}>
              Spend selected
            </Button>
          </div>
          {pickedCount > 1 && (
            <div style={{ marginTop: 6, color: colors.muted, fontSize: 15, lineHeight: 1.4 }}>
              Spending these {pickedCount} together publicly links them to
              the same owner forever, even though they arrived separately.
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {utxos.map(u => {
          const id = `${u.txid}:${u.vout}`;
          const ageBlocks = u.confirmations;
          const label =
            !u.confirmed
              ? "Unconfirmed"
              : ageBlocks === 0
                ? "0 confs"
                : ageBlocks === 1
                  ? "1 conf"
                  : `${ageBlocks.toLocaleString()} confs`;
          const isPicked = picked.has(id);
          return (
            <div
              key={id}
              style={{
                border: `1px solid ${
                  isPicked ? colors.gold + "88"
                  : u.confirmed ? colors.border
                  : colors.orange + "55"
                }`,
                background: isPicked
                  ? colors.gold + "0A"
                  : u.confirmed ? "transparent"
                  : colors.orange + "0A",
                borderRadius: 8,
                padding: "9px 11px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: u.confirmed ? "pointer" : "default" }}>
                  <input
                    type="checkbox"
                    disabled={!u.confirmed}
                    checked={isPicked}
                    onChange={() => toggle(id)}
                    style={{ accentColor: colors.gold }}
                  />
                  <span style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>
                    {satsToBtc(u.value_sats)} BTC
                  </span>
                </label>
                <span style={{ fontSize: 15, color: u.confirmed ? colors.muted : colors.orange }}>
                  {label}
                  {u.confirmed && tip != null && u.block_height != null && (
                    <> . block {u.block_height.toLocaleString()}</>
                  )}
                </span>
              </div>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 14,
                  color: colors.muted,
                  wordBreak: "break-all",
                }}
              >
                {u.txid}:{u.vout}
              </div>
              {u.branch != null && u.index != null && (
                <div style={{ fontSize: 15, color: colors.muted }}>
                  On {u.branch === 1 ? "change" : "receive"} address {u.index}
                </div>
              )}
              {paths && tip != null && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {coinUnlocks(u, paths, tip, new Date()).map(p => (
                    <div key={p.label} style={{ fontSize: 15, lineHeight: 1.45, color: p.open ? colors.green : colors.sub }}>
                      <span style={{ color: colors.text }}>{p.label}:</span>{" "}
                      {p.open ? "can spend now" : waitWords(p)}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                {u.confirmed && (
                  <Button
                    size="sm"
                    style={{ fontSize: 15, padding: "3px 9px" }}
                    onClick={() => spendOnly(u)}
                  >
                    Spend only this
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  style={{ fontSize: 15, padding: "3px 9px" }}
                  onClick={() => copy(u.txid, id)}
                >
                  {copied === id ? "Copied" : "Copy txid"}
                </Button>
                <a
                  href={explorerTxUrl(vault.network, u.txid)}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 15,
                    color: colors.gold,
                    textDecoration: "none",
                    padding: "3px 9px",
                    border: `1px solid ${colors.border}`,
                    borderRadius: radii.md,
                  }}
                >
                  Explorer
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

