import { useEffect, useState, useCallback } from "react";
import { api, type Vault, type Proposal, type BalanceResult } from "../lib/api";
import { listKeys, revealMnemonic, type LocalKey } from "../lib/keystore";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

const C = {
  bg: "#07070F", surface: "#0F0F1A", raised: "#141422",
  border: "#1E1E30", gold: "#C9A84C", goldDim: "#8B6914",
  text: "#E8E4D8", muted: "#5A5570", sub: "#9994A8",
  red: "#E05C5C", green: "#52C47A", blue: "#4A90D9", orange: "#E09050",
};

const inp: React.CSSProperties = {
  width: "100%", padding: "11px 13px", background: "#161622",
  border: "1px solid #1E1E30", borderRadius: 8, color: C.text,
  fontSize: 14, fontFamily: "DM Sans, sans-serif", boxSizing: "border-box",
};
const monoInp: React.CSSProperties = { ...inp, fontFamily: "IBM Plex Mono, monospace", fontSize: 12 };
const lbl: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: C.muted,
  textTransform: "uppercase", marginBottom: 5, display: "block",
};
const goldBtn: React.CSSProperties = {
  padding: "10px 20px", background: C.gold, border: "none", borderRadius: 8,
  color: C.bg, fontWeight: 700, fontSize: 14, fontFamily: "DM Sans, sans-serif", cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "9px 16px", background: "none", border: "1px solid #1E1E30",
  borderRadius: 8, color: C.sub, fontSize: 13, fontFamily: "DM Sans, sans-serif", cursor: "pointer",
};

function satsToBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0";
}
function blocksToLabel(blocks: number): string {
  if (!blocks) return "--";
  const days = Math.round(blocks * 10 / 60 / 24);
  if (days < 30) return "~" + days + " days";
  if (days < 365) return "~" + Math.round(days / 30) + " months";
  return "~" + (days / 365).toFixed(1) + " years";
}
function statusColor(s: string): string {
  if (s === "broadcast") return C.green;
  if (s === "signed") return C.gold;
  if (s === "cancelled") return C.muted;
  return C.blue;
}
function copyText(text: string) { navigator.clipboard.writeText(text); }

interface Props { vault: Vault; onBack: () => void; }

interface GovernanceStatus {
  active_paths: string[];
  phase: string;
  status_label: string;
  blocks_until_recovery: number | null;
  blocks_until_inheritance: number | null;
  days_until_recovery: number | null;
  days_until_inheritance: number | null;
  fallback?: boolean;
}

