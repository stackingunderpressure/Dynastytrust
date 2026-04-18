import { useEffect, useState, useCallback } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  api,
  type Vault,
  type Proposal,
  type BalanceResult,
  type VaultMember,
  type VaultInvite,
  type VaultRole,
} from "../lib/api";
import { listKeys, revealMnemonic, type LocalKey } from "../lib/keystore";
import { signPsbtWithMnemonic, countSignatures, mergePsbts } from "../lib/psbt-signer";
import { APP_NAME, broadcastTxUrl, explorerTxUrl } from "../config";
import { useToast } from "../components/toast";
import { LoadingScreen } from "../components/LoadingScreen";
import { colors, fonts, radii, space } from "../theme";
import { Button, Input, Label, Textarea } from "../components/ui";
import { useRealtimeRefresh } from "../lib/realtime";
import { normalizePsbt } from "../lib/psbt-format";


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
  if (s === "broadcast") return colors.green;
  if (s === "signed") return colors.gold;
  if (s === "cancelled") return colors.muted;
  return colors.blue;
}

export default function VaultDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const stateVault = (location.state as { vault?: Vault } | null)?.vault;
  const [vault, setVault] = useState<Vault | null>(stateVault ?? null);

  useEffect(() => {
    if (vault || !id) return;
    let cancelled = false;
    Promise.all([api.vaults.list(false), api.vaults.list(true)])
      .then(([active, archived]) => {
        if (cancelled) return;
        const found = [...active.vaults, ...archived.vaults].find(v => v.id === id);
        if (found) setVault(found);
        else navigate("/vaults", { replace: true });
      })
      .catch(() => !cancelled && navigate("/vaults", { replace: true }));
    return () => { cancelled = true; };
  }, [id, vault, navigate]);

  if (!vault) return <LoadingScreen />;
  return <VaultDetailInner vault={vault} onBack={() => navigate("/vaults")} />;
}

