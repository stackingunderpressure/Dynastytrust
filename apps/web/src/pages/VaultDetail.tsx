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
  type TrustDoc,
  type DistributionRule,
  type VaultRequest,
  type VaultRequestStatus,
  type ScheduledStipend,
  type StipendInterval,
  type DistributionWallet,
  type DistributionTranche,
} from "../lib/api";
import { supabase } from "../lib/supabase";
import { listKeys, revealMnemonic, type LocalKey } from "../lib/keystore";
import { signPsbtWithMnemonic, countSignatures, mergePsbts } from "../lib/psbt-signer";
import { APP_NAME, broadcastTxUrl, explorerTxUrl } from "../config";
import { useToast } from "../components/toast";
import { LoadingScreen } from "../components/LoadingScreen";
import { colors, fonts, radii, space } from "../theme";
import { Button, Input, Label, Textarea } from "../components/ui";
import { useRealtimeRefresh } from "../lib/realtime";
import { normalizePsbt } from "../lib/psbt-format";
import { downloadVault } from "../lib/descriptor-backup";
import { pubkeyFromXpub, fingerprintFromXpub } from "../lib/xpub";
import { tipHeight, blocksToApproxLabel, approxWallclockDate } from "../lib/chain";


function satsToBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0";
}

// Step a date forward by a stipend interval. Month/quarter/year
// arithmetic uses calendar-anchored addition so "monthly" stays on
// the same day-of-month, not 30d intervals that drift.
function advanceDueDate(from: Date, interval: StipendInterval): Date {
  const d = new Date(from.getTime());
  if (interval === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (interval === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (interval === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (interval === "annually") d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

function intervalLabel(k: StipendInterval): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
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

// Map schema role to trust-deed wording shown across the UI.
// owner, founder -> trustee; heir -> successor trustee; viewer ->
// observer. Keeping the schema names stable keeps DB queries and
// RLS policies unchanged.
function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "Primary trustee";
    case "founder":
      return "Trustee";
    case "heir":
      return "Successor trustee";
    case "protector":
      return "Protector";
    case "viewer":
      return "Observer";
    case "beneficiary":
      return "Beneficiary";
    default:
      return role;
  }
}

function isTrusteeRole(role: string): boolean {
  return role === "owner" || role === "founder";
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
  const [tab, setTab] = useState<"overview" | "send" | "history" | "members" | "activity" | "requests">("overview");
  const [archiving, setArchiving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [sendPrefill, setSendPrefill] = useState<SendPrefill | null>(null);

  function prefillSend(p: SendPrefill) {
    setSendPrefill(p);
    setTab("send");
  }

  const load = useCallback(async () => {
    const [balRes, propRes] = await Promise.allSettled([
      vault.address
        ? api.balance(vault.address, vault.network)
        : Promise.resolve(null),
      api.proposals.list(vault.id),
    ]);
    if (balRes.status === "fulfilled" && balRes.value) setBalance(balRes.value);
    if (propRes.status === "fulfilled") setProposals(propRes.value.proposals);
  }, [vault]);

  useEffect(() => { void load(); }, [load]);

  // Self-heal: if the caller's vault_members row still has the
  // pre-audit pubkey + fingerprint convention (account-level pubkey,
  // non-BIP32 fingerprint), re-derive from the stored xpub and PATCH
  // so the next compile produces a Nunchuk-compatible descriptor.
  // Runs silently on every vault load. No-op once corrected.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { members } = await api.members.list(vault.id);
        const me = members.find(m => m.xpub && (m.pubkey || m.fingerprint));
        if (!me || cancelled) return;
        const correctPubkey = pubkeyFromXpub(me.xpub!);
        const correctFp = fingerprintFromXpub(me.xpub!);
        if (me.pubkey === correctPubkey && me.fingerprint === correctFp) return;
        await api.members.update(me.id, {
          pubkey: correctPubkey,
          fingerprint: correctFp,
        });
      } catch {
        /* best-effort; the member tab will surface real errors */
      }
    })();
    return () => { cancelled = true; };
  }, [vault.id]);

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

  async function deleteVault() {
    const expected = vault.name;
    const typed = prompt(
      `Permanently delete "${expected}"? This cannot be undone.\n\n` +
      `Any funds still at the vault address stay spendable via the descriptor backup (downloaded from the overview tab) but the vault will no longer appear in this app. Type the vault name to confirm.`,
    );
    if (typed !== expected) {
      if (typed !== null) toast.error("Name did not match. Delete cancelled.");
      return;
    }
    setArchiving(true);
    try { await api.vaults.remove(vault.id); onBack(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed to delete vault"); }
    finally { setArchiving(false); }
  }

  const pendingCount = proposals.filter(
    p => p.status !== "broadcast" && p.status !== "cancelled"
  ).length;

  return (
    <div style={{ minHeight: "100vh", fontFamily: fonts.sans }}>
      <header className="dt-header" style={{ height: 56, zIndex: 50 }}>
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
          onClick={deleteVault}
        >
          Delete
        </Button>
      </header>

      <main className="dt-page-main dt-page-main--narrow">
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
            {vault.name.toUpperCase()} / {vault.network === "bitcoin" ? "MAINNET" : vault.network.toUpperCase()}
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
            {vault.status === "draft" ? (
              <DraftCompileButton vault={vault} />
            ) : (
              <Button style={{ flex: 1, padding: "12px" }} onClick={() => setTab("send")}>
                Send
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 12 }}
              disabled={!vault.address}
              onClick={() => vault.address && copy(vault.address, "addr")}
            >
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
          {(vault.status === 'draft'
            ? [
                { id: "overview", label: "Overview" },
                { id: "members", label: "Members" },
                { id: "activity", label: "Activity" },
              ]
            : [
                { id: "overview", label: "Overview" },
                { id: "send", label: "Send" },
                { id: "requests", label: "Requests" },
                { id: "history", label: "History", count: pendingCount },
                { id: "members", label: "Members" },
                { id: "activity", label: "Activity" },
              ]
          ).map(t => (
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
          <OverviewTab vault={vault} copy={copy} copied={copied} onSendPrefill={prefillSend} />
        )}
        {tab === "send" && (
          <SendTab
            vault={vault}
            balance={balance}
            prefill={sendPrefill}
            onDone={() => { setSendPrefill(null); void load(); setTab("history"); }}
          />
        )}
        {tab === "history" && (
          <HistoryTab vault={vault} proposals={proposals} onRefresh={load} />
        )}
        {tab === "members" && <MembersTab vault={vault} />}
        {tab === "activity" && <ActivityTab vault={vault} />}
        {tab === "requests" && <RequestsTab vault={vault} />}
      </main>
    </div>
  );
}

// // -- Overview tab

function OverviewTab({
  vault,
  copy,
  copied,
  onSendPrefill,
}: {
  vault: Vault;
  copy: (text: string, id: string) => void;
  copied: string | null;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  // Inheritance vaults get all three spending paths; plain vaults
  // (no heirs, no timelocks) get only the trustee-now path.
  const plain =
    (vault.heir_keys?.length ?? 0) === 0 &&
    vault.recovery_after === 0 &&
    vault.inheritance_after === 0;

  const paths = plain
    ? [
        {
          num: 1,
          color: colors.gold,
          title: "Trustees - Now",
          body: `${vault.founder_quorum} of ${vault.founder_keys.length} trustee signatures required. Available at any time.`,
        },
      ]
    : [
        {
          num: 1,
          color: colors.gold,
          title: "Trustees - Now",
          body: `${vault.founder_quorum} of ${vault.founder_keys.length} trustee signatures required. Available at any time.`,
        },
        {
          num: 2,
          color: colors.blue,
          title: "Recovery - " + blocksToLabel(vault.recovery_after),
          body:
            vault.recovery_quorum != null && vault.recovery_quorum !== vault.founder_quorum
              ? `${vault.recovery_quorum} of ${vault.founder_keys.length} trustee signatures after ${vault.recovery_after.toLocaleString()} blocks. Insurance against a lost device: quorum drops below the normal ${vault.founder_quorum}-of-${vault.founder_keys.length} so trustees can still spend if one key is gone.`
              : `Trustees can recover after ${vault.recovery_after.toLocaleString()} blocks. Note: the recovery quorum matches the normal quorum, so this path grants no extra capability.`,
        },
        {
          num: 3,
          color: colors.green,
          title: "Inheritance - " + blocksToLabel(vault.inheritance_after),
          body: `${vault.heir_quorum} of ${vault.heir_keys.length} successor signatures after ${vault.inheritance_after.toLocaleString()} blocks. Triggered only if the trustees are unreachable for the full window.`,
        },
        ...(vault.protector_keys.length > 0 &&
        vault.protector_quorum != null &&
        vault.protector_after != null
          ? [
              {
                num: 4,
                color: colors.blue,
                title: "Protector - " + blocksToLabel(vault.protector_after),
                body: `${vault.protector_quorum} of ${vault.protector_keys.length} protector signatures after ${vault.protector_after.toLocaleString()} blocks. An independent watchdog who can rescue funds if trustees go rogue before inheritance triggers.`,
              },
            ]
          : []),
      ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {!plain && <TimelockCountdown vault={vault} />}
      <TrustDocSection vault={vault} />
      <StipendsSection vault={vault} onSendPrefill={onSendPrefill} />
      <DistributionWalletsSection vault={vault} onSendPrefill={onSendPrefill} />
      {vault.status !== "draft" && (
        <UtxosSection vault={vault} onSendPrefill={onSendPrefill} />
      )}

      {/* Spending paths */}
      {paths.map(p => (
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
          ["Trustee quorum", `${vault.founder_quorum} of ${vault.founder_keys.length}`],
          ["Successor quorum", `${vault.heir_quorum} of ${vault.heir_keys.length}`],
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
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
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
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11 }}
              disabled={!vault.descriptor}
              onClick={() => vault.descriptor && copy(vault.descriptor, "desc")}
            >
              {copied === "desc" ? "Copied" : "Copy"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11 }}
              onClick={() => downloadVault(vault)}
            >
              Download backup
            </Button>
          </div>
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

// Optional pre-filled fields pushed from a scheduled stipend row.
// When `stipend_id` is set, successful broadcast bumps the stipend's
// next_due_at by its interval.
interface SendPrefill {
  stipend_id?: string;
  stipend_interval?: StipendInterval;
  destination?: string;
  amount_sats?: number;
  rule_id?: string | null;
  memo?: string;
  name?: string;
  selected_utxos?: { txid: string; vout: number }[];
}

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

function SendTab({ vault, balance, onDone, prefill }: {
  vault: Vault;
  balance: BalanceResult | null;
  onDone: () => void;
  prefill?: SendPrefill | null;
}) {
  const [step, setStep] = useState<SendStep>("form");
  const [dest, setDest] = useState(prefill?.destination ?? "");
  const [amountBtc, setAmountBtc] = useState(
    prefill?.amount_sats ? satsToBtc(prefill.amount_sats) : "",
  );
  const [feeRate, setFeeRate] = useState("");
  const [memo, setMemo] = useState(prefill?.memo ?? "");
  const [ruleId, setRuleId] = useState<string>(prefill?.rule_id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signing, setSigning] = useState<SigningState | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [slowHint, setSlowHint] = useState(false);

  const confirmedSats = balance?.confirmed_sats ?? 0;
  const amountSats = Math.round(parseFloat(amountBtc || "0") * 1e8);
  const rules = vault.trust_doc?.rules ?? [];
  const selectedRule = rules.find(r => r.id === ruleId);

  async function buildAndSign(e: React.FormEvent) {
    e.preventDefault();
    if (amountSats < 546) { setErr("Minimum 546 sats (dust limit)"); return; }
    if (amountSats > confirmedSats) { setErr("Insufficient confirmed balance"); return; }
    // Enforce the structured trust rule if one is picked or if the
    // trust has rules defined at all (in which case every spend
    // should be categorised).
    if (rules.length > 0 && !selectedRule) {
      setErr("Pick a distribution rule. Every spend on this trust must be categorised.");
      return;
    }
    if (selectedRule?.max_sats && amountSats > selectedRule.max_sats) {
      setErr(
        `Amount exceeds the cap on rule "${selectedRule.name}" (max ${satsToBtc(selectedRule.max_sats)} BTC per spend).`,
      );
      return;
    }
    if (selectedRule?.requires_comment && !memo.trim()) {
      setErr(`Rule "${selectedRule.name}" requires a reason. Fill in the memo field.`);
      return;
    }
    setBusy(true); setErr(null); setSlowHint(false);
    const slowTimer = window.setTimeout(() => setSlowHint(true), 1500);

    try {
      // 1. Build PSBT via Fly.io
      const psbtRes = await api.psbt.generate({
        vault_id: vault.id,
        destination: dest.trim(),
        amount_sats: amountSats,
        fee_rate: feeRate ? parseFloat(feeRate) : undefined,
        path: "founders_now",
        selected_utxos: prefill?.selected_utxos,
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
        memo: selectedRule
          ? `Rule: ${selectedRule.name}${memo.trim() ? ` -- ${memo.trim()}` : ""}`
          : memo || undefined,
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
      window.clearTimeout(slowTimer);
      setBusy(false);
      setSlowHint(false);
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

      // Advance the stipend's next_due_at by its interval so the
      // schedule ticks forward without manual bookkeeping.
      if (prefill?.stipend_id && prefill.stipend_interval) {
        const next = advanceDueDate(new Date(), prefill.stipend_interval).toISOString();
        try {
          await api.stipends.update(prefill.stipend_id, {
            next_due_at: next,
            last_proposed_at: new Date().toISOString(),
            last_proposal_id: signing.proposal_id ?? null,
          });
        } catch {
          /* non-fatal: broadcast already happened */
        }
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
      {prefill?.selected_utxos && prefill.selected_utxos.length > 0 && (
        <div
          style={{
            padding: "8px 10px",
            background: colors.gold + "11",
            border: `1px solid ${colors.gold}44`,
            borderRadius: radii.md,
            fontSize: 12,
            color: colors.gold,
          }}
        >
          Locked to {prefill.selected_utxos.length} UTXO
          {prefill.selected_utxos.length === 1 ? "" : "s"}:{" "}
          <span style={{ fontFamily: fonts.mono, fontSize: 11 }}>
            {prefill.selected_utxos.map(u => `${u.txid.slice(0, 8)}:${u.vout}`).join(", ")}
          </span>
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
              fontSize: 14,
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
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 6 }}>
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

      {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}

      <Button
        type="submit"
        disabled={busy}
        style={{ padding: "14px", fontSize: 15 }}
      >
        {busy ? (slowHint ? "Waking compiler..." : "Building transaction...") : "Review & sign"}
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
              PRIMARY TRUSTEE
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: colors.muted }}>
          {roleLabel(m.role)}
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
          {invite.invited_label ?? "Unnamed"} ({roleLabel(invite.invited_role)})
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
              <option value="founder">Trustee (can sign immediately)</option>
              <option value="heir">Successor trustee (inheritance path)</option>
              <option value="protector">Protector (can intervene if trustees go rogue)</option>
              <option value="beneficiary">Beneficiary (receives distributions, files requests)</option>
              <option value="viewer">Observer (read-only)</option>
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
    case "commented":
      return { icon: "c", title: `Discussion comment`, color: colors.sub };
    case "voted_approve":
      return { icon: "+", title: `Vote: approve`, color: colors.green };
    case "voted_abstain":
      return { icon: "o", title: `Vote: abstain`, color: colors.muted };
    case "voted_decline":
      return { icon: "-", title: `Vote: decline`, color: colors.red };
    case "request_created":
      return {
        icon: "R",
        title: `Distribution request${meta.rule_name ? ` (${String(meta.rule_name)})` : ""}${meta.amount_sats ? ` -- ${(Number(meta.amount_sats) / 1e8).toFixed(8).replace(/\.?0+$/, "")} BTC` : ""}`,
        color: colors.orange,
      };
    case "request_approved":
      return { icon: "+", title: "Request approved", color: colors.green };
    case "request_declined":
      return { icon: "x", title: "Request declined", color: colors.red };
    case "request_fulfilled":
      return { icon: "!", title: "Request fulfilled", color: colors.green };
    case "request_cancelled":
      return { icon: "o", title: "Request cancelled", color: colors.muted };
    default:
      return { icon: "*", title: e.event_type, color: colors.sub };
  }
}

function DraftCompileButton({ vault }: { vault: Vault }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.members.list(vault.id);
      setMembers(res.members);
    } catch {
      /* the Members tab will surface errors; keep this quiet */
    }
  }, [vault.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeRefresh(
    { table: "vault_members", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  const ready = members.filter(
    m => m.xpub && m.fingerprint && m.pubkey && m.derivation_path,
  );
  const foundersReady = ready.filter(m => m.role === "founder" || m.role === "owner").length;
  const heirsReady = ready.filter(m => m.role === "heir").length;
  const plannedF = vault.planned_founder_count ?? 0;
  const plannedH = vault.planned_heir_count ?? 0;
  const slotsFilled = foundersReady >= plannedF && heirsReady >= plannedH;

  async function compile() {
    setBusy(true);
    try {
      const res = await api.vaults.compile(vault.id);
      toast.success("Vault compiled -- ready to fund");
      navigate(`/vaults/${res.vault.id}`, { state: { vault: res.vault } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Compile failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      disabled={!slotsFilled || busy}
      style={{ flex: 1, padding: "12px", background: slotsFilled ? colors.green : undefined }}
      onClick={() => void compile()}
    >
      {busy
        ? "Compiling..."
        : slotsFilled
          ? "Compile vault"
          : `Waiting on ${plannedF - foundersReady} founder${plannedF - foundersReady === 1 ? "" : "s"}${plannedH > 0 ? `, ${plannedH - heirsReady} heir${plannedH - heirsReady === 1 ? "" : "s"}` : ""}`}
    </Button>
  );
}

// // -- Timelock countdown
// Fetches the mempool.space tip block height and renders a live
// countdown for the recovery and inheritance branches. Refreshes
// every minute silently.

function TimelockCountdown({ vault }: { vault: Vault }) {
  const [tip, setTip] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchTip() {
      try {
        const h = await tipHeight(vault.network);
        if (!cancelled) setTip(h);
      } catch {
        /* mempool.space is best-effort */
      }
    }
    void fetchTip();
    const iv = window.setInterval(() => void fetchTip(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [vault.network]);

  const rows = [
    { label: "Recovery", blocks: vault.recovery_after, color: colors.blue },
    { label: "Inheritance", blocks: vault.inheritance_after, color: colors.green },
  ];

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
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: colors.muted,
          marginBottom: 10,
          textTransform: "uppercase",
        }}
      >
        Timelocks
      </div>
      {rows.map(r => {
        const unlocksAt = approxWallclockDate(r.blocks);
        const unlocksLabel = blocksToApproxLabel(r.blocks);
        return (
          <div
            key={r.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "6px 0",
              borderTop: `1px solid ${colors.border}`,
            }}
          >
            <div>
              <div style={{ fontSize: 13, color: colors.text }}>{r.label}</div>
              <div style={{ fontSize: 11, color: colors.muted }}>
                {tip != null
                  ? `Tip ${tip.toLocaleString()} / locked for ${r.blocks.toLocaleString()} blocks`
                  : `${r.blocks.toLocaleString()} blocks`}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, color: r.color, fontWeight: 600 }}>
                {unlocksLabel}
              </div>
              <div style={{ fontSize: 11, color: colors.muted }}>
                {unlocksAt.toLocaleDateString()}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// // -- Trust document
// Purpose, beneficiaries, distribution rules, succession notes.
// Every member sees it; only the vault owner can edit.

function TrustDocSection({ vault }: { vault: Vault }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [doc, setDoc] = useState<TrustDoc>(vault.trust_doc ?? {});
  const [session, setSession] = useState<{ user: { id: string } } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Lightweight: we only need to compare user_id to decide if
    // the edit button should appear. Session comes from Supabase.
    import("../lib/supabase").then(({ supabase }) => {
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
              fontSize: 11,
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
              style={{ fontSize: 11, padding: "3px 9px" }}
              onClick={() => setEditing(true)}
            >
              {empty ? "Add" : "Edit"}
            </Button>
          )}
        </div>
        {empty ? (
          <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
            No trust document yet. {isOwner ? "Describe the purpose, beneficiaries, and distribution rules so every member signs with context." : "The trustee hasn't filled this in yet."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {doc.purpose && (
              <TrustField label="Purpose" value={doc.purpose} />
            )}
            {(doc.beneficiaries ?? []).length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: colors.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                  Beneficiaries
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {(doc.beneficiaries ?? []).map((b, i) => (
                    <div key={i} style={{ fontSize: 13, color: colors.text }}>
                      {b.name}
                      {b.relation ? (
                        <span style={{ color: colors.muted }}> -- {b.relation}</span>
                      ) : null}
                      {b.notes ? (
                        <div style={{ fontSize: 11, color: colors.muted }}>
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
                <div style={{ fontSize: 11, fontWeight: 600, color: colors.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                  Enforced rules
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(doc.rules ?? []).map(r => (
                    <div key={r.id} style={{ fontSize: 13, color: colors.text }}>
                      {r.name}
                      {r.max_sats ? (
                        <span style={{ color: colors.muted }}>
                          {" "} / max {satsToBtc(r.max_sats)} BTC per spend
                        </span>
                      ) : null}
                      {r.requires_comment && (
                        <span style={{ color: colors.orange, marginLeft: 6, fontSize: 11 }}>
                          requires reason
                        </span>
                      )}
                      {r.notes && (
                        <div style={{ fontSize: 11, color: colors.muted }}>
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
          fontSize: 11,
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

// // -- Scheduled stipends (T-stipend mode)
// UX schedule layer over the existing proposal/signing pipeline.
// Not Bitcoin-enforced vesting -- every spend still requires real
// trustee signatures. This just surfaces what's due and prefills
// the Send form so nobody has to remember dates.

const INTERVAL_OPTIONS: StipendInterval[] = ["weekly", "monthly", "quarterly", "annually"];

function StipendsSection({
  vault,
  onSendPrefill,
}: {
  vault: Vault;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  const toast = useToast();
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
    if (!confirm("Remove this stipend?")) return;
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
            fontSize: 11,
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
                fontSize: 10,
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
            style={{ fontSize: 11, padding: "3px 9px" }}
            onClick={() => setAdding(true)}
          >
            Add
          </Button>
        )}
      </div>

      {list.length === 0 && !adding && isOwner && (
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
          No stipends yet. Add a recurring distribution (monthly living expenses, quarterly tuition, annual charitable grants) so trustees see what's due without tracking dates manually. Every spend still needs real trustee signatures.
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
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
          {s.name}
          {!s.active && (
            <span style={{ color: colors.muted, fontSize: 11, marginLeft: 6 }}>paused</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: overdue ? colors.orange : colors.sub }}>
          {overdue ? "Due " : "Next "} {dueLabel}
        </div>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span>{satsToBtc(s.amount_sats)} BTC</span>
        <span>{intervalLabel(s.interval_kind)}</span>
        {s.recipient_name && <span>{s.recipient_name}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
        {s.active && (
          <Button size="sm" style={{ fontSize: 11 }} onClick={onSend}>
            {overdue ? "Send now" : "Prefill send"}
          </Button>
        )}
        {isOwner && (
          <>
            <Button variant="ghost" size="sm" style={{ fontSize: 11 }} onClick={onEdit}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" style={{ fontSize: 11 }} onClick={onToggle}>
              {s.active ? "Pause" : "Resume"}
            </Button>
            <Button variant="danger" size="sm" style={{ fontSize: 11 }} onClick={onRemove}>
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
        });
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
              fontSize: 13,
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
              fontSize: 13,
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
        <Button variant="ghost" size="sm" style={{ fontSize: 12 }} type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" style={{ fontSize: 12 }} disabled={saving} type="submit">
          {saving ? "Saving..." : existing ? "Save" : "Create"}
        </Button>
      </div>
    </form>
  );
}

function TrustField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: colors.muted,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: colors.text, whiteSpace: "pre-wrap" }}>
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
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        Each rule gives the Send form a named category trustees must pick
        from. Optional amount cap; optional required reason. These are
        soft-enforced client-side, not on-chain.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rules.map((r, i) => (
          <div
            key={r.id}
            style={{
              background: "#0A0A14",
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
                  fontSize: 12,
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
              <Button variant="ghost" size="sm" style={{ fontSize: 11 }} onClick={() => remove(i)}>
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

// // -- Requests tab
// Distribution request queue. Beneficiaries (or any member) file
// a request; trustees approve -> creates a draft proposal
// pre-filled with the amount + rule, or decline with a note.

function RequestsTab({ vault }: { vault: Vault }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [requests, setRequests] = useState<VaultRequest[]>([]);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, m] = await Promise.all([
        api.vaultRequests.list(vault.id),
        api.members.list(vault.id),
      ]);
      setRequests(r.requests);
      setMembers(m.members);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [vault.id]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setCurrentUserId(data.session?.user.id ?? null);
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeRefresh(
    { table: "vault_requests", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  const me = members.find(m => m.user_id === currentUserId);
  const iAmTrustee = me ? isTrusteeRole(me.role) : false;

  async function resolve(r: VaultRequest, status: VaultRequestStatus, note?: string) {
    try {
      await api.vaultRequests.update(r.id, {
        status,
        resolution_note: note,
      });
      toast.success(`Request ${status}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  function startProposalFromRequest(r: VaultRequest) {
    // The Send tab reads state via form inputs; we can't prefill
    // directly without a refactor, so we just navigate there and
    // let the trustee paste the amount. Future improvement:
    // pass amount + rule + reason via location state.
    navigate(`/vaults/${vault.id}`, { state: { vault, sendPrefill: r } });
    toast.info("Create the proposal in the Send tab with this request's details");
  }

  if (loading) return <p style={{ color: colors.muted, fontSize: 14 }}>Loading...</p>;

  const pending = requests.filter(r => r.status === "pending");
  const resolved = requests.filter(r => r.status !== "pending");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ fontSize: 14, color: colors.muted }}>
          {pending.length} pending, {resolved.length} resolved
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          + New request
        </Button>
      </div>

      {pending.length > 0 ? (
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
              padding: "10px 16px",
              borderBottom: `1px solid ${colors.border}`,
              fontSize: 13,
              fontWeight: 600,
              color: colors.text,
            }}
          >
            Pending
          </div>
          {pending.map(r => (
            <RequestRow
              key={r.id}
              request={r}
              requesterLabel={members.find(m => m.user_id === r.requested_by)?.label ?? "Member"}
              iAmTrustee={iAmTrustee}
              iAmRequester={r.requested_by === currentUserId}
              onApprove={() => {
                void resolve(r, "approved", "Create the proposal in Send.");
                startProposalFromRequest(r);
              }}
              onDecline={() => {
                const note = prompt("Reason for declining? (optional)") ?? undefined;
                void resolve(r, "declined", note);
              }}
              onCancel={() => void resolve(r, "cancelled")}
            />
          ))}
        </div>
      ) : (
        <p style={{ color: colors.muted, fontSize: 13 }}>
          No pending requests. {iAmTrustee ? "Beneficiaries file here." : "Tap + New request to ask for a distribution."}
        </p>
      )}

      {resolved.length > 0 && (
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
              padding: "10px 16px",
              borderBottom: `1px solid ${colors.border}`,
              fontSize: 13,
              fontWeight: 600,
              color: colors.muted,
            }}
          >
            History
          </div>
          {resolved.map(r => (
            <RequestRow
              key={r.id}
              request={r}
              requesterLabel={members.find(m => m.user_id === r.requested_by)?.label ?? "Member"}
              iAmTrustee={false}
              iAmRequester={false}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <NewRequestModal
          vault={vault}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function RequestRow({
  request: r,
  requesterLabel,
  iAmTrustee,
  iAmRequester,
  onApprove,
  onDecline,
  onCancel,
}: {
  request: VaultRequest;
  requesterLabel: string;
  iAmTrustee: boolean;
  iAmRequester: boolean;
  onApprove?: () => void;
  onDecline?: () => void;
  onCancel?: () => void;
}) {
  const color =
    r.status === "approved" || r.status === "fulfilled"
      ? colors.green
      : r.status === "declined" || r.status === "cancelled"
        ? colors.red
        : colors.orange;

  return (
    <div
      style={{
        padding: "12px 16px",
        borderBottom: `1px solid ${colors.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 600, color: colors.text, fontFamily: fonts.display }}>
            {(r.amount_sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0"} BTC
          </span>
          {r.rule_name && (
            <span style={{ color: colors.muted, fontSize: 12, marginLeft: 8 }}>
              via {r.rule_name}
            </span>
          )}
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: "2px 7px",
            borderRadius: 4,
            background: color + "22",
            color,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {r.status}
        </span>
      </div>
      <div style={{ fontSize: 12, color: colors.muted }}>
        Requested by {requesterLabel}
        {r.recipient_name ? ` for ${r.recipient_name}` : ""}
        {" / "}
        {new Date(r.created_at).toLocaleDateString()}
      </div>
      {r.reason && (
        <div style={{ fontSize: 13, color: colors.sub, whiteSpace: "pre-wrap" }}>{r.reason}</div>
      )}
      {r.resolution_note && (
        <div style={{ fontSize: 12, color: colors.muted, fontStyle: "italic" }}>
          Note: {r.resolution_note}
        </div>
      )}
      {r.status === "pending" && (iAmTrustee || iAmRequester) && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          {iAmTrustee && onApprove && (
            <Button size="sm" style={{ fontSize: 12 }} onClick={onApprove}>
              Approve + create proposal
            </Button>
          )}
          {iAmTrustee && onDecline && (
            <Button variant="danger" size="sm" style={{ fontSize: 12 }} onClick={onDecline}>
              Decline
            </Button>
          )}
          {iAmRequester && onCancel && (
            <Button variant="ghost" size="sm" style={{ fontSize: 12 }} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function NewRequestModal({
  vault,
  onClose,
  onCreated,
}: {
  vault: Vault;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const rules = vault.trust_doc?.rules ?? [];
  const [ruleId, setRuleId] = useState<string>(rules[0]?.id ?? "");
  const [amountBtc, setAmountBtc] = useState("");
  const [recipient, setRecipient] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedRule = rules.find(r => r.id === ruleId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const sats = Math.round(parseFloat(amountBtc || "0") * 1e8);
    if (sats < 546) {
      setErr("Minimum 546 sats");
      return;
    }
    if (selectedRule?.max_sats && sats > selectedRule.max_sats) {
      setErr(
        `Exceeds "${selectedRule.name}" cap of ${satsToBtc(selectedRule.max_sats)} BTC per request.`,
      );
      return;
    }
    if (selectedRule?.requires_comment && !reason.trim()) {
      setErr(`"${selectedRule.name}" requires a reason.`);
      return;
    }
    setBusy(true);
    try {
      await api.vaultRequests.create({
        vault_id: vault.id,
        rule_id: selectedRule?.id,
        rule_name: selectedRule?.name,
        amount_sats: sats,
        recipient_name: recipient.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      toast.success("Request filed");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
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
          maxWidth: 460,
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
          File a distribution request
        </h2>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
                  fontSize: 14,
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
            </div>
          )}
          <div>
            <Label>Amount (BTC)</Label>
            <Input
              type="number"
              step="0.00000001"
              min="0.00000546"
              value={amountBtc}
              onChange={e => setAmountBtc(e.target.value)}
              required
              placeholder="0.01"
            />
          </div>
          <div>
            <Label>Recipient (optional)</Label>
            <Input
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              placeholder="e.g. Emma (daughter), University of X"
            />
          </div>
          <div>
            <Label>
              Reason{selectedRule?.requires_comment ? " (required)" : " (optional)"}
            </Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Why this distribution? Which clause of the trust does it satisfy?"
            />
          </div>
          {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}
          <div style={{ display: "flex", gap: 10 }}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Filing..." : "File request"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// // -- Distribution wallets (T-vesting)
// Each wallet splits a lump sum into N tranches, each gated by
// CLTV at an absolute block height. Beneficiary claims alone after
// the unlock; trustees always retain an escape hatch on every
// tranche so unclaimed funds aren't stranded. The creation
// ceremony calls api.distributionWallets.compileTranche once per
// tranche (via Fly.io), collects the addresses, then POSTs the
// whole plan in one shot.

function DistributionWalletsSection({
  vault,
  onSendPrefill,
}: {
  vault: Vault;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  const toast = useToast();
  const [wallets, setWallets] = useState<DistributionWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
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
      const res = await api.distributionWallets.list(vault.id);
      setWallets(res.wallets);
    } catch {
      /* empty state is fine */
    } finally {
      setLoading(false);
    }
  }, [vault.id]);

  useEffect(() => { void load(); }, [load]);

  useRealtimeRefresh(
    { table: "distribution_wallets", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  if (loading) return null;
  if (!isOwner && wallets.length === 0) return null;
  // Distribution wallets only make sense once a vault is compiled
  // (the ceremony needs the vault's trustee pubkeys).
  if (vault.status === "draft") return null;

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
          marginBottom: wallets.length === 0 && !creating ? 0 : 10,
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: colors.muted,
            textTransform: "uppercase",
          }}
        >
          Distribution wallets
        </div>
        {isOwner && !creating && (
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 11, padding: "3px 9px" }}
            onClick={() => setCreating(true)}
          >
            New plan
          </Button>
        )}
      </div>

      {wallets.length === 0 && !creating && isOwner && (
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
          No distribution wallets yet. Create one to split a lump sum
          into N tranches that unlock on a schedule (annual, quarterly,
          monthly). Each tranche is claimable by the beneficiary alone
          once its block height is reached; trustees always retain an
          escape hatch on every tranche.
        </div>
      )}

      {wallets.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {wallets.map(w => (
            <DistributionWalletRow
              key={w.id}
              wallet={w}
              vault={vault}
              onSendPrefill={onSendPrefill}
            />
          ))}
        </div>
      )}

      {creating && (
        <div style={{ marginTop: 10 }}>
          <DistributionWalletCreator
            vault={vault}
            onCancel={() => setCreating(false)}
            onSaved={() => { setCreating(false); void load(); toast.success("Distribution wallet created"); }}
          />
        </div>
      )}
    </div>
  );
}

function DistributionWalletRow({
  wallet,
  vault,
  onSendPrefill,
}: {
  wallet: DistributionWallet;
  vault: Vault;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  const [tip, setTip] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    tipHeight(vault.network).then(setTip).catch(() => {});
  }, [vault.network]);

  const total = wallet.tranches.reduce((n, t) => n + t.amount_sats, 0);
  const claimed = wallet.tranches.filter(t => t.claimed_txid).length;
  const funded = wallet.tranches.filter(t => t.funded_txid).length;

  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
            {wallet.name}
            {wallet.beneficiary_name && (
              <span style={{ color: colors.muted, fontWeight: 400, marginLeft: 6 }}>
                -- {wallet.beneficiary_name}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: colors.muted }}>
            {wallet.tranches.length} tranches . {satsToBtc(total)} BTC total
            {funded > 0 && <> . {funded} funded</>}
            {claimed > 0 && <> . {claimed} claimed</>}
          </div>
        </div>
        <Button variant="ghost" size="sm" style={{ fontSize: 11 }} onClick={() => setExpanded(e => !e)}>
          {expanded ? "Hide" : "Show"}
        </Button>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {wallet.tranches.map(t => (
            <TrancheRow
              key={t.index}
              tranche={t}
              tip={tip}
              onFund={() =>
                onSendPrefill({
                  destination: t.address,
                  amount_sats: t.amount_sats,
                  memo: `Fund ${wallet.name} tranche ${t.index + 1}`,
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TrancheRow({
  tranche: t,
  tip,
  onFund,
}: {
  tranche: DistributionTranche;
  tip: number | null;
  onFund: () => void;
}) {
  const isClaimed = !!t.claimed_txid;
  const isFunded = !!t.funded_txid;
  const blocksLeft = tip != null ? Math.max(0, t.unlock_block - tip) : null;
  const unlocked = tip != null && tip >= t.unlock_block;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        padding: "6px 8px",
        borderRadius: 6,
        background: isClaimed
          ? colors.green + "11"
          : unlocked
            ? colors.gold + "11"
            : "transparent",
        border: `1px solid ${isClaimed ? colors.green + "44" : colors.border}`,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: colors.text }}>
          Tranche {t.index + 1} . {satsToBtc(t.amount_sats)} BTC
        </div>
        <div style={{ fontSize: 11, color: colors.muted, fontFamily: fonts.mono, wordBreak: "break-all" }}>
          {t.address}
        </div>
      </div>
      <div style={{ textAlign: "right", fontSize: 11, color: colors.sub }}>
        <div>Unlock block {t.unlock_block.toLocaleString()}</div>
        {blocksLeft != null && blocksLeft > 0 && (
          <div style={{ color: colors.muted }}>{blocksLeft.toLocaleString()} blocks left</div>
        )}
        {isClaimed && <div style={{ color: colors.green }}>claimed</div>}
        {!isClaimed && !isFunded && (
          <Button size="sm" style={{ fontSize: 10, padding: "2px 6px", marginTop: 3 }} onClick={onFund}>
            Fund
          </Button>
        )}
      </div>
    </div>
  );
}

function DistributionWalletCreator({
  vault,
  onCancel,
  onSaved,
}: {
  vault: Vault;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [beneficiaryName, setBeneficiaryName] = useState("");
  const [beneficiaryXpub, setBeneficiaryXpub] = useState("");
  const [beneficiaryKeyId, setBeneficiaryKeyId] = useState("");
  const [trancheCount, setTrancheCount] = useState(12);
  const [amountPerTrancheBtc, setAmountPerTrancheBtc] = useState("0.01");
  const [intervalBlocks, setIntervalBlocks] = useState(4380); // ~1 month
  const [firstUnlockBlock, setFirstUnlockBlock] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const localKeys = listKeys().filter(k =>
    k.status === "active" && k.network === vault.network,
  );

  useEffect(() => {
    // Default first unlock = current tip + one interval
    tipHeight(vault.network)
      .then(h => setFirstUnlockBlock(h + 4380))
      .catch(() => setFirstUnlockBlock(100_000));
  }, [vault.network]);

  // Derive trustee pubkeys from vault.founder_keys. Each entry is an
  // xpub; the compiler needs pubkey hex at xpub/0/0 (Nunchuk parity).
  async function deriveTrusteePubkeys(): Promise<string[]> {
    return vault.founder_keys.map(x => pubkeyFromXpub(x));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name required"); return; }
    const amountSats = Math.round(parseFloat(amountPerTrancheBtc || "0") * 1e8);
    if (amountSats < 546) { setErr("Amount per tranche must be at least 546 sats"); return; }
    if (trancheCount < 1 || trancheCount > 60) { setErr("Tranche count must be 1-60"); return; }
    if (!firstUnlockBlock || firstUnlockBlock < 1) { setErr("First unlock block required"); return; }

    let beneficiaryPubkey = "";
    let beneficiaryXpubEffective = beneficiaryXpub.trim();

    if (beneficiaryKeyId) {
      const k = localKeys.find(k => k.keyId === beneficiaryKeyId);
      if (!k) { setErr("Pick a beneficiary key"); return; }
      beneficiaryXpubEffective = k.xpub;
      beneficiaryPubkey = pubkeyFromXpub(k.xpub);
    } else if (beneficiaryXpubEffective) {
      try {
        beneficiaryPubkey = pubkeyFromXpub(beneficiaryXpubEffective);
      } catch {
        setErr("Invalid beneficiary xpub");
        return;
      }
    } else {
      setErr("Pick a local beneficiary key or paste an xpub");
      return;
    }

    setBusy(true);
    setErr(null);
    try {
      const trusteeKeys = await deriveTrusteePubkeys();
      const tranches: DistributionTranche[] = [];
      for (let i = 0; i < trancheCount; i++) {
        const unlock = firstUnlockBlock + i * intervalBlocks;
        const compiled = await api.distributionWallets.compileTranche({
          network: vault.network,
          beneficiary_key: beneficiaryPubkey,
          trustee_keys: trusteeKeys,
          trustee_quorum: vault.founder_quorum,
          unlock_block: unlock,
        });
        tranches.push({
          index: i,
          unlock_block: unlock,
          amount_sats: amountSats,
          address: compiled.address,
          descriptor: compiled.descriptor,
        });
      }
      await api.distributionWallets.create({
        vault_id: vault.id,
        name: name.trim(),
        beneficiary_name: beneficiaryName.trim() || undefined,
        beneficiary_xpub: beneficiaryXpubEffective,
        beneficiary_pubkey: beneficiaryPubkey,
        trustee_keys: trusteeKeys,
        trustee_quorum: vault.founder_quorum,
        network: vault.network,
        tranches,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={create}
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
        <Label>Plan name</Label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Sarah 2026 annual"
        />
      </div>
      <div>
        <Label>Beneficiary name (optional)</Label>
        <Input
          value={beneficiaryName}
          onChange={e => setBeneficiaryName(e.target.value)}
          placeholder="Sarah"
        />
      </div>
      <div>
        <Label>Beneficiary key</Label>
        {localKeys.length > 0 && (
          <select
            value={beneficiaryKeyId}
            onChange={e => { setBeneficiaryKeyId(e.target.value); setBeneficiaryXpub(""); }}
            style={{
              width: "100%",
              padding: "8px 10px",
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              color: colors.text,
              fontFamily: fonts.sans,
              fontSize: 13,
              marginBottom: 6,
            }}
          >
            <option value="">-- Pick a local key --</option>
            {localKeys.map(k => (
              <option key={k.keyId} value={k.keyId}>
                {k.label} ({k.persona})
              </option>
            ))}
          </select>
        )}
        <Input
          mono
          value={beneficiaryXpub}
          onChange={e => { setBeneficiaryXpub(e.target.value); setBeneficiaryKeyId(""); }}
          placeholder="...or paste a beneficiary xpub"
          disabled={!!beneficiaryKeyId}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <Label>Tranche count</Label>
          <Input
            type="number"
            min={1}
            max={60}
            value={trancheCount}
            onChange={e => setTrancheCount(parseInt(e.target.value) || 1)}
          />
        </div>
        <div>
          <Label>BTC per tranche</Label>
          <Input
            mono
            value={amountPerTrancheBtc}
            onChange={e => setAmountPerTrancheBtc(e.target.value)}
          />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <Label>Interval (blocks)</Label>
          <Input
            type="number"
            min={144}
            value={intervalBlocks}
            onChange={e => setIntervalBlocks(parseInt(e.target.value) || 4380)}
          />
          <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>
            {blocksToLabel(intervalBlocks)} . 4380 =~ 1 month, 13140 =~ 3 months, 52560 =~ 1 year
          </div>
        </div>
        <div>
          <Label>First unlock block</Label>
          <Input
            type="number"
            value={firstUnlockBlock ?? ""}
            onChange={e => setFirstUnlockBlock(parseInt(e.target.value) || 0)}
          />
          <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>
            Absolute height where the first tranche unlocks.
          </div>
        </div>
      </div>
      {err && <div style={{ color: colors.orange, fontSize: 12 }}>{err}</div>}
      <div style={{ fontSize: 11, color: colors.muted }}>
        Compiles one Taproot address per tranche via the Fly.io
        compiler. Each tranche: beneficiary alone after its unlock
        block, or trustees any time (escape hatch).
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 12 }} type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" style={{ fontSize: 12 }} type="submit" disabled={busy}>
          {busy ? `Compiling ${trancheCount} tranches...` : `Create (${trancheCount} tranches)`}
        </Button>
      </div>
    </form>
  );
}

// // -- UTXO list (per-coin view + coin-control)
// Every confirmed or unconfirmed output sitting at the vault
// address, shown individually so trustees can see exactly what
// they hold and (for confirmed UTXOs) click "Spend" to lock the
// Send flow to that one coin.

function UtxosSection({
  vault,
  onSendPrefill,
}: {
  vault: Vault;
  onSendPrefill: (p: SendPrefill) => void;
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
  }>>([]);
  const [tip, setTip] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
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
  }, [vault.id, toast]);

  useEffect(() => { void load(); }, [load]);

  if (loading && utxos.length === 0) {
    return (
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: "14px 16px",
          fontSize: 12,
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
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: colors.muted,
            textTransform: "uppercase",
          }}
        >
          UTXOs ({utxos.length}) . {satsToBtc(total)} BTC total
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 11, padding: "3px 9px" }}
            onClick={selectAll}
          >
            All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 11, padding: "3px 9px" }}
            onClick={clearPicked}
            disabled={picked.size === 0}
          >
            None
          </Button>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 11, padding: "3px 9px" }}
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
            fontSize: 12,
            marginBottom: 10,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ color: colors.gold }}>
            {pickedCount} selected . {satsToBtc(pickedTotal)} BTC
          </span>
          <Button size="sm" style={{ fontSize: 11 }} onClick={spendPicked}>
            Spend selected
          </Button>
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
                  <span style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
                    {satsToBtc(u.value_sats)} BTC
                  </span>
                </label>
                <span style={{ fontSize: 11, color: u.confirmed ? colors.muted : colors.orange }}>
                  {label}
                  {u.confirmed && tip != null && u.block_height != null && (
                    <> . block {u.block_height.toLocaleString()}</>
                  )}
                </span>
              </div>
              <div
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  color: colors.muted,
                  wordBreak: "break-all",
                }}
              >
                {u.txid}:{u.vout}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                {u.confirmed && (
                  <Button
                    size="sm"
                    style={{ fontSize: 11, padding: "3px 9px" }}
                    onClick={() => spendOnly(u)}
                  >
                    Spend only this
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  style={{ fontSize: 11, padding: "3px 9px" }}
                  onClick={() => copy(u.txid, id)}
                >
                  {copied === id ? "Copied" : "Copy txid"}
                </Button>
                <a
                  href={explorerTxUrl(vault.network, u.txid)}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 11,
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