export default function VaultDetail({ vault, onBack }: Props) {
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [govStatus, setGovStatus] = useState<GovernanceStatus | null>(null);
  const [tab, setTab] = useState<"overview" | "spend" | "proposals" | "keys">("overview");
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [balRes, propRes] = await Promise.allSettled([
      api.balance(vault.address, vault.network),
      api.proposals.list(vault.id),
    ]);
    if (balRes.status === "fulfilled") setBalance(balRes.value);
    if (propRes.status === "fulfilled") setProposals(propRes.value.proposals);
    try {
      const gs = await api.governance.status({ vault_id: vault.id, utxo_age_blocks: 0 });
      setGovStatus({ ...gs.result, fallback: gs.fallback });
    } catch { /* governance is optional */ }
  }, [vault]);

  useEffect(() => { void load(); }, [load]);

  function copy(text: string, id: string) {
    copyText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1600);
  }

  async function archive() {
    if (!confirm("Archive vault " + vault.name + "?")) return;
    setArchiving(true);
    try { await api.vaults.archive(vault.id); onBack(); }
    catch (e) { alert(e instanceof Error ? e.message : "Failed"); }
    finally { setArchiving(false); }
  }

  const activeProposals = proposals.filter(p => p.status !== "broadcast" && p.status !== "cancelled");
  const completedProposals = proposals.filter(p => p.status === "broadcast" || p.status === "cancelled");

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "DM Sans, sans-serif" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 24px", height: 60, borderBottom: "1px solid " + C.border, background: "#0A0A12",
        position: "sticky", top: 0, zIndex: 50 }}>
        <button onClick={onBack} style={{ background: "none", border: "none",
          color: C.muted, fontSize: 14, cursor: "pointer", fontFamily: "DM Sans, sans-serif" }}>
          Back
        </button>
        <span style={{ fontFamily: "Playfair Display, serif", fontSize: 16,
          fontWeight: 700, letterSpacing: "0.12em", color: C.gold }}>DYNASTYTRUST</span>
        <button onClick={archive} disabled={archiving}
          style={{ ...ghostBtn, color: C.red, borderColor: "#3A1A1A", fontSize: 12 }}>
          Archive
        </button>
      </header>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "28px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start",
          gap: 20, marginBottom: 32, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em",
              color: C.muted, marginBottom: 6 }}>
              {vault.network === "bitcoin" ? "MAINNET" : "TESTNET"} / {vault.address_type.toUpperCase()}
            </div>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: C.text,
              fontFamily: "Playfair Display, serif", margin: "0 0 8px" }}>{vault.name}</h1>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, color: C.muted,
              wordBreak: "break-all", cursor: "pointer" }}
              onClick={() => copy(vault.address, "addr")}>
              {vault.address}
              <span style={{ marginLeft: 8, color: copied === "addr" ? C.green : C.muted }}>
                {copied === "addr" ? "Copied" : "Copy"}
              </span>
            </div>
          </div>

          <div style={{ background: C.surface, border: "1px solid " + C.border,
            borderRadius: 14, padding: 20, minWidth: 220 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
              color: C.muted, marginBottom: 6 }}>BALANCE</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: C.text,
              fontFamily: "Playfair Display, serif", marginBottom: 2 }}>
              {balance ? satsToBtc(balance.total_sats) : "--"}
              <span style={{ fontSize: 14, color: C.muted }}> BTC</span>
            </div>
            {balance && balance.usd_value != null && (
              <div style={{ fontSize: 15, color: C.sub, marginBottom: 8 }}>
                ${balance.usd_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </div>
            )}
            {balance && (
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 14 }}>
                {satsToBtc(balance.confirmed_sats)} confirmed
                {balance.unconfirmed_sats !== 0 && (
                  <span style={{ color: C.orange }}> / {satsToBtc(balance.unconfirmed_sats)} pending</span>
                )}
              </div>
            )}
            <button style={{ ...goldBtn, width: "100%", padding: "11px" }}
              onClick={() => setTab("spend")}>
              Send Bitcoin
            </button>
            {balance && (
              <a href={balance.mempool_url} target="_blank" rel="noreferrer"
                style={{ display: "block", textAlign: "center", marginTop: 10,
                  fontSize: 12, color: C.muted, textDecoration: "none" }}>
                View on mempool.space
              </a>
            )}
          </div>
        </div>

        {govStatus && (
          <GovernancePanel vault={vault} status={govStatus} />
        )}

        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid " + C.border, marginBottom: 24 }}>
          {[
            { id: "overview", label: "Overview" },
            { id: "spend", label: "Send" },
            { id: "proposals", label: "Proposals", count: activeProposals.length },
            { id: "keys", label: "Keys" },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id as typeof tab)} style={{
              padding: "9px 18px", border: "none", borderRadius: "8px 8px 0 0", fontSize: 14,
              cursor: "pointer", fontFamily: "DM Sans, sans-serif",
              background: tab === t.id ? C.surface : "transparent",
              color: tab === t.id ? C.text : C.muted,
              borderBottom: tab === t.id ? "2px solid " + C.gold : "2px solid transparent",
              marginBottom: -1, display: "flex", alignItems: "center", gap: 6,
            }}>
              {t.label}
              {t.count != null && t.count > 0 && (
                <span style={{ background: C.gold, color: C.bg, fontSize: 10,
                  fontWeight: 700, borderRadius: 10, padding: "1px 6px" }}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <OverviewTab vault={vault} copy={copy} copied={copied} />
        )}
        {tab === "spend" && (
          <SpendTab vault={vault} balance={balance} onProposalCreated={() => { void load(); setTab("proposals"); }} />
        )}
        {tab === "proposals" && (
          <ProposalsTab
            vault={vault}
            proposals={proposals}
            activeProposals={activeProposals}
            completedProposals={completedProposals}
            onSelect={setSelectedProposal}
            onRefresh={load}
          />
        )}
        {tab === "keys" && (
          <KeysTab vault={vault} />
        )}
      </main>

      {selectedProposal && (
        <ProposalModal
          vault={vault}
          proposal={selectedProposal}
          onClose={() => setSelectedProposal(null)}
          onRefresh={() => { void load(); setSelectedProposal(null); }}
        />
      )}
    </div>
  );
}