function VaultDetailInner({ vault, onBack }: { vault: Vault; onBack: () => void }) {
  const toast = useToast();
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [tab, setTab] = useState<"overview" | "send" | "history" | "members" | "activity">("overview");
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

  // Live proposal + signature updates for the current vault.
  useRealtimeRefresh(
    { table: "proposals", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );
  useRealtimeRefresh(
    { table: "signer_sessions", channel: `vault:${vault.id}:sigs` },
    () => void load(),
  );

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1600);
  }

  async function archive() {
    if (!confirm("Archive " + vault.name + "?")) return;
    setArchiving(true);
    try { await api.vaults.archive(vault.id); onBack(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed to archive vault"); }
    finally { setArchiving(false); }
  }

  const pendingCount = proposals.filter(
    p => p.status !== "broadcast" && p.status !== "cancelled"
  ).length;

  return (
    <div style={{ minHeight: "100vh", fontFamily: fonts.sans }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `0 ${space[5]}px`,
          height: 56,
          borderBottom: `1px solid ${colors.border}`,
          background: colors.header,
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "none",
            color: colors.muted,
            fontSize: 14,
            cursor: "pointer",
            fontFamily: fonts.sans,
          }}
        >
          Back
        </button>
        <span
          style={{
            fontFamily: fonts.display,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "0.12em",
            color: colors.gold,
          }}
        >
          {APP_NAME}
        </span>
        <Button
          variant="danger"
          size="sm"
          disabled={archiving}
          style={{ fontSize: 12 }}
          onClick={archive}
        >
          Archive
        </Button>
      </header>

      <main style={{ maxWidth: 680, margin: "0 auto", padding: `${space[6]}px ${space[4]}px` }}>
        {/* Balance hero */}
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 16,
            padding: "24px 20px",
            marginBottom: 20,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.1em",
              color: colors.muted,
              marginBottom: 4,
            }}
          >
            {vault.name.toUpperCase()} / {vault.network === "bitcoin" ? "MAINNET" : "TESTNET"}
          </div>
          <div
            style={{
              fontSize: 36,
              fontWeight: 700,
              color: colors.text,
              fontFamily: fonts.display,
              margin: "8px 0 4px",
            }}
          >
            {balance ? satsToBtc(balance.total_sats) : "--"}
            <span style={{ fontSize: 18, color: colors.muted }}> BTC</span>
          </div>
          {balance?.usd_value != null && (
            <div style={{ fontSize: 18, color: colors.sub, marginBottom: 8 }}>
              ${balance.usd_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </div>
          )}
          {balance && balance.unconfirmed_sats !== 0 && (
            <div style={{ fontSize: 12, color: colors.orange, marginBottom: 8 }}>
              + {satsToBtc(balance.unconfirmed_sats)} BTC unconfirmed
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <Button style={{ flex: 1, padding: "12px" }} onClick={() => setTab("send")}>
              Send
            </Button>
            <Button variant="ghost" size="sm" style={{ fontSize: 12 }} onClick={() => copy(vault.address, "addr")}>
              {copied === "addr" ? "Copied!" : "Copy address"}
            </Button>
            {balance && (
              <a
                href={balance.mempool_url}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "9px 16px",
                  background: "none",
                  border: `1px solid ${colors.border}`,
                  borderRadius: radii.md,
                  color: colors.sub,
                  fontSize: 12,
                  fontFamily: fonts.sans,
                  textDecoration: "none",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                Explorer
              </a>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: "flex",
            gap: 2,
            borderBottom: `1px solid ${colors.border}`,
            marginBottom: 20,
          }}
        >
          {[
            { id: "overview", label: "Overview" },
            { id: "send", label: "Send" },
            { id: "history", label: "History", count: pendingCount },
            { id: "members", label: "Members" },
            { id: "activity", label: "Activity" },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as typeof tab)}
              style={{
                padding: "9px 18px",
                border: "none",
                fontSize: 14,
                cursor: "pointer",
                fontFamily: fonts.sans,
                background: "transparent",
                color: tab === t.id ? colors.text : colors.muted,
                borderBottom: tab === t.id ? `2px solid ${colors.gold}` : "2px solid transparent",
                marginBottom: -1,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span
                  style={{
                    background: colors.orange,
                    color: colors.bg,
                    fontSize: 10,
                    fontWeight: 700,
                    borderRadius: 10,
                    padding: "1px 6px",
                  }}
                >
                  {t.count}
                </span>
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
        {tab === "members" && <MembersTab vault={vault} />}
        {tab === "activity" && <ActivityTab vault={vault} />}
      </main>
    </div>
  );
}

// // -- Overview tab

function OverviewTab({
  vault,
  copy,
  copied,
}: {
  vault: Vault;
  copy: (text: string, id: string) => void;
  copied: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Spending paths */}
      {[
        {
          num: 1,
          color: colors.gold,
          title: "Founders - Now",
          body: `${vault.founder_quorum} of ${vault.founder_keys.length} founder signatures required. Available at any time.`,
        },
        {
          num: 2,
          color: colors.blue,
          title: "Recovery - " + blocksToLabel(vault.recovery_after),
          body: `Founders can recover after ${vault.recovery_after.toLocaleString()} blocks using a separate path.`,
        },
        {
          num: 3,
          color: colors.green,
          title: "Inheritance - " + blocksToLabel(vault.inheritance_after),
          body: `${vault.heir_quorum} of ${vault.heir_keys.length} heir signatures after ${vault.inheritance_after.toLocaleString()} blocks.`,
        },
      ].map(p => (
        <div
          key={p.num}
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: "14px 16px",
            borderLeft: `3px solid ${p.color}`,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.1em",
              color: p.color,
              marginBottom: 4,
            }}
          >
            PATH {p.num}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
            {p.title}
          </div>
          <div style={{ fontSize: 12, color: colors.sub, lineHeight: 1.5 }}>{p.body}</div>
        </div>
      ))}

      {/* Details */}
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        {[
          ["Address type", vault.address_type.toUpperCase()],
          ["Founder quorum", `${vault.founder_quorum} of ${vault.founder_keys.length}`],
          ["Heir quorum", `${vault.heir_quorum} of ${vault.heir_keys.length}`],
          ["Recovery", `${vault.recovery_after.toLocaleString()} blocks`],
          ["Inheritance", `${vault.inheritance_after.toLocaleString()} blocks`],
        ].map(([k, v]) => (
          <div
            key={k}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "11px 16px",
              borderBottom: `1px solid ${colors.border}`,
            }}
          >
            <span style={{ fontSize: 13, color: colors.muted }}>{k}</span>
            <span style={{ fontSize: 13, color: colors.text }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Descriptor */}
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: colors.muted,
            }}
          >
            DESCRIPTOR
          </span>
          <Button
            variant="ghost"
            size="sm"
            style={{ padding: "3px 9px", fontSize: 11 }}
            onClick={() => copy(vault.descriptor, "desc")}
          >
            {copied === "desc" ? "Copied" : "Copy"}
          </Button>
        </div>
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: colors.sub,
            wordBreak: "break-all",
            lineHeight: 1.6,
          }}
        >
          {vault.descriptor}
        </div>
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

      // 3. Find local software keys
      // Keys are matched against vault by pubkey during actual signing
      // The vault.founder_keys stores the xpubs used at compile time
      // We derive pubkey from each xpub and check against local key fingerprints
      const allLocalKeys = listKeys().filter(k => k.status === "active" && k.origin === "software");
      
      // Extract fingerprints from vault founder xpubs for matching
      const vaultFingerprints = new Set<string>();
      vault.founder_keys.forEach(xpub => {
        if (xpub.length === 66) {
          // It's a hex pubkey - take first 8 chars as fingerprint
          vaultFingerprints.add(xpub.slice(0, 8));
        }
      });
      
      // Show keys that match vault fingerprints, or all keys if we can't determine
      const matchedKeys = vaultFingerprints.size > 0
        ? allLocalKeys.filter(k => vaultFingerprints.has(k.fingerprint))
        : allLocalKeys;
      
      // If no local keys match, show all with a warning in the UI
      const signingKeys = matchedKeys.length > 0 ? matchedKeys : allLocalKeys;

      setSigning({
        psbt_hex: psbtRes.psbt_hex,
        psbt_b64: psbtRes.psbt_b64,
        summary: psbtRes.summary,
        proposal_id: propRes.proposal.id,
        signers: signingKeys.map(key => ({ key, status: "pending" })),
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

      // Persist this signer's partial PSBT so other members see progress.
      // Fire-and-forget; a failure here doesn't block the UI because the
      // local merged PSBT is still usable for broadcast by this user.
      if (signing.proposal_id) {
        api.signerSessions
          .submit({
            proposal_id: signing.proposal_id,
            psbt_partial_hex: result.psbt_hex,
            fingerprint: key.fingerprint,
            label: key.label,
          })
          .catch(() => {
            /* silent -- surfaces next time the proposal is opened */
          });
      }

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

      const res = await fetch(broadcastTxUrl(vault.network), {
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
    return (
      <div
        style={{
          background: "#0A1A0A",
          border: `1px solid ${colors.green}44`,
          borderRadius: 16,
          padding: 32,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 52, marginBottom: 12 }}>sent</div>
        <div style={{ fontSize: 20, fontWeight: 600, color: colors.green, marginBottom: 8 }}>
          Transaction broadcast
        </div>
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 11,
            color: colors.muted,
            marginBottom: 20,
            wordBreak: "break-all",
          }}
        >
          {signing.txid}
        </div>
        <a
          href={explorerTxUrl(vault.network, signing.txid)}
          target="_blank"
          rel="noreferrer"
          style={{ color: colors.gold, fontSize: 14 }}
        >
          View on mempool.space
        </a>
      </div>
    );
  }

  // Signing screen
  if (step === "signing" && signing) {
    const quorumMet = signing.signaturesCollected >= signing.requiredSignatures;
    const needed = signing.requiredSignatures - signing.signaturesCollected;

    function copyPsbt(text: string, id: string) {
      navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1600);
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Summary card */}
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 14 }}>
            Transaction
          </div>
          {[
            ["To", signing.summary.destination],
            ["Amount", `${satsToBtc(signing.summary.amount_sats)} BTC`],
            ["Fee", `${satsToBtc(signing.summary.fee_sats)} BTC (~${signing.summary.fee_rate} sat/vb)`],
            ["Change back", `${satsToBtc(signing.summary.change_sats)} BTC`],
          ].map(([k, v]) => (
            <div
              key={k}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: `1px solid ${colors.border}`,
              }}
            >
              <span style={{ fontSize: 13, color: colors.muted }}>{k}</span>
              <span
                style={{
                  fontSize: 13,
                  color: colors.text,
                  fontFamily: k === "To" ? fonts.mono : "inherit",
                  wordBreak: "break-all",
                  textAlign: "right",
                  maxWidth: "60%",
                }}
              >
                {v}
              </span>
            </div>
          ))}

          {/* Signature progress */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: colors.muted }}>Signatures</span>
              <span style={{ fontSize: 12, color: quorumMet ? colors.green : colors.orange }}>
                {signing.signaturesCollected} / {signing.requiredSignatures} required
              </span>
            </div>
            <div style={{ height: 4, background: colors.border, borderRadius: 2 }}>
              <div
                style={{
                  height: "100%",
                  borderRadius: 2,
                  background: quorumMet ? colors.green : colors.gold,
                  width: `${Math.min(100, (signing.signaturesCollected / signing.requiredSignatures) * 100)}%`,
                  transition: "width 0.3s",
                }}
              />
            </div>
          </div>
        </div>

        {/* Browser keys signing */}
        {signing.signers.length > 0 && (
          <div
            style={{
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 20,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
              Sign with browser keys
            </div>
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 14 }}>
              Tap a key to sign.{" "}
              {signing.requiredSignatures > 1
                ? `Need ${signing.requiredSignatures} signatures.`
                : "Only 1 signature needed."}
            </div>
            {signing.signers.map((signer, i) => {
              const statusIcon =
                signer.status === "signed"
                  ? "Signed"
                  : signer.status === "signing"
                    ? "Signing..."
                    : signer.status === "error"
                      ? "Error"
                      : "Tap to sign";
              const accent =
                signer.status === "signed"
                  ? colors.green
                  : signer.status === "error"
                    ? colors.red
                    : signer.status === "signing"
                      ? colors.gold
                      : colors.muted;
              return (
                <div
                  key={signer.key.keyId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 14px",
                    borderRadius: 10,
                    marginBottom: 8,
                    background: signer.status === "signed" ? `${colors.green}0D` : "#0A0A14",
                    border: `1px solid ${signer.status === "signed" ? `${colors.green}44` : colors.border}`,
                    cursor: signer.status === "pending" ? "pointer" : "default",
                    opacity: signer.status === "signing" ? 0.7 : 1,
                  }}
                  onClick={() => signer.status === "pending" && void signWithKey(i)}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>
                      {signer.key.label}
                    </div>
                    <div style={{ fontSize: 11, color: colors.muted }}>
                      {signer.key.persona} / {signer.key.fingerprint}
                      {signer.key.testMnemonic ? " / test key" : ""}
                    </div>
                    {signer.error && (
                      <div style={{ fontSize: 11, color: colors.red, marginTop: 4 }}>
                        {signer.error}
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: accent }}>
                    {statusIcon}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Hardware wallet / external PSBT */}
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
            Sign with hardware wallet
          </div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 14 }}>
            Export to Sparrow, Nunchuk, or Coldcard. Paste the signed PSBT back here.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 12 }}
              onClick={() => copyPsbt(signing.psbt_hex, "hex")}
            >
              {copied === "hex" ? "Copied!" : "Copy PSBT hex"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 12 }}
              onClick={() => copyPsbt(signing.psbt_b64, "b64")}
            >
              {copied === "b64" ? "Copied!" : "Copy base64"}
            </Button>
          </div>
          <ExternalPsbtInput
            onImport={importedHex => {
              const merged = mergePsbts([signing.psbt_hex, importedHex]);
              const totalSigs = countSignatures(merged);
              if (signing.proposal_id) {
                api.signerSessions
                  .submit({
                    proposal_id: signing.proposal_id,
                    psbt_partial_hex: importedHex,
                    label: "Hardware wallet",
                  })
                  .catch(() => {
                    /* best-effort; local merge is authoritative for this browser */
                  });
              }
              setSigning(prev =>
                prev ? { ...prev, psbt_hex: merged, signaturesCollected: totalSigs } : prev,
              );
            }}
          />
        </div>

        {/* Action buttons */}
        {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}

        {quorumMet ? (
          <Button
            disabled={busy}
            style={{ background: colors.green, width: "100%", padding: "14px", fontSize: 16 }}
            onClick={() => void broadcast()}
          >
            {busy ? "Broadcasting..." : "Broadcast transaction"}
          </Button>
        ) : (
          <div style={{ fontSize: 13, color: colors.muted, textAlign: "center", padding: "10px 0" }}>
            {needed} more signature{needed !== 1 ? "s" : ""} needed
          </div>
        )}

        <Button
          variant="ghost"
          style={{ width: "100%" }}
          onClick={() => {
            setStep("form");
            setSigning(null);
            setErr(null);
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  // Form screen
  return (
    <form
      onSubmit={e => void buildAndSign(e)}
      style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 480 }}
    >
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
          <Input
            type="number"
            step="0.00000001"
            min="0.00000546"
            value={amountBtc}
            onChange={e => setAmountBtc(e.target.value)}
            required
            placeholder="0.001"
          />
          {confirmedSats > 0 && (
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 5 }}>
              {satsToBtc(confirmedSats)} BTC available
              <button
                type="button"
                style={{
                  background: "none",
                  border: "none",
                  color: colors.gold,
                  cursor: "pointer",
                  fontSize: 11,
                  marginLeft: 8,
                }}
                onClick={() => {
                  const max = confirmedSats - 2000;
                  if (max > 0) setAmountBtc((max / 1e8).toFixed(8));
                }}
              >
                Max
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

      <div>
        <Label>Memo (optional)</Label>
        <Input value={memo} onChange={e => setMemo(e.target.value)} placeholder="Note" />
      </div>

      {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}

      <Button
        type="submit"
        disabled={busy}
        style={{ padding: "14px", fontSize: 15 }}
      >
        {busy ? "Building transaction..." : "Review & sign"}
      </Button>
    </form>
  );
}

