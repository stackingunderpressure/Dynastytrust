import { useEffect, useState, useCallback } from "react";
import { api, type Vault, type Proposal, type BalanceResult } from "../lib/api";
import { listKeys, revealMnemonic, type LocalKey } from "../lib/keystore";
import { signPsbtWithMnemonic, countSignatures, mergePsbts } from "../lib/psbt-signer";

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
  padding: "11px 22px", background: C.gold, border: "none", borderRadius: 8,
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

interface Props { vault: Vault; onBack: () => void; }

export default function VaultDetail({ vault, onBack }: Props) {
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [tab, setTab] = useState<"overview" | "send" | "history">("overview");
  const [archiving, setArchiving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [balRes, propRes] = await Promise.allSettled([
      api.balance(vault.address, vault.network),
      api.proposals.list(vault.id),
    ]);
    if (balRes.status === "fulfilled") setBalance(balRes.value);
    if (propRes.status === "fulfilled") setProposals(propRes.value.proposals);
  }, [vault]);

  useEffect(() => { void load(); }, [load]);

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1600);
  }

  async function archive() {
    if (!confirm("Archive " + vault.name + "?")) return;
    setArchiving(true);
    try { await api.vaults.archive(vault.id); onBack(); }
    catch (e) { alert(e instanceof Error ? e.message : "Failed"); }
    finally { setArchiving(false); }
  }

  const pendingCount = proposals.filter(
    p => p.status !== "broadcast" && p.status !== "cancelled"
  ).length;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "DM Sans, sans-serif" }}>
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 20px", height: 56, borderBottom: "1px solid " + C.border,
        background: "#0A0A12", position: "sticky", top: 0, zIndex: 50,
      }}>
        <button onClick={onBack} style={{
          background: "none", border: "none", color: C.muted,
          fontSize: 14, cursor: "pointer", fontFamily: "DM Sans, sans-serif",
        }}>Back</button>
        <span style={{
          fontFamily: "Playfair Display, serif", fontSize: 15,
          fontWeight: 700, letterSpacing: "0.12em", color: C.gold,
        }}>DYNASTYTRUST</span>
        <button onClick={archive} disabled={archiving} style={{
          ...ghostBtn, fontSize: 12, color: C.red, borderColor: "#3A1A1A",
        }}>Archive</button>
      </header>

      <main style={{ maxWidth: 680, margin: "0 auto", padding: "24px 16px" }}>

        {/* Balance hero */}
        <div style={{
          background: C.surface, border: "1px solid " + C.border,
          borderRadius: 16, padding: "24px 20px", marginBottom: 20,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: C.muted, marginBottom: 4 }}>
            {vault.name.toUpperCase()} / {vault.network === "bitcoin" ? "MAINNET" : "TESTNET"}
          </div>
          <div style={{
            fontSize: 36, fontWeight: 700, color: C.text,
            fontFamily: "Playfair Display, serif", margin: "8px 0 4px",
          }}>
            {balance ? satsToBtc(balance.total_sats) : "--"}
            <span style={{ fontSize: 18, color: C.muted }}> BTC</span>
          </div>
          {balance?.usd_value != null && (
            <div style={{ fontSize: 18, color: C.sub, marginBottom: 8 }}>
              ${balance.usd_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </div>
          )}
          {balance && balance.unconfirmed_sats !== 0 && (
            <div style={{ fontSize: 12, color: C.orange, marginBottom: 8 }}>
              + {satsToBtc(balance.unconfirmed_sats)} BTC unconfirmed
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button style={{ ...goldBtn, flex: 1, padding: "12px" }}
              onClick={() => setTab("send")}>
              Send
            </button>
            <button style={{ ...ghostBtn, fontSize: 12 }}
              onClick={() => copy(vault.address, "addr")}>
              {copied === "addr" ? "Copied!" : "Copy address"}
            </button>
            {balance && (
              <a href={balance.mempool_url} target="_blank" rel="noreferrer"
                style={{ ...ghostBtn, fontSize: 12, textDecoration: "none", display: "flex", alignItems: "center" }}>
                Explorer
              </a>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div style={{
          display: "flex", gap: 2, borderBottom: "1px solid " + C.border, marginBottom: 20,
        }}>
          {[
            { id: "overview", label: "Overview" },
            { id: "send", label: "Send" },
            { id: "history", label: "History", count: pendingCount },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id as typeof tab)} style={{
              padding: "9px 18px", border: "none", fontSize: 14,
              cursor: "pointer", fontFamily: "DM Sans, sans-serif",
              background: "transparent",
              color: tab === t.id ? C.text : C.muted,
              borderBottom: tab === t.id ? "2px solid " + C.gold : "2px solid transparent",
              marginBottom: -1,
              display: "flex", alignItems: "center", gap: 6,
            }}>
              {t.label}
              {t.count != null && t.count > 0 && (
                <span style={{
                  background: C.orange, color: C.bg,
                  fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 6px",
                }}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <OverviewTab vault={vault} copy={copy} copied={copied} />
        )}
        {tab === "send" && (
          <SendTab
            vault={vault}
            balance={balance}
            onDone={() => { void load(); setTab("history"); }}
          />
        )}
        {tab === "history" && (
          <HistoryTab vault={vault} proposals={proposals} onRefresh={load} />
        )}
      </main>
    </div>
  );
}

// // -- Overview tab

function OverviewTab({ vault, copy, copied }: {
  vault: Vault;
  copy: (text: string, id: string) => void;
  copied: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Spending paths */}
      {[
        { num: 1, color: C.gold, title: "Founders - Now", body: vault.founder_quorum + " of " + vault.founder_keys.length + " founder signatures required. Available at any time." },
        { num: 2, color: C.blue, title: "Recovery - " + blocksToLabel(vault.recovery_after), body: "Founders can recover after " + vault.recovery_after.toLocaleString() + " blocks using a separate path." },
        { num: 3, color: C.green, title: "Inheritance - " + blocksToLabel(vault.inheritance_after), body: vault.heir_quorum + " of " + vault.heir_keys.length + " heir signatures after " + vault.inheritance_after.toLocaleString() + " blocks." },
      ].map(p => (
        <div key={p.num} style={{
          background: C.surface, border: "1px solid " + C.border,
          borderRadius: 12, padding: "14px 16px",
          borderLeft: "3px solid " + p.color,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: p.color, marginBottom: 4 }}>
            PATH {p.num}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>{p.title}</div>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.5 }}>{p.body}</div>
        </div>
      ))}

      {/* Details */}
      <div style={{
        background: C.surface, border: "1px solid " + C.border,
        borderRadius: 12, overflow: "hidden",
      }}>
        {[
          ["Address type", vault.address_type.toUpperCase()],
          ["Founder quorum", vault.founder_quorum + " of " + vault.founder_keys.length],
          ["Heir quorum", vault.heir_quorum + " of " + vault.heir_keys.length],
          ["Recovery", vault.recovery_after.toLocaleString() + " blocks"],
          ["Inheritance", vault.inheritance_after.toLocaleString() + " blocks"],
        ].map(([k, v]) => (
          <div key={k} style={{
            display: "flex", justifyContent: "space-between",
            padding: "11px 16px", borderBottom: "1px solid " + C.border,
          }}>
            <span style={{ fontSize: 13, color: C.muted }}>{k}</span>
            <span style={{ fontSize: 13, color: C.text }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Descriptor */}
      <div style={{
        background: C.surface, border: "1px solid " + C.border, borderRadius: 12, padding: 16,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: C.muted }}>
            DESCRIPTOR
          </span>
          <button style={{ ...ghostBtn, padding: "3px 9px", fontSize: 11 }}
            onClick={() => copy(vault.descriptor, "desc")}>
            {copied === "desc" ? "Copied" : "Copy"}
          </button>
        </div>
        <div style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: C.sub,
          wordBreak: "break-all", lineHeight: 1.6,
        }}>{vault.descriptor}</div>
      </div>
    </div>
  );
}

// // -- Send tab
// Clean Nunchuk-style: fill form -> sign automatically -> broadcast

type SendStep = "form" | "signing" | "done";

interface SigningState {
  psbt_hex: string;
  psbt_b64: string;
  summary: {
    amount_sats: number;
    fee_sats: number;
    change_sats: number;
    fee_rate: number;
    destination: string;
  };
  proposal_id?: string;
  signers: Array<{ key: LocalKey; status: "pending" | "signing" | "signed" | "error"; error?: string }>;
  signaturesCollected: number;
  requiredSignatures: number;
  txid?: string;
}

function SendTab({ vault, balance, onDone }: {
  vault: Vault;
  balance: BalanceResult | null;
  onDone: () => void;
}) {
  const [step, setStep] = useState<SendStep>("form");
  const [dest, setDest] = useState("");
  const [amountBtc, setAmountBtc] = useState("");
  const [feeRate, setFeeRate] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signing, setSigning] = useState<SigningState | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1600);
  }

  const confirmedSats = balance?.confirmed_sats ?? 0;
  const amountSats = Math.round(parseFloat(amountBtc || "0") * 1e8);

  async function buildAndSign(e: React.FormEvent) {
    e.preventDefault();
    if (amountSats < 546) { setErr("Minimum 546 sats (dust limit)"); return; }
    if (amountSats > confirmedSats) { setErr("Insufficient confirmed balance"); return; }
    setBusy(true); setErr(null);

    try {
      // 1. Build PSBT via Fly.io
      const psbtRes = await api.psbt.generate({
        vault_id: vault.id,
        destination: dest.trim(),
        amount_sats: amountSats,
        fee_rate: feeRate ? parseFloat(feeRate) : undefined,
        path: "founders_now",
      }) as {
        ok: boolean;
        psbt_hex: string;
        psbt_b64: string;
        summary: {
          amount_sats: number;
          fee_sats: number;
          change_sats: number;
          fee_rate: number;
          destination: string;
        };
        status?: string;
        message?: string;
      };

      if (psbtRes.status === "no_utxos") {
        setErr("No confirmed UTXOs. Fund the vault and wait for confirmation.");
        setBusy(false);
        return;
      }

      // 2. Save proposal
      const propRes = await api.proposals.create({
        vault_id: vault.id,
        destination: dest.trim(),
        amount_sats: amountSats,
        path: "founders_now",
        memo: memo || undefined,
        psbt_hex: psbtRes.psbt_hex,
        psbt_b64: psbtRes.psbt_b64,
        fee_sats: psbtRes.summary.fee_sats,
      });

      // 3. Find local software keys that could sign
      const localKeys = listKeys().filter(k => k.status === "active" && k.origin === "software");

      setSigning({
        psbt_hex: psbtRes.psbt_hex,
        psbt_b64: psbtRes.psbt_b64,
        summary: psbtRes.summary,
        proposal_id: propRes.proposal.id,
        signers: localKeys.map(key => ({ key, status: "pending" })),
        signaturesCollected: 0,
        requiredSignatures: vault.founder_quorum,
      });
      setStep("signing");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to build transaction");
    } finally {
      setBusy(false);
    }
  }

  async function signWithKey(keyIndex: number) {
    if (!signing) return;
    const signerEntry = signing.signers[keyIndex];
    const key = signerEntry.key;

    // Update status to signing
    setSigning(prev => {
      if (!prev) return prev;
      const signers = [...prev.signers];
      signers[keyIndex] = { ...signers[keyIndex], status: "signing" };
      return { ...prev, signers };
    });

    try {
      // Get mnemonic
      let pw: string | undefined;
      if (!key.testMnemonic) {
        const result = prompt("Password for " + key.label + ":");
        if (result === null) {
          setSigning(prev => {
            if (!prev) return prev;
            const signers = [...prev.signers];
            signers[keyIndex] = { ...signers[keyIndex], status: "pending" };
            return { ...prev, signers };
          });
          return;
        }
        pw = result;
      }

      const mnemonic = await revealMnemonic(key.keyId, pw);

      // Get current best PSBT (may already have some sigs)
      const currentPsbt = signing.psbt_hex;

      // Sign
      const result = await signPsbtWithMnemonic(
        currentPsbt,
        mnemonic,
        key.derivationPath,
        vault.network
      );

      // Merge with existing signed PSBTs from other keys
      const signedByOthers = signing.signers
        .filter((s, i) => i !== keyIndex && s.status === "signed")
        .map(s => (s as typeof s & { psbt: string }).psbt)
        .filter(Boolean);

      const allPsbts = [result.psbt_hex, ...signedByOthers];
      const mergedHex = allPsbts.length > 1 ? mergePsbts(allPsbts) : result.psbt_hex;
      const totalSigs = countSignatures(mergedHex);

      setSigning(prev => {
        if (!prev) return prev;
        const signers = [...prev.signers];
        (signers[keyIndex] as typeof signers[number] & { psbt: string }).psbt = result.psbt_hex;
        signers[keyIndex] = { ...signers[keyIndex], status: "signed" };
        return { ...prev, signers, psbt_hex: mergedHex, signaturesCollected: totalSigs };
      });

    } catch (e) {
      setSigning(prev => {
        if (!prev) return prev;
        const signers = [...prev.signers];
        signers[keyIndex] = { ...signers[keyIndex], status: "error", error: e instanceof Error ? e.message : "Failed" };
        return { ...prev, signers };
      });
    }
  }

  async function broadcast() {
    if (!signing) return;
    setBusy(true);
    try {
      // Finalize via Fly.io
      const finalized = await api.psbt.finalize(signing.psbt_hex);

      // Broadcast to mempool.space
      const mempoolBase = vault.network === "bitcoin"
        ? "https://mempool.space/api/tx"
        : "https://mempool.space/testnet/api/tx";

      const res = await fetch(mempoolBase, {
        method: "POST",
        body: finalized.raw_tx_hex,
        headers: { "Content-Type": "text/plain" },
      });
      const txid = (await res.text()).trim();

      if (!res.ok || txid.length !== 64) {
        throw new Error("Broadcast failed: " + txid.slice(0, 100));
      }

      // Update proposal
      if (signing.proposal_id) {
        await api.proposals.update(signing.proposal_id, { status: "broadcast", txid });
      }

      setSigning(prev => prev ? { ...prev, txid } : prev);
      setStep("done");
      setTimeout(onDone, 3000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Broadcast failed");
    } finally {
      setBusy(false);
    }
  }

  // Done screen
  if (step === "done" && signing?.txid) {
    const explorerBase = vault.network === "bitcoin"
      ? "https://mempool.space/tx/"
      : "https://mempool.space/testnet/tx/";
    return (
      <div style={{
        background: "#0A1A0A", border: "1px solid " + C.green + "44",
        borderRadius: 16, padding: 32, textAlign: "center",
      }}>
        <div style={{ fontSize: 52, marginBottom: 12 }}>sent</div>
        <div style={{ fontSize: 20, fontWeight: 600, color: C.green, marginBottom: 8 }}>
          Transaction broadcast
        </div>
        <div style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
          color: C.muted, marginBottom: 20, wordBreak: "break-all",
        }}>{signing.txid}</div>
        <a href={explorerBase + signing.txid} target="_blank" rel="noreferrer"
          style={{ color: C.gold, fontSize: 14 }}>
          View on mempool.space
        </a>
      </div>
    );
  }

  // Signing screen
  if (step === "signing" && signing) {
    const quorumMet = signing.signaturesCollected >= signing.requiredSignatures;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Summary card */}
        <div style={{
          background: C.surface, border: "1px solid " + C.border,
          borderRadius: 12, padding: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 14 }}>
            Transaction
          </div>
          {[
            ["To", signing.summary.destination],
            ["Amount", satsToBtc(signing.summary.amount_sats) + " BTC"],
            ["Fee", satsToBtc(signing.summary.fee_sats) + " BTC (~" + signing.summary.fee_rate + " sat/vb)"],
            ["Change back", satsToBtc(signing.summary.change_sats) + " BTC"],
          ].map(([k, v]) => (
            <div key={k} style={{
              display: "flex", justifyContent: "space-between",
              padding: "8px 0", borderBottom: "1px solid " + C.border,
            }}>
              <span style={{ fontSize: 13, color: C.muted }}>{k}</span>
              <span style={{
                fontSize: 13, color: C.text,
                fontFamily: k === "To" ? "IBM Plex Mono, monospace" : "inherit",
                wordBreak: "break-all", textAlign: "right", maxWidth: "60%",
              }}>{v}</span>
            </div>
          ))}

          {/* Signature progress */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: C.muted }}>Signatures</span>
              <span style={{ fontSize: 12, color: quorumMet ? C.green : C.orange }}>
                {signing.signaturesCollected} / {signing.requiredSignatures} required
              </span>
            </div>
            <div style={{ height: 4, background: C.border, borderRadius: 2 }}>
              <div style={{
                height: "100%", borderRadius: 2,
                background: quorumMet ? C.green : C.gold,
                width: Math.min(100, (signing.signaturesCollected / signing.requiredSignatures) * 100) + "%",
                transition: "width 0.3s",
              }} />
            </div>
          </div>
        </div>

        {/* Browser keys signing */}
        {signing.signers.length > 0 && (
          <div style={{
            background: C.surface, border: "1px solid " + C.border,
            borderRadius: 12, padding: 20,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>
              Sign with browser keys
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
              Tap a key to sign. {signing.requiredSignatures > 1 ? "Need " + signing.requiredSignatures + " signatures." : "Only 1 signature needed."}
            </div>
            {signing.signers.map((signer, i) => {
              const statusIcon = signer.status === "signed" ? "Signed" :
                signer.status === "signing" ? "Signing..." :
                signer.status === "error" ? "Error" : "Tap to sign";
              const statusColor2 = signer.status === "signed" ? C.green :
                signer.status === "error" ? C.red :
                signer.status === "signing" ? C.gold : C.muted;
              return (
                <div key={signer.key.keyId} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "12px 14px", borderRadius: 10, marginBottom: 8,
                  background: signer.status === "signed" ? C.green + "0D" : "#0A0A14",
                  border: "1px solid " + (signer.status === "signed" ? C.green + "44" : C.border),
                  cursor: signer.status === "pending" ? "pointer" : "default",
                  opacity: signer.status === "signing" ? 0.7 : 1,
                }} onClick={() => signer.status === "pending" && void signWithKey(i)}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: C.text }}>
                      {signer.key.label}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted }}>
                      {signer.key.persona} / {signer.key.fingerprint}
                      {signer.key.testMnemonic ? " / test key" : ""}
                    </div>
                    {signer.error && (
                      <div style={{ fontSize: 11, color: C.red, marginTop: 4 }}>{signer.error}</div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: statusColor2 }}>
                    {statusIcon}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Hardware wallet / external PSBT */}
        <div style={{
          background: C.surface, border: "1px solid " + C.border,
          borderRadius: 12, padding: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>
            Sign with hardware wallet
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
            Export to Sparrow, Nunchuk, or Coldcard. Paste the signed PSBT back here.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button style={{ ...ghostBtn, fontSize: 12 }}
              onClick={() => { navigator.clipboard.writeText(signing.psbt_hex); setCopied("hex"); setTimeout(() => setCopied(null), 1600); }}>
              {copied === "hex" ? "Copied!" : "Copy PSBT hex"}
            </button>
            <button style={{ ...ghostBtn, fontSize: 12 }}
              onClick={() => { navigator.clipboard.writeText(signing.psbt_b64); setCopied("b64"); setTimeout(() => setCopied(null), 1600); }}>
              {copied === "b64" ? "Copied!" : "Copy base64"}
            </button>
          </div>
          <ExternalPsbtInput
            currentPsbt={signing.psbt_hex}
            onImport={(importedHex) => {
              const merged = mergePsbts([signing.psbt_hex, importedHex]);
              const totalSigs = countSignatures(merged);
              setSigning(prev => prev ? { ...prev, psbt_hex: merged, signaturesCollected: totalSigs } : prev);
            }}
          />
        </div>

        {/* Action buttons */}
        {err && <p style={{ color: C.red, fontSize: 13, margin: 0 }}>{err}</p>}

        {quorumMet ? (
          <button style={{ ...goldBtn, background: C.green, width: "100%", padding: "14px", fontSize: 16, opacity: busy ? 0.6 : 1 }}
            disabled={busy} onClick={() => void broadcast()}>
            {busy ? "Broadcasting..." : "Broadcast transaction"}
          </button>
        ) : (
          <div style={{ fontSize: 13, color: C.muted, textAlign: "center", padding: "10px 0" }}>
            {signing.requiredSignatures - signing.signaturesCollected} more signature{signing.requiredSignatures - signing.signaturesCollected !== 1 ? "s" : ""} needed
          </div>
        )}

        <button style={{ ...ghostBtn, width: "100%" }}
          onClick={() => { setStep("form"); setSigning(null); setErr(null); }}>
          Cancel
        </button>
      </div>
    );
  }

  // Form screen
  return (
    <form onSubmit={e => void buildAndSign(e)}
      style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 480 }}>

      <div>
        <label style={lbl}>Send to</label>
        <input style={monoInp} value={dest} onChange={e => setDest(e.target.value)}
          required placeholder="tb1p... or bc1p..." />
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 2 }}>
          <label style={lbl}>Amount (BTC)</label>
          <input style={inp} type="number" step="0.00000001" min="0.00000546"
            value={amountBtc} onChange={e => setAmountBtc(e.target.value)} required placeholder="0.001" />
          {confirmedSats > 0 && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 5 }}>
              {satsToBtc(confirmedSats)} BTC available
              <button type="button" style={{
                background: "none", border: "none", color: C.gold,
                cursor: "pointer", fontSize: 11, marginLeft: 8,
              }} onClick={() => {
                const max = confirmedSats - 2000;
                if (max > 0) setAmountBtc((max / 1e8).toFixed(8));
              }}>Max</button>
            </div>
          )}
        </div>
        <div style={{ flex: 1 }}>
          <label style={lbl}>Fee (sat/vb)</label>
          <input style={inp} type="number" step="0.1" min="1"
            value={feeRate} onChange={e => setFeeRate(e.target.value)} placeholder="Auto" />
        </div>
      </div>

      <div>
        <label style={lbl}>Memo (optional)</label>
        <input style={inp} value={memo} onChange={e => setMemo(e.target.value)} placeholder="Note" />
      </div>

      {err && <p style={{ color: C.red, fontSize: 13, margin: 0 }}>{err}</p>}

      <button type="submit" style={{ ...goldBtn, padding: "14px", fontSize: 15, opacity: busy ? 0.6 : 1 }}
        disabled={busy}>
        {busy ? "Building transaction..." : "Review & sign"}
      </button>
    </form>
  );
}