function GovernancePanel({ vault, status }: { vault: Vault; status: GovernanceStatus }) {
  const phase = status.phase;
  const color = phase === "inheritance_unlocked" ? C.green
    : phase === "recovery_unlocked" ? C.blue : C.gold;

  return (
    <div style={{ background: C.surface, border: "1px solid " + C.border,
      borderRadius: 12, padding: "16px 20px", marginBottom: 24,
      borderLeft: "3px solid " + color }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color, marginBottom: 4 }}>
            VAULT STATUS
          </div>
          <div style={{ fontSize: 14, color: C.text }}>{status.status_label}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {status.active_paths.map(path => (
            <span key={path} style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px",
              borderRadius: 4, background: C.green + "22", color: C.green }}>
              {path.replace(/_/g, " ").toUpperCase()}
            </span>
          ))}
        </div>
      </div>
      {(status.days_until_recovery != null || status.days_until_inheritance != null) && (
        <div style={{ display: "flex", gap: 20, marginTop: 12, flexWrap: "wrap" }}>
          {status.days_until_recovery != null && (
            <div style={{ fontSize: 12, color: C.muted }}>
              Recovery unlocks in: <span style={{ color: C.blue }}>
                ~{Math.round(status.days_until_recovery)} days ({status.blocks_until_recovery?.toLocaleString()} blocks)
              </span>
            </div>
          )}
          {status.days_until_inheritance != null && (
            <div style={{ fontSize: 12, color: C.muted }}>
              Inheritance unlocks in: <span style={{ color: C.green }}>
                ~{Math.round(status.days_until_inheritance)} days ({status.blocks_until_inheritance?.toLocaleString()} blocks)
              </span>
            </div>
          )}
        </div>
      )}
      {status.fallback && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          Using JavaScript fallback engine
        </div>
      )}
    </div>
  );
}

function OverviewTab({ vault, copy, copied }: { vault: Vault; copy: (t: string, id: string) => void; copied: string | null }) {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, marginBottom: 24 }}>
        {[
          { num: 1, color: C.gold, title: "Founders Now", body: vault.founder_quorum + " of " + vault.founder_keys.length + " founder signatures. Available immediately." },
          { num: 2, color: C.blue, title: "Recovery - " + blocksToLabel(vault.recovery_after), body: "Unlocks after " + vault.recovery_after.toLocaleString() + " blocks. Same founder quorum." },
          { num: 3, color: C.green, title: "Inheritance - " + blocksToLabel(vault.inheritance_after), body: vault.heir_quorum + " of " + vault.heir_keys.length + " heir signatures after " + vault.inheritance_after.toLocaleString() + " blocks." },
        ].map(p => (
          <div key={p.num} style={{ background: C.surface, border: "1px solid " + C.border,
            borderRadius: 12, padding: 18, borderLeft: "3px solid " + p.color }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: p.color, marginBottom: 5 }}>
              PATH {p.num}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>{p.title}</div>
            <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.5 }}>{p.body}</div>
          </div>
        ))}
      </div>

      <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
        {[
          ["Address type", vault.address_type.toUpperCase()],
          ["Founder quorum", vault.founder_quorum + " of " + vault.founder_keys.length],
          ["Heir quorum", vault.heir_quorum + " of " + vault.heir_keys.length],
          ["Recovery timelock", vault.recovery_after.toLocaleString() + " blocks"],
          ["Inheritance timelock", vault.inheritance_after.toLocaleString() + " blocks"],
          ["Created", new Date(vault.created_at).toLocaleDateString()],
        ].map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between",
            padding: "11px 16px", borderBottom: "1px solid " + C.border }}>
            <span style={{ fontSize: 13, color: C.muted }}>{k}</span>
            <span style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{v}</span>
          </div>
        ))}
      </div>

      <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: C.muted }}>
            OUTPUT DESCRIPTOR
          </span>
          <button style={{ ...ghostBtn, padding: "3px 9px", fontSize: 11 }}
            onClick={() => copy(vault.descriptor, "desc")}>
            {copied === "desc" ? "Copied" : "Copy"}
          </button>
        </div>
        <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
          color: C.sub, wordBreak: "break-all", lineHeight: 1.6 }}>
          {vault.descriptor}
        </div>
      </div>
    </div>
  );
}