// // -- External PSBT import

function ExternalPsbtInput({ onImport }: { onImport: (hex: string) => void }) {
  const [psbtHex, setPsbtHex] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const hex = normalizePsbt(psbtHex);
    if (!hex) {
      setErr("Not a valid PSBT. Paste hex (starts with 70736274ff) or base64 (starts with cHNidP8).");
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
      <Textarea
        mono
        rows={3}
        value={psbtHex}
        onChange={e => setPsbtHex(e.target.value)}
        placeholder="Paste signed PSBT (hex or base64 both work)"
      />
      {err && <p style={{ color: colors.red, fontSize: 12, margin: "4px 0" }}>{err}</p>}
      <Button
        type="submit"
        variant="ghost"
        disabled={!psbtHex}
        style={{ marginTop: 8 }}
      >
        Add signature
      </Button>
    </form>
  );
}

// // -- History tab

function HistoryTab({
  vault,
  proposals,
  onRefresh,
}: {
  vault: Vault;
  proposals: Proposal[];
  onRefresh: () => void;
}) {
  void onRefresh;
  if (proposals.length === 0) {
    return <p style={{ color: colors.muted, fontSize: 14 }}>No transactions yet.</p>;
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
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 16px",
          cursor: "pointer",
        }}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: sc }} />
          <div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: colors.text,
                fontFamily: fonts.display,
              }}
            >
              {satsToBtc(p.amount_sats)} BTC
            </div>
            <div style={{ fontSize: 11, color: colors.muted }}>
              {new Date(p.created_at).toLocaleDateString()}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.06em",
              padding: "3px 8px",
              borderRadius: 4,
              background: `${sc}22`,
              color: sc,
              textTransform: "uppercase",
            }}
          >
            {p.status}
          </span>
          <span style={{ color: colors.muted, fontSize: 12 }}>{expanded ? "^" : "v"}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${colors.border}` }}>
          <div
            style={{
              fontSize: 12,
              color: colors.muted,
              marginBottom: 8,
              marginTop: 12,
              fontFamily: fonts.mono,
              wordBreak: "break-all",
            }}
          >
            To: {p.destination}
          </div>
          {p.memo && (
            <div style={{ fontSize: 12, color: colors.sub, marginBottom: 8 }}>
              Note: {p.memo}
            </div>
          )}
          {p.txid && (
            <a
              href={explorerTxUrl(vault.network, p.txid)}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13, color: colors.gold, textDecoration: "none" }}
            >
              View on mempool.space
            </a>
          )}
          {p.psbt_hex && (
            <div style={{ marginTop: 10 }}>
              <Button
                variant="ghost"
                size="sm"
                style={{ fontSize: 12 }}
                onClick={() => navigator.clipboard.writeText(p.psbt_hex!)}
              >
                Copy PSBT
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// // -- Members tab

function MembersTab({ vault }: { vault: Vault }) {
  const toast = useToast();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [invites, setInvites] = useState<VaultInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [recentLink, setRecentLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [m, i] = await Promise.allSettled([
        api.members.list(vault.id),
        api.invites.list(vault.id),
      ]);
      if (m.status === "fulfilled") setMembers(m.value.members);
      // Invite list is owner-only; non-owner members get 403 here, which
      // is expected and not an error.
      if (i.status === "fulfilled") setInvites(i.value.invites);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [vault.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates when someone joins or a new invite lands.
  useRealtimeRefresh(
    { table: "vault_members", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );
  useRealtimeRefresh(
    { table: "vault_invites", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  async function revoke(invite: VaultInvite) {
    if (!confirm("Revoke this invite?")) return;
    try {
      await api.invites.revoke(invite.id);
      toast.success("Invite revoked");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke invite");
    }
  }

  async function removeMember(m: VaultMember) {
    if (m.role === "owner") return;
    if (!confirm(`Remove ${m.label ?? "member"} from the vault?`)) return;
    try {
      await api.members.remove(m.id);
      toast.success("Member removed");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove member");
    }
  }

  if (loading) return <p style={{ color: colors.muted, fontSize: 14 }}>Loading members...</p>;
  if (err) return <p style={{ color: colors.red, fontSize: 14 }}>{err}</p>;

  const pendingInvites = invites.filter(i => !i.claimed_at && new Date(i.expires_at).getTime() > Date.now());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {recentLink && (
        <div
          style={{
            padding: "12px 14px",
            background: `${colors.gold}11`,
            border: `1px solid ${colors.gold}44`,
            borderRadius: radii.md,
            fontSize: 13,
            color: colors.sub,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div>Share this link with the new signer. They have 14 days to claim.</div>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              background: "#0A0A14",
              padding: "8px 10px",
              borderRadius: radii.sm,
              wordBreak: "break-all",
            }}
          >
            {recentLink}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(recentLink);
                toast.success("Link copied");
              }}
            >
              Copy link
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRecentLink(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Members list */}
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
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
            Members ({members.length})
          </div>
          <Button size="sm" onClick={() => setShowInvite(true)}>
            + Invite
          </Button>
        </div>
        {members.map(m => (
          <MemberRow key={m.id} member={m} onRemove={() => void removeMember(m)} />
        ))}
      </div>

      {/* Pending invites */}
      {pendingInvites.length > 0 && (
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
              padding: "12px 16px",
              borderBottom: `1px solid ${colors.border}`,
              fontSize: 14,
              fontWeight: 600,
              color: colors.text,
            }}
          >
            Pending invites ({pendingInvites.length})
          </div>
          {pendingInvites.map(inv => (
            <InviteRow
              key={inv.id}
              invite={inv}
              onCopyLink={() => {
                const url = `${window.location.origin}/invite/${inv.token}`;
                navigator.clipboard.writeText(url);
                toast.success("Link copied");
              }}
              onRevoke={() => void revoke(inv)}
            />
          ))}
        </div>
      )}

      {showInvite && (
        <InviteModal
          vault={vault}
          onClose={() => setShowInvite(false)}
          onCreated={invite => {
            setShowInvite(false);
            setRecentLink(`${window.location.origin}/invite/${invite.token}`);
            void load();
          }}
        />
      )}
    </div>
  );
}

function MemberRow({ member: m, onRemove }: { member: VaultMember; onRemove: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>
          {m.label ?? "Unnamed"}
          {m.role === "owner" && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                fontWeight: 700,
                padding: "2px 6px",
                borderRadius: 4,
                background: `${colors.gold}22`,
                color: colors.gold,
                letterSpacing: "0.06em",
              }}
            >
              OWNER
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: colors.muted }}>
          {m.role}
          {m.fingerprint ? ` / ${m.fingerprint}` : " / no key yet"}
        </div>
      </div>
      {m.role !== "owner" && (
        <Button variant="ghost" size="sm" style={{ fontSize: 12 }} onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  );
}

function InviteRow({
  invite,
  onCopyLink,
  onRevoke,
}: {
  invite: VaultInvite;
  onCopyLink: () => void;
  onRevoke: () => void;
}) {
  const expires = new Date(invite.expires_at);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div>
        <div style={{ fontSize: 14, color: colors.text }}>
          {invite.invited_label ?? "Unnamed"} ({invite.invited_role})
        </div>
        <div style={{ fontSize: 11, color: colors.muted }}>
          Expires {expires.toLocaleDateString()}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 12 }} onClick={onCopyLink}>
          Copy link
        </Button>
        <Button variant="danger" size="sm" style={{ fontSize: 12 }} onClick={onRevoke}>
          Revoke
        </Button>
      </div>
    </div>
  );
}

function InviteModal({
  vault,
  onClose,
  onCreated,
}: {
  vault: Vault;
  onClose: () => void;
  onCreated: (invite: VaultInvite) => void;
}) {
  const [role, setRole] = useState<Exclude<VaultRole, "owner">>("founder");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api.invites.create({
        vault_id: vault.id,
        invited_role: role,
        invited_label: label.trim() || undefined,
      });
      onCreated(res.invite);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create invite");
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
          maxWidth: 420,
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
          Invite co-signer
        </h2>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <Label>Role</Label>
            <select
              value={role}
              onChange={e => setRole(e.target.value as typeof role)}
              style={{
                width: "100%",
                padding: "11px 13px",
                background: colors.input,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                color: colors.text,
                fontSize: 14,
                fontFamily: fonts.sans,
                boxSizing: "border-box",
              }}
            >
              <option value="founder">Founder (can sign immediately)</option>
              <option value="heir">Heir (inheritance path only)</option>
              <option value="viewer">Viewer (read-only)</option>
            </select>
          </div>
          <div>
            <Label>Display name (optional)</Label>
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Dad, Sister, Lawyer"
            />
          </div>
          {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}
          <div style={{ display: "flex", gap: 10 }}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create invite link"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// // -- Activity tab

type VaultEvent = Awaited<ReturnType<typeof api.vaultEvents.list>>["events"][number];

function ActivityTab({ vault }: { vault: Vault }) {
  const [events, setEvents] = useState<VaultEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await api.vaultEvents.list(vault.id, 100);
      setEvents(res.events);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load activity");
    } finally {
      setLoading(false);
    }
  }, [vault.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeRefresh(
    { table: "vault_events", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  if (loading) return <p style={{ color: colors.muted, fontSize: 14 }}>Loading activity...</p>;
  if (err) return <p style={{ color: colors.red, fontSize: 14 }}>{err}</p>;
  if (events.length === 0)
    return <p style={{ color: colors.muted, fontSize: 14 }}>No activity yet.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {events.map(e => (
        <EventRow key={e.id} event={e} />
      ))}
    </div>
  );
}

function EventRow({ event }: { event: VaultEvent }) {
  const { icon, title, color } = describeEvent(event);
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "12px 4px",
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          flexShrink: 0,
          background: `${color}22`,
          color: color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: colors.text }}>{title}</div>
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>
          {new Date(event.created_at).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

function describeEvent(e: VaultEvent): { icon: string; title: string; color: string } {
  const meta = e.metadata || {};
  switch (e.event_type) {
    case "created":
      return { icon: "+", title: "Vault created", color: colors.gold };
    case "invite_created":
      return { icon: "i", title: `Invite sent (${String(meta.role ?? "member")})`, color: colors.blue };
    case "member_joined":
      return { icon: "@", title: `Member joined as ${String(meta.role ?? "member")}`, color: colors.green };
    case "member_removed":
      return { icon: "-", title: `Member removed`, color: colors.red };
    case "psbt_generated":
      return {
        icon: "T",
        title: `Proposal created${meta.amount_sats ? ` (${(Number(meta.amount_sats) / 1e8).toFixed(8).replace(/\.?0+$/, "")} BTC)` : ""}`,
        color: colors.orange,
      };
    case "signed":
      return { icon: "S", title: `Signature added`, color: colors.gold };
    case "broadcast":
      return {
        icon: "B",
        title: `Broadcast${meta.txid ? ` (${String(meta.txid).slice(0, 12)}...)` : ""}`,
        color: colors.green,
      };
    case "cancelled":
      return { icon: "x", title: `Proposal cancelled`, color: colors.muted };
    default:
      return { icon: "*", title: e.event_type, color: colors.sub };
  }
}