// // -- External PSBT import

function ExternalPsbtInput({ currentPsbt, onImport }: {
  currentPsbt: string;
  onImport: (hex: string) => void;
}) {
  const [psbtHex, setPsbtHex] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const hex = psbtHex.trim();
    if (!hex.toLowerCase().startsWith("70736274ff")) {
      setErr("Not a valid PSBT (should start with 70736274ff)");
      return;
    }
    try {
      onImport(hex);
      setPsbtHex("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Invalid PSBT");
    }
  }

  return (
    <form onSubmit={submit}>
      <textarea style={{ ...monoInp, resize: "vertical", width: "100%", boxSizing: "border-box" }}
        rows={3} value={psbtHex} onChange={e => setPsbtHex(e.target.value)}
        placeholder="70736274ff... (paste signed PSBT hex)" />
      {err && <p style={{ color: C.red, fontSize: 12, margin: "4px 0" }}>{err}</p>}
      <button type="submit" style={{ ...ghostBtn, marginTop: 8, opacity: !psbtHex ? 0.4 : 1 }}
        disabled={!psbtHex}>
        Add signature
      </button>
    </form>
  );
}

// // -- History tab

function HistoryTab({ vault, proposals, onRefresh }: {
  vault: Vault;
  proposals: Proposal[];
  onRefresh: () => void;
}) {
  void onRefresh;
  if (proposals.length === 0) {
    return <p style={{ color: C.muted, fontSize: 14 }}>No transactions yet.</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {proposals.map(p => (
        <ProposalCard key={p.id} proposal={p} vault={vault} />
      ))}
    </div>
  );
}