function SpendTab({ vault, balance, onProposalCreated }: {
  vault: Vault; balance: BalanceResult | null; onProposalCreated: () => void;
}) {
  const [dest, setDest] = useState("");
  const [amountBtc, setAmountBtc] = useState("");
  const [path, setPath] = useState("founders_now");
  const [memo, setMemo] = useState("");
  const [feeRate, setFeeRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [psbtResult, setPsbtResult] = useState<{
    psbt_hex: string; psbt_b64: string; summary: Record<string, unknown>;
  } | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [signers, setSigners] = useState<LocalKey[]>([]);
  const [signerPsbts, setSignerPsbts] = useState<Record<string, string>>({});
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1600);
  }

  const availableSats = balance ? balance.confirmed_sats : 0;
  const amountSats = Math.round(parseFloat(amountBtc || "0") * 1e8);

  async function buildPsbt(e: React.FormEvent) {
    e.preventDefault();
    if (amountSats < 546) { setErr("Amount too small (min 546 sats / dust limit)"); return; }
    if (amountSats > availableSats) { setErr("Insufficient confirmed balance"); return; }
    setBusy(true); setErr(null);
    try {
      const result = await api.psbt.generate({
        vault_id: vault.id,
        destination: dest.trim(),
        amount_sats: amountSats,
        fee_rate: feeRate ? parseFloat(feeRate) : undefined,
        path,
      });
      setPsbtResult(result as typeof psbtResult);
      const prop = await api.proposals.create({
        vault_id: vault.id,
        destination: dest.trim(),
        amount_sats: amountSats,
        path,
        memo: memo || undefined,
        psbt_hex: result.psbt_hex,
        psbt_b64: result.psbt_b64,
        fee_sats: (result.summary as Record<string, number>).fee_sats,
      });
      setProposal(prop.proposal);
      const localKeys = listKeys().filter(k =>
        k.status === "active" && k.origin === "software"
      );
      setSigners(localKeys);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to build PSBT");
    } finally {
      setBusy(false);
    }
  }

  async function signWithKey(key: LocalKey) {
    const pw = key.testMnemonic ? null : prompt("Enter password for " + key.label + ":");
    if (!key.testMnemonic && pw === null) return;
    setBusy(true); setErr(null);
    try {
      const mnemonic = await revealMnemonic(key.keyId, pw || undefined);
      const seed = mnemonicToSeedSync(mnemonic);
      const networkVersions = vault.network === "bitcoin"
        ? { private: 0x0488ade4, public: 0x0488b21e }
        : { private: 0x04358394, public: 0x043587cf };
      const root = HDKey.fromMasterSeed(seed, networkVersions);
      const signingKey = root.derive(key.derivationPath);
      if (!signingKey.privateKey) throw new Error("Could not derive signing key");
      alert("Browser signing is in progress. For now, export the PSBT to Sparrow to sign with this key:\n\nFingerprint: " + key.fingerprint + "\nPath: " + key.derivationPath);
      setSignerPsbts(prev => ({ ...prev, [key.keyId]: psbtResult!.psbt_hex }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Signing failed");
    } finally {
      setBusy(false);
    }
  }

  async function mergePsbts() {
    const psbts = Object.values(signerPsbts);
    if (psbts.length < 2) { setErr("Need at least 2 signed PSBTs to merge"); return; }
    setBusy(true); setErr(null);
    try {
      const result = await api.psbt.merge({ vault_id: vault.id, proposal_id: proposal?.id, psbts });
      setPsbtResult(prev => prev ? { ...prev, psbt_hex: result.psbt_hex, psbt_b64: result.psbt_b64 } : null);
      if (result.fully_signed && proposal) {
        await api.proposals.update(proposal.id, { status: "signed", psbt_signed_hex: result.psbt_hex });
        setProposal(prev => prev ? { ...prev, status: "signed" } : null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setBusy(false);
    }
  }

  async function broadcast() {
    if (!psbtResult) return;
    setBusy(true); setErr(null);
    try {
      const finalized = await api.psbt.finalize(psbtResult.psbt_hex);
      const txid = await api.broadcast(finalized.raw_tx_hex, vault.network);
      if (proposal) {
        await api.proposals.update(proposal.id, { status: "broadcast", txid: txid.trim() });
      }
      setBroadcastResult(txid.trim());
      onProposalCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Broadcast failed");
    } finally {
      setBusy(false);
    }
  }

  if (broadcastResult) {
    const explorerBase = vault.network === "bitcoin"
      ? "https://mempool.space/tx/"
      : "https://mempool.space/testnet/tx/";
    return (
      <div style={{ background: C.surface, border: "1px solid " + C.green + "44",
        borderRadius: 12, padding: 28, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>Done!</div>
        <div style={{ fontSize: 20, fontWeight: 600, color: C.green, marginBottom: 8 }}>
          Transaction broadcast!
        </div>
        <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, color: C.muted,
          marginBottom: 16, wordBreak: "break-all" }}>
          {broadcastResult}
        </div>
        <a href={explorerBase + broadcastResult} target="_blank" rel="noreferrer"
          style={{ color: C.gold, fontSize: 14 }}>
          View on mempool.space
        </a>
      </div>
    );
  }

  if (psbtResult) {
    const summary = psbtResult.summary as Record<string, number | string>;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ background: C.surface, border: "1px solid " + C.border,
          borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 14 }}>
            Transaction Summary
          </div>
          {[
            ["To", String(summary.destination)],
            ["Amount", satsToBtc(Number(summary.amount_sats)) + " BTC"],
            ["Fee", satsToBtc(Number(summary.fee_sats)) + " BTC (" + summary.fee_rate + " sat/vb)"],
            ["Change", satsToBtc(Number(summary.change_sats)) + " BTC"],
            ["Inputs", String(summary.input_count)],
            ["Path", String(summary.path).replace(/_/g, " ")],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between",
              padding: "8px 0", borderBottom: "1px solid " + C.border }}>
              <span style={{ fontSize: 13, color: C.muted }}>{k}</span>
              <span style={{ fontSize: 13, color: C.text, fontFamily: k === "To" ? "IBM Plex Mono, monospace" : "inherit" }}>{v}</span>
            </div>
          ))}
        </div>

        <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 12, padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Unsigned PSBT</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...ghostBtn, fontSize: 12, padding: "4px 10px" }}
                onClick={() => copy(psbtResult.psbt_hex, "hex")}>
                {copied === "hex" ? "Copied" : "Copy hex"}
              </button>
              <button style={{ ...ghostBtn, fontSize: 12, padding: "4px 10px" }}
                onClick={() => copy(psbtResult.psbt_b64, "b64")}>
                {copied === "b64" ? "Copied" : "Copy base64"}
              </button>
            </div>
          </div>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.muted,
            wordBreak: "break-all", lineHeight: 1.5, maxHeight: 80, overflow: "hidden",
            background: "#0A0A14", borderRadius: 8, padding: 10 }}>
            {psbtResult.psbt_hex}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
            Import this PSBT into Sparrow Wallet or Nunchuk to sign. Each required signer must sign separately.
          </div>
        </div>

        {signers.length > 0 && (
          <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 12, padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 14 }}>
              Sign with browser keys
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
              These software keys are stored in your browser. Tap to sign.
            </div>
            {signers.map(key => (
              <div key={key.keyId} style={{ display: "flex", justifyContent: "space-between",
                alignItems: "center", padding: "10px 14px",
                background: signerPsbts[key.keyId] ? C.green + "11" : "#0A0A14",
                border: "1px solid " + (signerPsbts[key.keyId] ? C.green + "44" : C.border),
                borderRadius: 8, marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{key.label}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>
                    {key.persona} / {key.fingerprint}
                  </div>
                </div>
                {signerPsbts[key.keyId] ? (
                  <span style={{ fontSize: 12, color: C.green }}>Signed</span>
                ) : (
                  <button style={{ ...ghostBtn, fontSize: 12 }} onClick={() => void signWithKey(key)}>
                    Sign
                  </button>
                )}
              </div>
            ))}
            {Object.keys(signerPsbts).length >= 2 && (
              <button style={{ ...goldBtn, width: "100%", marginTop: 10 }} onClick={() => void mergePsbts()}>
                Merge signatures
              </button>
            )}
          </div>
        )}

        <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 10 }}>
            Import signed PSBT
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
            After signing in Sparrow/Nunchuk/Coldcard, paste the signed PSBT hex here.
          </div>
          <ImportSignedPsbt
            vault={vault}
            proposalId={proposal?.id}
            requiredQuorum={vault.founder_quorum}
            onSigned={(signedHex) => {
              setPsbtResult(prev => prev ? { ...prev, psbt_hex: signedHex } : null);
            }}
            onFullySigned={(signedHex) => {
              setPsbtResult(prev => prev ? { ...prev, psbt_hex: signedHex } : null);
              setProposal(prev => prev ? { ...prev, status: "signed" } : null);
            }}
          />
        </div>

        {proposal?.status === "signed" && (
          <div style={{ background: "#0A1400", border: "1px solid " + C.green + "44",
            borderRadius: 12, padding: 20, textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.green, marginBottom: 8 }}>
              All signatures collected
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
              The transaction is ready to broadcast to the Bitcoin network.
            </div>
            <button style={{ ...goldBtn, background: C.green }} onClick={() => void broadcast()}>
              Broadcast transaction
            </button>
          </div>
        )}

        {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}

        <button style={ghostBtn} onClick={() => { setPsbtResult(null); setProposal(null); setSignerPsbts({}); }}>
          Start over
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={e => void buildPsbt(e)} style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
      <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 16 }}>New spend</div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Spending path</label>
          <select style={inp} value={path} onChange={e => setPath(e.target.value)}>
            <option value="founders_now">Founders - available now</option>
            <option value="recovery">Founder recovery (after {blocksToLabel(vault.recovery_after)})</option>
            <option value="inheritance">Heir inheritance (after {blocksToLabel(vault.inheritance_after)})</option>
          </select>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Destination address</label>
          <input style={monoInp} value={dest} onChange={e => setDest(e.target.value)}
            required placeholder="tb1p... or bc1p..." />
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 2 }}>
            <label style={lbl}>Amount (BTC)</label>
            <input style={inp} type="number" step="0.00000001" min="0.00000546"
              value={amountBtc} onChange={e => setAmountBtc(e.target.value)} required placeholder="0.001" />
            {availableSats > 0 && (
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                Available: {satsToBtc(availableSats)} BTC
                <button type="button" style={{ background: "none", border: "none",
                  color: C.gold, cursor: "pointer", fontSize: 11, marginLeft: 8 }}
                  onClick={() => {
                    const maxSats = availableSats - 2000;
                    if (maxSats > 0) setAmountBtc((maxSats / 1e8).toFixed(8));
                  }}>
                  Max
                </button>
              </div>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Fee rate (sat/vb)</label>
            <input style={inp} type="number" step="0.1" min="1"
              value={feeRate} onChange={e => setFeeRate(e.target.value)} placeholder="Auto" />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={lbl}>Memo (optional)</label>
          <input style={inp} value={memo} onChange={e => setMemo(e.target.value)}
            placeholder="Reason for this spend" />
        </div>

        {err && <p style={{ color: C.red, fontSize: 13, marginBottom: 8 }}>{err}</p>}

        <button type="submit" style={{ ...goldBtn, width: "100%", opacity: busy ? 0.6 : 1 }} disabled={busy}>
          {busy ? "Building PSBT..." : "Build transaction"}
        </button>
      </div>
    </form>
  );
}

function ImportSignedPsbt({ vault, proposalId, requiredQuorum, onSigned, onFullySigned }: {
  vault: Vault;
  proposalId?: string;
  requiredQuorum: number;
  onSigned: (hex: string) => void;
  onFullySigned: (hex: string) => void;
}) {
  const [psbtHex, setPsbtHex] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sigCount, setSigCount] = useState(0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (sigCount === 0) {
        onSigned(psbtHex.trim());
        setSigCount(1);
      } else {
        const result = await api.psbt.merge({
          vault_id: vault.id,
          proposal_id: proposalId,
          psbts: [psbtHex.trim()],
        });
        setSigCount(result.signature_count);
        if (result.fully_signed) {
          onFullySigned(result.psbt_hex);
        } else {
          onSigned(result.psbt_hex);
        }
      }
      setPsbtHex("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={e => void submit(e)}>
      {sigCount > 0 && (
        <div style={{ fontSize: 13, color: C.gold, marginBottom: 10 }}>
          {sigCount} of {requiredQuorum} signatures collected
        </div>
      )}
      <textarea style={{ ...monoInp, resize: "vertical", width: "100%", boxSizing: "border-box" }}
        rows={3} value={psbtHex} onChange={e => setPsbtHex(e.target.value)}
        placeholder="70736274ff... (paste signed PSBT hex)" />
      {err && <p style={{ color: C.red, fontSize: 12, marginTop: 4 }}>{err}</p>}
      <button type="submit" style={{ ...ghostBtn, marginTop: 8, opacity: busy || !psbtHex ? 0.5 : 1 }}
        disabled={busy || !psbtHex}>
        {busy ? "Processing..." : sigCount === 0 ? "Submit signature" : "Add signature"}
      </button>
    </form>
  );
}