function ProposalCard({ proposal: p, vault }: { proposal: Proposal; vault: Vault }) {
  const [expanded, setExpanded] = useState(false);
  const sc = statusColor(p.status);
  return (
    <div style={{
      background: C.surface, border: "1px solid " + C.border,
      borderRadius: 12, overflow: "hidden",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 16px", cursor: "pointer",
      }} onClick={() => setExpanded(e => !e)}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: sc }} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text,
              fontFamily: "Playfair Display, serif" }}>
              {satsToBtc(p.amount_sats)} BTC
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>
              {new Date(p.created_at).toLocaleDateString()}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
            padding: "3px 8px", borderRadius: 4,
            background: sc + "22", color: sc, textTransform: "uppercase",
          }}>{p.status}</span>
          <span style={{ color: C.muted, fontSize: 12 }}>{expanded ? "^" : "v"}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "0 16px 16px", borderTop: "1px solid " + C.border }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8, marginTop: 12,
            fontFamily: "IBM Plex Mono, monospace", wordBreak: "break-all" }}>
            To: {p.destination}
          </div>
          {p.memo && (
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>
              Note: {p.memo}
            </div>
          )}
          {p.txid && (
            <a href={"https://mempool.space/" + (vault.network === "bitcoin" ? "" : "testnet/") + "tx/" + p.txid}
              target="_blank" rel="noreferrer"
              style={{ fontSize: 13, color: C.gold, textDecoration: "none" }}>
              View on mempool.space
            </a>
          )}
          {p.psbt_hex && (
            <div style={{ marginTop: 10 }}>
              <button style={{ ...ghostBtn, fontSize: 12 }}
                onClick={() => navigator.clipboard.writeText(p.psbt_hex!)}>
                Copy PSBT
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