function ProposalsTab({ vault, proposals, activeProposals, completedProposals, onSelect, onRefresh }: {
  vault: Vault;
  proposals: Proposal[];
  activeProposals: Proposal[];
  completedProposals: Proposal[];
  onSelect: (p: Proposal) => void;
  onRefresh: () => void;
}) {
  void proposals; void onRefresh;
  return (
    <div>
      {activeProposals.length === 0 && completedProposals.length === 0 && (
        <p style={{ color: C.muted, fontSize: 14 }}>No proposals yet. Use the Send tab to create one.</p>
      )}
      {activeProposals.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em",
            color: C.muted, marginBottom: 10 }}>ACTIVE</div>
          {activeProposals.map(p => (
            <ProposalRow key={p.id} proposal={p} vault={vault} onClick={() => onSelect(p)} />
          ))}
        </div>
      )}
      {completedProposals.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em",
            color: C.muted, marginBottom: 10 }}>COMPLETED</div>
          {completedProposals.map(p => (
            <ProposalRow key={p.id} proposal={p} vault={vault} onClick={() => onSelect(p)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalRow({ proposal: p, vault, onClick }: { proposal: Proposal; vault: Vault; onClick: () => void }) {
  const sc = statusColor(p.status);
  return (
    <div onClick={onClick} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "14px 16px", background: C.surface, border: "1px solid " + C.border,
      borderRadius: 10, marginBottom: 8, cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: sc, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.text,
            fontFamily: "Playfair Display, serif" }}>
            {satsToBtc(p.amount_sats)} BTC
          </div>
          <div style={{ fontSize: 12, color: C.muted, fontFamily: "IBM Plex Mono, monospace" }}>
            {p.destination.slice(0, 18)}...
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          padding: "3px 8px", borderRadius: 4,
          background: sc + "22", color: sc, textTransform: "uppercase" }}>
          {p.status}
        </span>
        {p.txid && (
          <a href={"https://mempool.space/" + (vault.network === "bitcoin" ? "" : "testnet/") + "tx/" + p.txid}
            target="_blank" rel="noreferrer"
            style={{ fontSize: 12, color: C.gold, textDecoration: "none" }}
            onClick={e => e.stopPropagation()}>
            Tx
          </a>
        )}
      </div>
    </div>
  );
}

function ProposalModal({ vault, proposal: p, onClose, onRefresh }: {
  vault: Vault; proposal: Proposal; onClose: () => void; onRefresh: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1600);
  }

  async function cancel() {
    if (!confirm("Cancel this proposal?")) return;
    try {
      await api.proposals.update(p.id, { status: "cancelled" });
      onRefresh();
    } catch (e) { alert(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 16,
        padding: "28px 32px", width: "100%", maxWidth: 560,
        maxHeight: "90vh", overflowY: "auto", fontFamily: "DM Sans, sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: C.text,
            fontFamily: "Playfair Display, serif", margin: 0 }}>
            {satsToBtc(p.amount_sats)} BTC
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none",
            color: C.muted, fontSize: 18, cursor: "pointer" }}>x</button>
        </div>

        <div style={{ background: "#0A0A14", borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
          {[
            ["Status", p.status.toUpperCase()],
            ["Path", p.path.replace(/_/g, " ")],
            ["Destination", p.destination],
            ["Amount", satsToBtc(p.amount_sats) + " BTC"],
            ["Fee", p.fee_sats ? satsToBtc(p.fee_sats) + " BTC" : "--"],
            ["Memo", p.memo || "--"],
            ["Created", new Date(p.created_at).toLocaleDateString()],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between",
              padding: "9px 14px", borderBottom: "1px solid " + C.border }}>
              <span style={{ fontSize: 12, color: C.muted }}>{k}</span>
              <span style={{ fontSize: 13, color: C.text,
                fontFamily: k === "Destination" ? "IBM Plex Mono, monospace" : "inherit",
                wordBreak: "break-all", textAlign: "right", maxWidth: "60%" }}>{v}</span>
            </div>
          ))}
        </div>

        {p.txid && (
          <a href={"https://mempool.space/" + (vault.network === "bitcoin" ? "" : "testnet/") + "tx/" + p.txid}
            target="_blank" rel="noreferrer"
            style={{ display: "block", textAlign: "center", marginBottom: 16,
              color: C.gold, fontSize: 14, textDecoration: "none" }}>
            View transaction on mempool.space
          </a>
        )}

        {p.psbt_hex && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.muted, letterSpacing: "0.08em" }}>
                PSBT
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ ...ghostBtn, padding: "3px 9px", fontSize: 11 }}
                  onClick={() => copy(p.psbt_hex!, "psbt_hex")}>
                  {copied === "psbt_hex" ? "Copied" : "Copy hex"}
                </button>
                {p.psbt_b64 && (
                  <button style={{ ...ghostBtn, padding: "3px 9px", fontSize: 11 }}
                    onClick={() => copy(p.psbt_b64!, "psbt_b64")}>
                    {copied === "psbt_b64" ? "Copied" : "Copy base64"}
                  </button>
                )}
              </div>
            </div>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.muted,
              wordBreak: "break-all", background: "#0A0A14", borderRadius: 8, padding: 10,
              maxHeight: 80, overflow: "hidden", lineHeight: 1.5 }}>
              {p.psbt_hex}
            </div>
          </div>
        )}

        {p.status !== "broadcast" && p.status !== "cancelled" && (
          <button style={{ ...ghostBtn, color: C.red, borderColor: "#3A1A1A", width: "100%" }}
            onClick={() => void cancel()}>
            Cancel proposal
          </button>
        )}
      </div>
    </div>
  );
}

function KeysTab({ vault }: { vault: Vault }) {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 10 }}>
          Founder Keys ({vault.founder_keys.length})
        </div>
        {vault.founder_keys.map((k, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12,
            padding: "10px 14px", background: C.surface, border: "1px solid " + C.border,
            borderRadius: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, background: "#2A1F0A",
              color: C.gold, padding: "3px 7px", borderRadius: 4, flexShrink: 0 }}>F{i + 1}</span>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
              color: C.sub, wordBreak: "break-all" }}>{k}</span>
          </div>
        ))}
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 10 }}>
          Heir Keys ({vault.heir_keys.length})
        </div>
        {vault.heir_keys.map((k, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12,
            padding: "10px 14px", background: C.surface, border: "1px solid " + C.border,
            borderRadius: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, background: "#0A1F14",
              color: C.green, padding: "3px 7px", borderRadius: 4, flexShrink: 0 }}>H{i + 1}</span>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
              color: C.sub, wordBreak: "break-all" }}>{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
