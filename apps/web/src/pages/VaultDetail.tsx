import { useEffect, useState, useCallback } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  api,
  type Vault,
  type Proposal,
  type BalanceResult,
  type VaultMember,
  type VaultMessage,
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
import { useConfirm, usePrompt } from "../components/dialog";
import { LoadingScreen } from "../components/LoadingScreen";
import { colors, fonts, radii, space } from "../theme";
import { Button, Input, Label, Textarea } from "../components/ui";
import { PsbtQrDisplay } from "../components/PsbtQrDisplay";
import { PsbtQrScanner } from "../components/PsbtQrScanner";
import { useRealtimeRefresh } from "../lib/realtime";
import { normalizePsbt } from "../lib/psbt-format";
import { downloadVault } from "../lib/descriptor-backup";
import { DescriptorQr } from "../components/DescriptorQr";
import { pubkeyFromXpub, fingerprintFromXpub } from "../lib/xpub";
import { ensureMessagingKey, encryptMessage, decryptMessage, getMessagingPubkey } from "../lib/messaging";
import { TrustTab } from "../components/TrustTab";
import { RemindersBanner } from "../components/RemindersBanner";
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
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const navigate = useNavigate();
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [tab, setTab] = useState<"overview" | "send" | "history" | "members" | "activity" | "requests" | "messages" | "trust">("overview");
  const [archiving, setArchiving] = useState(false);
  const [showRotate, setShowRotate] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [sendPrefill, setSendPrefill] = useState<SendPrefill | null>(null);
  const [myMember, setMyMember] = useState<VaultMember | null>(null);

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

  // Publish this browser's X25519 messaging pubkey to the user's
  // vault_members row on first visit so other members can send
  // us E2E-encrypted messages. Private key stays in localStorage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const myPub = getMessagingPubkey();
        const { data } = await supabase.auth.getSession();
        const myUserId = data.session?.user.id;
        if (!myUserId) return;
        const { members } = await api.members.list(vault.id);
        const me = members.find(m => m.user_id === myUserId);
        if (!me || cancelled) return;
        if (me.messaging_pubkey === myPub) return;
        await api.members.update(me.id, { messaging_pubkey: myPub });
      } catch {
        /* non-fatal; messaging will surface the gap in-UI */
      }
    })();
    return () => { cancelled = true; };
  }, [vault.id]);

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

  // Track the caller's own membership row so we can nudge signer-role
  // members who claimed a slot but never attached a key.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const uid = data.session?.user.id;
        if (!uid) return;
        const { members } = await api.members.list(vault.id);
        if (cancelled) return;
        setMyMember(members.find(m => m.user_id === uid) ?? null);
      } catch {
        /* best-effort; Members tab surfaces real errors */
      }
    })();
    return () => { cancelled = true; };
  }, [vault.id, tab]);

  const myMemberNeedsKey =
    !!myMember &&
    ["founder", "heir", "protector"].includes(myMember.role) &&
    !(myMember.xpub && myMember.fingerprint && myMember.pubkey && myMember.derivation_path);

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
    const typed = await askPrompt({
      title: "Delete vault",
      message: `Permanently delete "${expected}"? This cannot be undone. Any funds still at the vault address stay spendable via the descriptor backup (downloaded from the overview tab), but the vault will no longer appear in this app. Type the vault name to confirm.`,
      placeholder: expected,
      matchValue: expected,
      confirmLabel: "Delete vault",
    });
    if (typed !== expected) return; // cancelled or mismatch (guarded by matchValue)
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
        <div style={{ display: "flex", gap: 6 }}>
          {vault.status === "compiled" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={archiving}
              style={{ fontSize: 12 }}
              onClick={() => setShowRotate(true)}
            >
              Rotate
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            disabled={archiving}
            style={{ fontSize: 12 }}
            onClick={deleteVault}
          >
            Delete
          </Button>
        </div>
      </header>
      {showRotate && (
        <RotateVaultModal
          vault={vault}
          onClose={() => setShowRotate(false)}
          onRotated={v => {
            setShowRotate(false);
            navigate(`/vaults/${v.id}`, { state: { vault: v } });
          }}
        />
      )}

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

        {/* Missing-key nudge: persistent across tabs for signer roles. */}
        {myMemberNeedsKey && tab !== "members" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              background: colors.orange + "14",
              border: `1px solid ${colors.orange}55`,
              borderRadius: 10,
              padding: "12px 14px",
              marginBottom: 16,
            }}
          >
            <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5 }}>
              You claimed the <strong>{roleLabel(myMember!.role)}</strong> slot but haven't attached a
              signing key. The vault can't be compiled or signed by you until you do.
            </div>
            <Button size="sm" onClick={() => setTab("members")}>
              Add your key
            </Button>
          </div>
        )}

        {/* Tabs */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            rowGap: 2,
            columnGap: 2,
            borderBottom: `1px solid ${colors.border}`,
            marginBottom: 20,
          }}
        >
          {(vault.status === 'draft'
            ? [
                { id: "overview", label: "Overview" },
                { id: "members", label: "Members" },
                { id: "messages", label: "Messages" },
                { id: "trust", label: "Trust" },
                { id: "activity", label: "Activity" },
              ]
            : [
                { id: "overview", label: "Overview" },
                { id: "send", label: "Send" },
                { id: "requests", label: "Requests" },
                { id: "history", label: "History", count: pendingCount },
                { id: "members", label: "Members" },
                { id: "messages", label: "Messages" },
                { id: "trust", label: "Trust" },
                { id: "activity", label: "Activity" },
              ]
          ).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as typeof tab)}
              style={{
                flex: "1 1 0",
                minWidth: 76,
                padding: "8px 10px",
                border: "none",
                fontSize: 13,
                cursor: "pointer",
                fontFamily: fonts.sans,
                background: tab === t.id ? colors.input : "transparent",
                color: tab === t.id ? colors.text : colors.muted,
                borderBottom: tab === t.id ? `2px solid ${colors.gold}` : "2px solid transparent",
                borderTopLeftRadius: 6,
                borderTopRightRadius: 6,
                marginBottom: -1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                whiteSpace: "nowrap",
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
          <OverviewTab
            vault={vault}
            copy={copy}
            copied={copied}
            onSendPrefill={prefillSend}
            proposals={proposals}
            onOpenTab={id => setTab(id as typeof tab)}
          />
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
        {tab === "messages" && <MessagesTab vault={vault} />}
        {tab === "trust" && <TrustTab vault={vault} />}
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
  proposals,
  onOpenTab,
}: {
  vault: Vault;
  copy: (text: string, id: string) => void;
  copied: string | null;
  onSendPrefill: (p: SendPrefill) => void;
  proposals: Proposal[];
  onOpenTab: (id: string) => void;
}) {
  const toast = useToast();
  const askPrompt = usePrompt();
  // Inheritance vaults get all three spending paths; plain vaults
  // (no heirs, no timelocks) get only the trustee-now path.
  const plain =
    (vault.heir_keys?.length ?? 0) === 0 &&
    vault.recovery_after === 0 &&
    vault.inheritance_after === 0;

  const [showDescriptorQr, setShowDescriptorQr] = useState(false);

  // Timelocks are stored as ABSOLUTE CLTV block heights (what the
  // Taproot leaf's `after(N)` bakes in). For display we subtract
  // the current chain tip so labels show "unlocks in 6 years"
  // instead of "after 615,360 blocks" (which is absolute and
  // renders as ~11.7 years from genesis).
  const [chainTip, setChainTip] = useState<number | null>(null);
  useEffect(() => {
    if (plain) return;
    let cancelled = false;
    tipHeight(vault.network)
      .then(h => !cancelled && setChainTip(h))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [plain, vault.network]);
  const blocksFromNow = (abs: number | null | undefined) => {
    if (!abs || abs <= 0) return 0;
    if (chainTip == null) return abs; // fall back while tip is loading
    return Math.max(0, abs - chainTip);
  };

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
          title: "Recovery - " + blocksToLabel(blocksFromNow(vault.recovery_after)),
          body:
            vault.recovery_quorum != null && vault.recovery_quorum !== vault.founder_quorum
              ? `${vault.recovery_quorum} of ${vault.founder_keys.length} trustee signatures after ${blocksFromNow(vault.recovery_after).toLocaleString()} blocks. Insurance against a lost device: quorum drops below the normal ${vault.founder_quorum}-of-${vault.founder_keys.length} so trustees can still spend if one key is gone.`
              : `Trustees can recover after ${blocksFromNow(vault.recovery_after).toLocaleString()} blocks. Note: the recovery quorum matches the normal quorum, so this path grants no extra capability.`,
        },
        {
          num: 3,
          color: colors.green,
          title: "Inheritance - " + blocksToLabel(blocksFromNow(vault.inheritance_after)),
          body: `${vault.heir_quorum} of ${vault.heir_keys.length} successor signatures after ${blocksFromNow(vault.inheritance_after).toLocaleString()} blocks. Triggered only if the trustees are unreachable for the full window.`,
        },
        ...(vault.protector_keys.length > 0 &&
        vault.protector_quorum != null &&
        vault.protector_after != null
          ? [
              {
                num: 4,
                color: colors.blue,
                title: "Protector - " + blocksToLabel(blocksFromNow(vault.protector_after)),
                body: `${vault.protector_quorum} of ${vault.protector_keys.length} protector signatures after ${blocksFromNow(vault.protector_after).toLocaleString()} blocks. An independent watchdog who can rescue funds if trustees go rogue before inheritance triggers.`,
              },
            ]
          : []),
      ];

  // Draft vaults have no address yet and no timelocks to countdown
  // on, so short-circuit the usual overview and show the onboarding
  // roster + one-shot-compile education instead.
  if (vault.status === "draft") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <RemindersBanner vaultId={vault.id} />
        <DraftReadinessCard vault={vault} onOpenTab={onOpenTab} />
        <TrustDocSection vault={vault} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <RemindersBanner vaultId={vault.id} />
      <SuccessionBanner vault={vault} onSendPrefill={onSendPrefill} />
      <ActionGuide
        vault={vault}
        proposals={proposals}
        onOpenTab={onOpenTab}
        onSendPrefill={onSendPrefill}
      />
      {!plain && <VaultPhaseCard vault={vault} />}
      {!plain && <TimelockCountdown vault={vault} />}
      <TrustDocSection vault={vault} />
      <StipendsSection vault={vault} onSendPrefill={onSendPrefill} />
      <DistributionWalletsSection vault={vault} onSendPrefill={onSendPrefill} />
      <UtxosSection vault={vault} onSendPrefill={onSendPrefill} />

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
          ["Recovery", `unlocks at block ${vault.recovery_after.toLocaleString()} (${blocksToLabel(blocksFromNow(vault.recovery_after))})`],
          ["Inheritance", `unlocks at block ${vault.inheritance_after.toLocaleString()} (${blocksToLabel(blocksFromNow(vault.inheritance_after))})`],
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
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11 }}
              disabled={!vault.descriptor}
              onClick={() => setShowDescriptorQr(v => !v)}
            >
              {showDescriptorQr ? "Hide QR" : "Show QR"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11 }}
              onClick={async () => {
                const url = await api.auditPdfUrl(vault.id);
                window.open(url, "_blank");
              }}
            >
              Audit PDF
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11 }}
              onClick={async () => {
                // Default to last completed tax year. The server
                // accepts any year between 2020 and 2099.
                const lastYear = new Date().getUTCFullYear() - 1;
                const yearStr = await askPrompt({
                  title: "Tax summary",
                  message: "Which tax year should this summary cover?",
                  defaultValue: String(lastYear),
                  placeholder: String(lastYear),
                  confirmLabel: "Generate",
                });
                if (!yearStr) return;
                const year = Number(yearStr);
                if (!Number.isInteger(year) || year < 2020 || year > 2099) {
                  toast.error("Enter a valid 4-digit year between 2020 and 2099.");
                  return;
                }
                const url = await api.taxSummaryUrl(vault.id, year);
                window.open(url, "_blank");
              }}
            >
              Tax summary
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11 }}
              onClick={async () => {
                const url = await api.activityExportUrl(vault.id);
                window.open(url, "_blank");
              }}
            >
              Activity JSON
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
        {showDescriptorQr && vault.descriptor && (
          <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
            <DescriptorQr descriptor={vault.descriptor} label="Sparrow import QR" size={240} />
          </div>
        )}
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
  const askPassword = usePrompt();
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
  const [showQrDisplay, setShowQrDisplay] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);

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
      // Only local keys whose /0/0 pubkey actually appears in this
      // vault's founder leaf should be offered as signers. Anything
      // else just adds confusion -- if it's in the keyring but not
      // a founder of THIS vault, it can't help. Derive each vault
      // xpub to pubkey hex and intersect with the local keystore.
      const allLocalKeys = listKeys().filter(k => k.status === "active" && k.origin === "software");
      const vaultSignerPubkeys = new Set<string>();
      for (const x of vault.founder_keys) {
        if (typeof x !== 'string') continue;
        if (x.length === 66) {
          // Legacy rows stored pubkey hex directly.
          vaultSignerPubkeys.add(x);
          continue;
        }
        try {
          vaultSignerPubkeys.add(pubkeyFromXpub(x));
        } catch {
          /* skip malformed rows */
        }
      }
      const signingKeys = allLocalKeys.filter(k => vaultSignerPubkeys.has(k.pubkey));

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

    // Update status to signing, clearing any error from a previous attempt
    // so the row reads cleanly on retry.
    setSigning(prev => {
      if (!prev) return prev;
      const signers = [...prev.signers];
      signers[keyIndex] = { ...signers[keyIndex], status: "signing", error: undefined };
      return { ...prev, signers };
    });

    try {
      // Get mnemonic
      let pw: string | undefined;
      if (!key.testMnemonic) {
        const result = await askPassword({
          title: "Unlock key",
          message: `Enter the password for "${key.label}" to sign.`,
          password: true,
          confirmLabel: "Sign",
        });
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

  // Shared "an external signer just gave us a PSBT" handler. Used
  // by both the textarea paste flow and the QR scanner so the
  // merge + signer-session logging only lives in one place.
  function externalImport(importedHex: string) {
    if (!signing) return;
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
          background: colors.successBg,
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
                    background: signer.status === "signed" ? `${colors.green}0D` : colors.inset,
                    border: `1px solid ${signer.status === "signed" ? `${colors.green}44` : colors.border}`,
                    cursor:
                      signer.status === "pending" || signer.status === "error"
                        ? "pointer"
                        : "default",
                    opacity: signer.status === "signing" ? 0.7 : 1,
                  }}
                  onClick={() =>
                    (signer.status === "pending" || signer.status === "error") &&
                    void signWithKey(i)
                  }
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
                        {signer.error} -- tap to retry
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
            Export to Sparrow, Nunchuk, or Coldcard. Paste / scan the signed PSBT back here.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
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
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 12 }}
              onClick={() => setShowQrDisplay(s => !s)}
            >
              {showQrDisplay ? "Hide QR" : "Show QR (Jade / Coldcard Q)"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 12 }}
              onClick={() => setShowQrScanner(s => !s)}
            >
              {showQrScanner ? "Hide scanner" : "Scan signed QR"}
            </Button>
          </div>
          {showQrDisplay && (
            <div style={{ marginBottom: 14 }}>
              <PsbtQrDisplay psbtHex={signing.psbt_hex} />
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 6, textAlign: "center" }}>
                UR `crypto-psbt` animated. Stateless -- no pairing needed. Point your air-gapped signer at the screen.
              </div>
            </div>
          )}
          {showQrScanner && (
            <div style={{ marginBottom: 14 }}>
              <PsbtQrScanner
                onResult={hex => {
                  setShowQrScanner(false);
                  // Reuse the existing import path so signer-sessions
                  // logging + state-set logic stays in one place.
                  externalImport(hex);
                }}
                onCancel={() => setShowQrScanner(false)}
              />
            </div>
          )}
          <ExternalPsbtInput onImport={externalImport} />
        </div>

        {/* Action buttons */}
        {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}

        {quorumMet ? (
          <Button
            disabled={busy}
            style={{ background: colors.green, width: "100%", padding: "14px", fontSize: 16 }}
            onClick={() => void broadcast()}
          >
            {busy ? "Broadcasting..." : err ? "Retry broadcast" : "Broadcast transaction"}
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
  const askConfirm = useConfirm();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [invites, setInvites] = useState<VaultInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [recentLink, setRecentLink] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [showMyKey, setShowMyKey] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSessionUserId(data.session?.user?.id ?? null);
    });
  }, []);

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
    if (!(await askConfirm({ title: "Revoke invite", message: "Revoke this invite? The link will stop working and the recipient won't be able to join with it.", confirmLabel: "Revoke", danger: true }))) return;
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
    if (!(await askConfirm({ title: "Remove member", message: `Remove ${m.label ?? "this member"} from the vault? If the vault is already compiled their key stays in the on-chain policy; this only removes their app access.`, confirmLabel: "Remove", danger: true }))) return;
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
  const myself = members.find(m => m.user_id === sessionUserId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {myself && (
        <YourMembershipCard
          me={myself}
          vault={vault}
          onEdit={() => setShowMyKey(true)}
        />
      )}
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
              background: colors.inset,
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
              onCopyCode={() => {
                navigator.clipboard.writeText(inv.token);
                toast.success("Trust code copied");
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
      {showMyKey && myself && (
        <MyKeyModal
          vault={vault}
          me={myself}
          onClose={() => setShowMyKey(false)}
          onSaved={() => {
            setShowMyKey(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

// YourMembershipCard -- shown at the top of the Members tab for the
// current user. Makes it unambiguous which member row is "you" and
// gives a one-click path to update the xpub when a member claimed
// without providing one (or needs to rotate their key).
function YourMembershipCard({
  me,
  vault,
  onEdit,
}: {
  me: VaultMember;
  vault: Vault;
  onEdit: () => void;
}) {
  const hasKey = !!me.xpub && !!me.fingerprint && !!me.pubkey && !!me.derivation_path;
  const netLabel = vault.network.toUpperCase();
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${hasKey ? colors.green : colors.orange}`,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: colors.gold, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Your slot
        </div>
        <div style={{ fontSize: 14, color: colors.text, marginTop: 2 }}>
          {me.label ?? "Unnamed"} <span style={{ color: colors.muted }}>({roleLabel(me.role)})</span>
        </div>
        <div style={{ fontSize: 12, color: hasKey ? colors.sub : colors.orange, marginTop: 4 }}>
          {hasKey
            ? `Key ready -- fingerprint ${me.fingerprint} on ${netLabel}`
            : `No key yet -- you won't be able to sign until you add one`}
        </div>
      </div>
      <Button size="sm" variant={hasKey ? "ghost" : "primary"} onClick={onEdit}>
        {hasKey ? "Change key" : "Add your key"}
      </Button>
    </div>
  );
}

// MyKeyModal -- lets the current member attach or replace the key
// material on their own vault_members row. Reads from the browser
// keystore and calls api.members.update() to PATCH the row.
function MyKeyModal({
  vault,
  me,
  onClose,
  onSaved,
}: {
  vault: Vault;
  me: VaultMember;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string>("");
  const [label, setLabel] = useState(me.label ?? "");
  const [busy, setBusy] = useState(false);
  const eligibleKeys = listKeys().filter(
    k => k.status === "active" && k.network === vault.network,
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) {
      toast.error("Pick a key to attach to your slot");
      return;
    }
    const chosen = eligibleKeys.find(k => k.keyId === selectedId);
    if (!chosen) return;
    setBusy(true);
    try {
      await api.members.update(me.id, {
        label: label.trim() || undefined,
        xpub: chosen.xpub,
        fingerprint: chosen.masterFingerprint ?? chosen.fingerprint,
        pubkey: chosen.pubkey,
        derivation_path: chosen.derivationPath,
        key_label: chosen.label,
      });
      toast.success("Key attached to your slot");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 500,
        padding: space[4],
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: "24px 28px",
          width: "100%",
          maxWidth: 480,
          maxHeight: "90dvh",
          overflowY: "auto",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
          {me.xpub ? "Change your key" : "Add your key"}
        </div>
        <p style={{ fontSize: 13, color: colors.sub, lineHeight: 1.5, marginBottom: 14 }}>
          Pick an {vault.network.toUpperCase()} key from your local keystore to
          attach to your slot in {vault.name}. Private material stays in this
          browser -- only the xpub and derivation metadata go to the server.
        </p>
        {eligibleKeys.length === 0 ? (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              background: colors.input,
              color: colors.orange,
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            No active {vault.network.toUpperCase()} keys in your keystore.
            Open the Keys tab first to generate or import one.
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <Label>Your display label</Label>
              <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={me.label ?? "Your name"} />
            </div>
            <div>
              <Label>Key to attach</Label>
              <select
                value={selectedId}
                onChange={e => setSelectedId(e.target.value)}
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
                <option value="">-- pick a key --</option>
                {eligibleKeys.map(k => (
                  <option key={k.keyId} value={k.keyId}>
                    {k.label} -- {k.fingerprint}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !selectedId}>
                {busy ? "Saving..." : me.xpub ? "Replace key" : "Attach key"}
              </Button>
            </div>
          </form>
        )}
      </div>
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
  onCopyCode,
  onRevoke,
}: {
  invite: VaultInvite;
  onCopyLink: () => void;
  onCopyCode: () => void;
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
        flexWrap: "wrap",
        gap: 8,
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
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 12 }} onClick={onCopyLink}>
          Copy link
        </Button>
        <Button variant="ghost" size="sm" style={{ fontSize: 12 }} onClick={onCopyCode}>
          Copy code
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

// // -- MessagesTab
// E2E encrypted thread per vault. Messages are encrypted client-
// side with X25519 + ChaCha20-Poly1305 (see lib/messaging.ts).
// Server only stores ciphertext + per-recipient wrapped keys.
// Each member publishes their X25519 pubkey via the self-heal in
// VaultDetailInner on first visit; members without a pubkey
// published yet are listed so the sender knows who won't be
// able to read the message until they come online.

function MessagesTab({ vault }: { vault: Vault }) {
  const toast = useToast();
  const askConfirm = useConfirm();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [messages, setMessages] = useState<VaultMessage[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [showKeyReset, setShowKeyReset] = useState(false);

  useEffect(() => {
    // Ensure local keypair exists before rendering.
    ensureMessagingKey();
    supabase.auth.getSession().then(({ data }) =>
      setMyUserId(data.session?.user.id ?? null),
    );
  }, []);

  const load = useCallback(async () => {
    try {
      const [m, msg] = await Promise.all([
        api.members.list(vault.id),
        api.messages.list(vault.id),
      ]);
      setMembers(m.members);
      setMessages(msg.messages);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load messages");
    }
  }, [vault.id, toast]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeRefresh({ table: "vault_messages", filter: `vault_id=eq.${vault.id}` }, () => void load());

  const keyedMembers = members.filter(
    m => m.status === "active" && m.user_id && m.messaging_pubkey,
  );
  const pendingMembers = members.filter(
    m => m.status === "active" && m.user_id && !m.messaging_pubkey,
  );

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !myUserId) return;
    setBusy(true);
    try {
      const recipients = keyedMembers
        .filter(m => m.messaging_pubkey)
        .map(m => ({ user_id: m.user_id, pubkey: m.messaging_pubkey! }));
      if (recipients.length === 0) {
        toast.error("No members have published a messaging key yet.");
        return;
      }
      const enc = encryptMessage(draft.trim(), recipients);
      await api.messages.send({
        vault_id: vault.id,
        sender_pubkey: enc.sender_pubkey,
        nonce: enc.nonce,
        ciphertext: enc.ciphertext,
        recipients: enc.recipients,
      });
      setDraft("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  async function rekey() {
    if (!(await askConfirm({ title: "Regenerate messaging key", message: "Regenerate your messaging key? You will lose access to messages sent with your current key.", confirmLabel: "Regenerate", danger: true }))) return;
    localStorage.removeItem("dynastytrust:messaging:v1");
    ensureMessagingKey();
    setShowKeyReset(false);
    void load();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          padding: "10px 12px",
          background: colors.gold + "0C",
          border: `1px solid ${colors.gold}33`,
          borderRadius: radii.sm,
          fontSize: 12,
          color: colors.sub,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: colors.gold }}>End-to-end encrypted.</strong> Messages are sealed to each recipient's X25519 key before they leave your browser. The server stores ciphertext only and cannot read them. Your private key lives in this browser's local storage -- clearing site data wipes your ability to read past messages.
      </div>

      {pendingMembers.length > 0 && (
        <div
          style={{
            padding: "8px 12px",
            background: colors.orange + "0C",
            border: `1px solid ${colors.orange}33`,
            borderRadius: radii.sm,
            fontSize: 12,
            color: colors.sub,
          }}
        >
          Waiting for a messaging key from: {pendingMembers.map(m => m.label || "(unlabeled)").join(", ")}. They will be able to read your messages once they open the vault.
        </div>
      )}

      <form
        onSubmit={send}
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <Textarea
          rows={3}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={`Message to ${keyedMembers.length} member${keyedMembers.length === 1 ? "" : "s"}...`}
        />
        {keyedMembers.length === 0 && (
          <div style={{ fontSize: 12, color: colors.orange, lineHeight: 1.5 }}>
            {pendingMembers.length > 0
              ? `Can't send yet -- ${pendingMembers.length} member${pendingMembers.length === 1 ? " hasn't" : "s haven't"} opened this vault to publish a messaging key. Messages are end-to-end encrypted to each recipient, so everyone must visit the vault once first.`
              : "No other members can receive messages yet. Invite co-signers from the Members tab; each publishes a messaging key the first time they open the vault."}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 11, color: colors.muted }}>
            {keyedMembers.length} recipient{keyedMembers.length === 1 ? "" : "s"}
            {pendingMembers.length > 0 && keyedMembers.length > 0
              ? ` (${pendingMembers.length} not ready)`
              : ""}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              style={{ fontSize: 11 }}
              onClick={() => setShowKeyReset(s => !s)}
            >
              {showKeyReset ? "Cancel" : "Key settings"}
            </Button>
            <Button type="submit" disabled={busy || !draft.trim() || keyedMembers.length === 0}>
              {busy ? "Sending..." : "Send"}
            </Button>
          </div>
        </div>
        {showKeyReset && (
          <div
            style={{
              fontSize: 11,
              color: colors.muted,
              padding: "8px 10px",
              background: colors.bg,
              borderRadius: radii.sm,
            }}
          >
            Your messaging pubkey: <span style={{ fontFamily: fonts.mono }}>{getMessagingPubkey().slice(0, 16)}...{getMessagingPubkey().slice(-8)}</span>
            <div style={{ marginTop: 6 }}>
              <Button
                variant="danger"
                size="sm"
                type="button"
                style={{ fontSize: 11 }}
                onClick={rekey}
              >
                Regenerate key
              </Button>
              <span style={{ marginLeft: 8 }}>Deletes your local private key. Past messages become unreadable.</span>
            </div>
          </div>
        )}
      </form>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 13, color: colors.muted, textAlign: "center", padding: "24px 0" }}>
            No messages yet. Trustees + beneficiaries use this thread for off-chain coordination -- visible only to vault members.
          </div>
        )}
        {messages.map(m => {
          const plaintext = myUserId ? decryptMessage(m, myUserId) : null;
          const sender = members.find(mem => mem.user_id === m.sender_user_id);
          const senderLabel = sender?.label || "(unknown)";
          const mine = m.sender_user_id === myUserId;
          return (
            <div
              key={m.id}
              style={{
                padding: "10px 12px",
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderLeft: mine ? `3px solid ${colors.gold}` : `3px solid ${colors.blue}`,
                borderRadius: radii.md,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: colors.muted, marginBottom: 4 }}>
                <span>
                  <strong style={{ color: mine ? colors.gold : colors.text }}>{senderLabel}</strong>
                  {sender?.role ? ` . ${sender.role}` : ""}
                </span>
                <span>{new Date(m.created_at).toLocaleString()}</span>
              </div>
              <div style={{ fontSize: 14, color: colors.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {plaintext !== null ? plaintext : (
                  <span style={{ color: colors.muted, fontStyle: "italic" }}>
                    {m.recipients.some(r => r.user_id === myUserId)
                      ? "(cannot decrypt -- your messaging key may have changed)"
                      : "(not encrypted to this browser)"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

// // -- DraftReadinessCard
// Onboarding UI for a draft vault. Teaches "one-shot compile"
// -- the vault address is baked from everyone's xpubs at
// compile time and cannot be changed after; members added later
// live on a rotated successor vault, not this one. Shows every
// slot's status (claimed / pending) with copy-invite-link for
// outstanding slots. Compiles are blocked (server-side too)
// until every slot has a key.

// // -- SuccessionBanner
// Links a rotated vault to its predecessor and (if any) successor.
// Shows the forward chain so members understand they're looking at
// one link in an evolving trust, not a dead end. The "Sweep to
// successor" CTA on the predecessor prefills the Send flow with
// the new vault's address so the migration of funds is one click.

function SuccessionBanner({
  vault,
  onSendPrefill,
}: {
  vault: Vault;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  const [predecessor, setPredecessor] = useState<Vault | null>(null);
  const [successor, setSuccessor] = useState<Vault | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { vaults } = await api.vaults.list(true);
        if (cancelled) return;
        if (vault.predecessor_id) {
          const p = vaults.find(v => v.id === vault.predecessor_id);
          if (p) setPredecessor(p);
        }
        const s = vaults.find(v => v.predecessor_id === vault.id);
        if (s) setSuccessor(s);
      } catch {
        /* best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [vault.id, vault.predecessor_id]);

  if (!predecessor && !successor) return null;

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${colors.blue}`,
        borderRadius: 12,
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: colors.blue,
          textTransform: "uppercase",
        }}
      >
        Succession chain
      </div>
      {predecessor && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, color: colors.sub }}>
            Rotated from <strong style={{ color: colors.text }}>{predecessor.name}</strong>
            {predecessor.address && (
              <span style={{ color: colors.muted, marginLeft: 6, fontFamily: fonts.mono, fontSize: 11 }}>
                {predecessor.address.slice(0, 10)}...{predecessor.address.slice(-6)}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 11 }}
            onClick={() => navigate(`/vaults/${predecessor.id}`, { state: { vault: predecessor } })}
          >
            Open predecessor
          </Button>
        </div>
      )}
      {successor && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, color: colors.sub }}>
            Rotated to <strong style={{ color: colors.text }}>{successor.name}</strong>
            {successor.address
              ? (
                  <span style={{ color: colors.muted, marginLeft: 6, fontFamily: fonts.mono, fontSize: 11 }}>
                    {successor.address.slice(0, 10)}...{successor.address.slice(-6)}
                  </span>
                )
              : (
                  <span style={{ color: colors.orange, marginLeft: 6, fontSize: 11 }}>
                    draft -- awaiting compile
                  </span>
                )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {successor.address && (
              <Button
                size="sm"
                style={{ fontSize: 11 }}
                onClick={() =>
                  onSendPrefill({
                    destination: successor.address!,
                    memo: `Sweep to successor ${successor.name}`,
                  })
                }
              >
                Sweep to successor
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 11 }}
              onClick={() => navigate(`/vaults/${successor.id}`, { state: { vault: successor } })}
            >
              Open successor
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// // -- RotateVaultModal
// Create a successor draft vault that inherits the current vault's
// trust doc, member roster, quorums, and address type. Owner picks
// new timelocks (defaults to the current intent in blocks, or the
// same absolute heights translated to "blocks from now" via the
// chain tip). Members carry forward with their existing keys so
// the new vault is ready to compile immediately -- perfect for
// key rotation or for evolving the shape without losing history.
// For membership changes, open the Members tab on the successor
// draft AFTER rotation to add / remove members before compiling.

function RotateVaultModal({
  vault,
  onClose,
  onRotated,
}: {
  vault: Vault;
  onClose: () => void;
  onRotated: (v: Vault) => void;
}) {
  const toast = useToast();
  const [tip, setTip] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    tipHeight(vault.network).then(setTip).catch(() => {});
  }, [vault.network]);

  // Convert the source vault's ABSOLUTE heights back to block
  // offsets so the rotation modal defaults to the same intent.
  const offsetFromAbs = (abs: number | null | undefined) => {
    if (!abs || abs <= 0) return 0;
    if (tip == null) return abs;
    return Math.max(0, abs - tip);
  };

  const [name, setName] = useState(`${vault.name} v2`);
  const [recoveryOffset, setRecoveryOffset] = useState<number | null>(null);
  const [inheritanceOffset, setInheritanceOffset] = useState<number | null>(null);
  const [protectorOffset, setProtectorOffset] = useState<number | null>(null);

  useEffect(() => {
    if (tip == null) return;
    if (recoveryOffset == null) setRecoveryOffset(offsetFromAbs(vault.recovery_after));
    if (inheritanceOffset == null) setInheritanceOffset(offsetFromAbs(vault.inheritance_after));
    if (protectorOffset == null) setProtectorOffset(offsetFromAbs(vault.protector_after));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip]);

  const hasInheritance = vault.inheritance_after > 0 || vault.recovery_after > 0;
  const hasProtector = (vault.protector_after ?? 0) > 0;

  async function rotate() {
    setBusy(true);
    try {
      const res = await api.vaults.rotate({
        vault_id: vault.id,
        overrides: {
          name: name.trim() || undefined,
          recovery_after: hasInheritance ? (recoveryOffset ?? 0) : 0,
          inheritance_after: hasInheritance ? (inheritanceOffset ?? 0) : 0,
          protector_after: hasProtector ? (protectorOffset ?? 0) : 0,
        },
      });
      toast.success("Successor draft created. Compile when ready.");
      onRotated(res.vault);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rotation failed");
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
        zIndex: 100,
        padding: space[4],
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: "24px 28px",
          width: "100%",
          maxWidth: 520,
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, fontFamily: fonts.display, color: colors.text, marginBottom: 6 }}>
          Rotate vault
        </div>
        <div style={{ fontSize: 13, color: colors.muted, lineHeight: 1.5, marginBottom: 16 }}>
          Creates a successor draft that inherits this vault's trust document, members, and shape. Adjust timelocks below if desired. After compiling the successor, sweep funds from this vault to the new address; old and new stay linked in the audit trail.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <Label>New vault name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} />
          </div>
          {hasInheritance && (
            <>
              <div>
                <Label>Recovery timelock (blocks from compile)</Label>
                <Input
                  type="number"
                  min={0}
                  value={recoveryOffset ?? 0}
                  onChange={e => setRecoveryOffset(parseInt(e.target.value) || 0)}
                />
                <div style={{ fontSize: 11, color: colors.muted, marginTop: 3 }}>
                  ~{blocksToLabel(recoveryOffset ?? 0)} at 10-min blocks
                </div>
              </div>
              <div>
                <Label>Inheritance timelock (blocks from compile)</Label>
                <Input
                  type="number"
                  min={0}
                  value={inheritanceOffset ?? 0}
                  onChange={e => setInheritanceOffset(parseInt(e.target.value) || 0)}
                />
                <div style={{ fontSize: 11, color: colors.muted, marginTop: 3 }}>
                  ~{blocksToLabel(inheritanceOffset ?? 0)} at 10-min blocks
                </div>
              </div>
            </>
          )}
          {hasProtector && (
            <div>
              <Label>Protector timelock (blocks from compile)</Label>
              <Input
                type="number"
                min={0}
                value={protectorOffset ?? 0}
                onChange={e => setProtectorOffset(parseInt(e.target.value) || 0)}
              />
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 3 }}>
                ~{blocksToLabel(protectorOffset ?? 0)} at 10-min blocks
              </div>
            </div>
          )}

          <div
            style={{
              padding: "10px 12px",
              background: colors.gold + "0C",
              border: `1px solid ${colors.gold}33`,
              borderRadius: radii.sm,
              fontSize: 12,
              color: colors.sub,
              lineHeight: 1.5,
              marginTop: 4,
            }}
          >
            Members and trust document carry forward. If you need to rotate keys or change membership, open the Members tab on the successor draft before compiling.
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={() => void rotate()} disabled={busy}>
              {busy ? "Rotating..." : "Create successor draft"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DraftReadinessCard({
  vault,
  onOpenTab,
}: {
  vault: Vault;
  onOpenTab: (id: string) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [invites, setInvites] = useState<VaultInvite[]>([]);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<{ user: { id: string } } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session as unknown as { user: { id: string } });
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const [m, inv] = await Promise.all([
        api.members.list(vault.id),
        api.invites.list(vault.id),
      ]);
      setMembers(m.members);
      setInvites(inv.invites.filter(i => !i.claimed_at));
    } catch {
      /* best-effort */
    }
  }, [vault.id]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeRefresh({ table: "vault_members", filter: `vault_id=eq.${vault.id}` }, () => void load());
  useRealtimeRefresh({ table: "vault_invites", filter: `vault_id=eq.${vault.id}` }, () => void load());

  const isOwner = session?.user.id === vault.user_id;
  const ready = members.filter(m => m.xpub && m.fingerprint && m.pubkey && m.derivation_path);
  const foundersReady = ready.filter(m => m.role === "founder" || m.role === "owner").length;
  const heirsReady = ready.filter(m => m.role === "heir").length;
  const plannedF = vault.planned_founder_count ?? 0;
  const plannedH = vault.planned_heir_count ?? 0;
  const totalPlanned = plannedF + plannedH;
  const totalReady = foundersReady + heirsReady;
  const slotsFilled = foundersReady >= plannedF && heirsReady >= plannedH;
  const pctFilled = totalPlanned > 0 ? Math.min(100, Math.round((totalReady / totalPlanned) * 100)) : 0;

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

  async function copyInviteLink(token: string) {
    const url = `${window.location.origin}/invite?token=${token}`;
    await navigator.clipboard.writeText(url);
    setCopied(token);
    setTimeout(() => setCopied(null), 1600);
  }

  function copyTrustCode(token: string) {
    navigator.clipboard.writeText(token);
    setCopied(token + "-code");
    setTimeout(() => setCopied(null), 1600);
  }

  // Build a unified "slot" list: claimed members first, then
  // outstanding invites, grouped by role.
  type Slot = {
    key: string;
    role: string;
    label: string;
    status: "claimed" | "pending";
    fingerprint?: string | null;
    invite?: VaultInvite;
  };
  const slots: Slot[] = [];
  for (const m of members) {
    const isReady = Boolean(m.xpub && m.fingerprint && m.pubkey && m.derivation_path);
    slots.push({
      key: m.id,
      role: m.role,
      label: m.label || "(unlabeled)",
      status: isReady ? "claimed" : "pending",
      fingerprint: m.fingerprint,
    });
  }
  for (const inv of invites) {
    slots.push({
      key: inv.id,
      role: inv.invited_role,
      label: inv.invited_label || inv.invited_email || "(unlabeled)",
      status: "pending",
      invite: inv,
    });
  }

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${slotsFilled ? colors.green : colors.gold}`,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: slotsFilled ? colors.green : colors.gold,
            textTransform: "uppercase",
            marginBottom: 4,
          }}
        >
          {slotsFilled ? "Ready to compile" : "Draft -- waiting on members"}
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>
          {totalReady} of {totalPlanned} members joined
        </div>
      </div>

      <div
        style={{
          height: 6,
          background: colors.border,
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pctFilled}%`,
            height: "100%",
            background: slotsFilled ? colors.green : colors.gold,
            transition: "width 300ms",
          }}
        />
      </div>

      <div
        style={{
          padding: "10px 12px",
          background: colors.gold + "0C",
          border: `1px solid ${colors.gold}33`,
          borderRadius: radii.sm,
          fontSize: 12,
          color: colors.sub,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: colors.gold }}>One-shot compile.</strong> Every
        member's key is baked into the vault address at compile time. Add
        everyone first -- once compiled, the address is permanent. You can
        rotate to a new vault later without losing the trust document or
        history, but this specific vault's address cannot accept new members.
      </div>

      {slots.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {slots.map(s => (
            <div
              key={s.key}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 10px",
                border: `1px solid ${colors.border}`,
                borderRadius: radii.sm,
                background: s.status === "claimed" ? colors.green + "0C" : "transparent",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: colors.text, fontWeight: 500 }}>
                  {s.label}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      color: colors.muted,
                      marginLeft: 8,
                      textTransform: "uppercase",
                    }}
                  >
                    {s.role}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: colors.muted, fontFamily: fonts.mono, marginTop: 2 }}>
                  {s.status === "claimed"
                    ? `claimed . ${s.fingerprint || "fp missing"}`
                    : "pending"}
                </div>
              </div>
              {s.status === "pending" && s.invite && isOwner && (
                <div style={{ display: "flex", gap: 4 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{ fontSize: 11, padding: "4px 8px" }}
                    onClick={() => void copyInviteLink(s.invite!.token)}
                  >
                    {copied === s.invite.token ? "Copied" : "Copy link"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{ fontSize: 11, padding: "4px 8px" }}
                    onClick={() => copyTrustCode(s.invite!.token)}
                  >
                    {copied === s.invite.token + "-code" ? "Copied" : "Copy code"}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {isOwner && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            onClick={() => void compile()}
            disabled={!slotsFilled || busy}
            style={{
              flex: 1,
              padding: "12px",
              background: slotsFilled ? colors.green : undefined,
            }}
          >
            {busy
              ? "Compiling..."
              : slotsFilled
                ? "Compile vault"
                : `Waiting on ${totalPlanned - totalReady} more member${totalPlanned - totalReady === 1 ? "" : "s"}`}
          </Button>
          {!slotsFilled && (
            <Button
              variant="ghost"
              style={{ padding: "12px 14px" }}
              onClick={() => onOpenTab("members")}
            >
              Manage invites
            </Button>
          )}
        </div>
      )}

      {!isOwner && !slotsFilled && (
        <div style={{ fontSize: 12, color: colors.muted, textAlign: "center" }}>
          The primary trustee compiles the vault once every member has joined.
        </div>
      )}
    </div>
  );
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

// // -- ActionGuide
// Role-aware "today's actions" strip at the top of the vault
// overview. Distills what's on the caller's plate into one concrete
// CTA per row so a trustee doesn't have to scan proposals +
// requests + stipends tabs to find out there's work pending.
//
// Data sources: proposals passed down from VaultDetailInner;
// stipends + requests fetched locally (small per-vault lists).
// Timelock countdowns computed against the stored absolute CLTV
// heights (tip from mempool.space via lib/chain.ts).

interface ActionItem {
  key: string;
  label: string;
  detail: string;
  cta: string;
  severity: "warn" | "info" | "danger";
  onClick: () => void;
}

function ActionGuide({
  vault,
  proposals,
  onOpenTab,
  onSendPrefill,
}: {
  vault: Vault;
  proposals: Proposal[];
  onOpenTab: (id: string) => void;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  const [stipends, setStipends] = useState<ScheduledStipend[]>([]);
  const [requests, setRequests] = useState<VaultRequest[]>([]);
  const [tip, setTip] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.stipends
      .list(vault.id)
      .then(r => !cancelled && setStipends(r.stipends))
      .catch(() => {});
    api.vaultRequests
      .list(vault.id)
      .then(r => !cancelled && setRequests(r.requests))
      .catch(() => {});
    if (vault.network) {
      tipHeight(vault.network)
        .then(h => !cancelled && setTip(h))
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [vault.id, vault.network]);

  const role = (vault as Vault & { my_role?: string }).my_role;
  const isTrustee = role === "owner" || role === "founder";
  const isBeneficiary = role === "beneficiary";
  const isHeir = role === "heir";
  const isProtector = role === "protector";

  const now = Date.now();
  const overdueStipends = stipends.filter(
    s => s.active && new Date(s.next_due_at).getTime() <= now,
  );
  const pendingRequests = requests.filter(r => r.status === "pending");
  const pendingProposals = proposals.filter(
    p => p.status !== "broadcast" && p.status !== "cancelled",
  );

  const blocksLeftToUnlock = (abs: number | null | undefined) => {
    if (!abs || abs <= 0 || tip == null) return null;
    return Math.max(0, abs - tip);
  };
  const approachingDays = 60 * 24 * 6; // ~60 days in blocks
  const recoveryLeft = blocksLeftToUnlock(vault.recovery_after);
  const inheritanceLeft = blocksLeftToUnlock(vault.inheritance_after);
  const protectorLeft = blocksLeftToUnlock(vault.protector_after);

  const items: ActionItem[] = [];

  if (isTrustee) {
    if (pendingProposals.length > 0) {
      items.push({
        key: "trustee-sign",
        label: `${pendingProposals.length} proposal${pendingProposals.length === 1 ? "" : "s"} awaiting signatures`,
        detail: "Open the signing queue and add your signature.",
        cta: "Go to Send",
        severity: "warn",
        onClick: () => onOpenTab("send"),
      });
    }
    if (pendingRequests.length > 0) {
      items.push({
        key: "trustee-requests",
        label: `${pendingRequests.length} distribution request${pendingRequests.length === 1 ? "" : "s"} pending review`,
        detail: "A beneficiary has asked for funds. Approve, deny, or ask for more info.",
        cta: "Review requests",
        severity: "warn",
        onClick: () => onOpenTab("requests"),
      });
    }
    if (overdueStipends.length > 0) {
      const first = overdueStipends[0];
      items.push({
        key: "trustee-stipends",
        label: `${overdueStipends.length} stipend${overdueStipends.length === 1 ? " is" : "s are"} overdue`,
        detail: `Next: "${first.name}" for ${satsToBtc(first.amount_sats)} BTC.`,
        cta: "Send now",
        severity: "warn",
        onClick: () =>
          onSendPrefill({
            stipend_id: first.id,
            stipend_interval: first.interval_kind,
            destination: first.destination ?? undefined,
            amount_sats: first.amount_sats,
            rule_id: first.rule_id,
            memo: `Stipend: ${first.name}`,
            name: first.name,
          }),
      });
    }
    if (recoveryLeft != null && recoveryLeft > 0 && recoveryLeft <= approachingDays) {
      items.push({
        key: "trustee-recovery",
        label: `Recovery path unlocks in ${blocksToLabel(recoveryLeft)}`,
        detail: "Once unlocked, trustees can spend at reduced quorum. Ensure the vault is still staffed.",
        cta: "Review members",
        severity: "info",
        onClick: () => onOpenTab("members"),
      });
    }
  }

  if (isBeneficiary) {
    const mine = stipends.filter(s => s.active);
    if (mine.length > 0) {
      const nextDue = [...mine].sort(
        (a, b) => new Date(a.next_due_at).getTime() - new Date(b.next_due_at).getTime(),
      )[0];
      const days = Math.ceil(
        (new Date(nextDue.next_due_at).getTime() - now) / (1000 * 60 * 60 * 24),
      );
      items.push({
        key: "beneficiary-stipend",
        label: days <= 0
          ? `Your stipend "${nextDue.name}" is due now`
          : `Your next stipend in ${days} day${days === 1 ? "" : "s"}`,
        detail: `${satsToBtc(nextDue.amount_sats)} BTC, every ${nextDue.interval_kind}.`,
        cta: "See schedule",
        severity: days <= 0 ? "warn" : "info",
        onClick: () => onOpenTab("overview"),
      });
    }
    if (pendingRequests.length === 0) {
      items.push({
        key: "beneficiary-request",
        label: "Need funds?",
        detail: "File a distribution request -- trustees will review it against the trust doc.",
        cta: "File request",
        severity: "info",
        onClick: () => onOpenTab("requests"),
      });
    }
  }

  if (isHeir && inheritanceLeft != null && inheritanceLeft > 0) {
    items.push({
      key: "heir-countdown",
      label: `Inheritance path unlocks in ${blocksToLabel(inheritanceLeft)}`,
      detail:
        inheritanceLeft <= approachingDays
          ? "Your window is approaching. Confirm your successor keys are backed up."
          : "You will be able to spend after the window without the original trustees.",
      cta: "Review your key",
      severity: inheritanceLeft <= approachingDays ? "warn" : "info",
      onClick: () => onOpenTab("members"),
    });
  }

  if (isProtector && protectorLeft != null && protectorLeft > 0) {
    items.push({
      key: "protector-countdown",
      label: `Protector path unlocks in ${blocksToLabel(protectorLeft)}`,
      detail:
        protectorLeft <= approachingDays
          ? "Your window is approaching. Prepare a replacement vault so you can sweep quickly if trustees go dark."
          : "Watch the activity log for anything unusual. You'll gain spend authority when this clock expires.",
      cta: "Activity log",
      severity: protectorLeft <= approachingDays ? "warn" : "info",
      onClick: () => onOpenTab("activity"),
    });
  }

  if (items.length === 0) return null;

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
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
        Today
      </div>
      {items.map(it => {
        const accent = it.severity === "danger"
          ? colors.red
          : it.severity === "warn"
            ? colors.orange
            : colors.gold;
        return (
          <div
            key={it.key}
            style={{
              borderLeft: `3px solid ${accent}`,
              background: accent + "0C",
              borderRadius: radii.sm,
              padding: "10px 12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
                {it.label}
              </div>
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>
                {it.detail}
              </div>
            </div>
            <Button size="sm" style={{ fontSize: 11, padding: "5px 10px" }} onClick={it.onClick}>
              {it.cta}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// Per-role plain-English context that pairs with the global
// VaultPhaseCard. Tells each member what THEIR role can do at the
// current phase + what to expect, so beneficiaries don't pester
// trustees for spends that aren't allowed and protectors know
// exactly when their power activates.
function rolePhaseHint(
  vault: Vault,
  tip: number | null,
): { lines: string[]; cta?: string } {
  const role = (vault as Vault & { my_role?: string }).my_role;
  const t = tip ?? 0;
  const recoveryOpen = vault.recovery_after > 0 && t >= vault.recovery_after;
  const protectorOpen = (vault.protector_after ?? 0) > 0 && t >= (vault.protector_after ?? 0);
  const inheritanceOpen = vault.inheritance_after > 0 && t >= vault.inheritance_after;

  const lines: string[] = [];
  let cta: string | undefined;

  if (role === "owner" || role === "founder") {
    lines.push(
      `You can co-sign normal spends today (${vault.founder_quorum} of ${vault.founder_keys.length} required).`,
    );
    if (vault.consent_quorum) {
      lines.push("Reminder: every Path 1 spend also needs beneficiary consent.");
    }
    if (!recoveryOpen && vault.recovery_after > 0 && tip != null) {
      lines.push(
        `If trustees go silent ${blocksToLabel(vault.recovery_after - t)}, the recovery path opens.`,
      );
    } else if (recoveryOpen && vault.recovery_quorum != null && vault.recovery_quorum < vault.founder_quorum) {
      lines.push(`Recovery is OPEN: ${vault.recovery_quorum} of ${vault.founder_keys.length} can sign.`);
    }
  } else if (role === "heir") {
    if (inheritanceOpen) {
      lines.push(
        `Inheritance is OPEN. ${vault.heir_quorum} of ${vault.heir_keys.length} successors can spend without the trustees.`,
      );
      cta = "Coordinate with the other successors to sweep funds to a fresh vault you control.";
    } else if (tip != null) {
      const blocksLeft = vault.inheritance_after - t;
      lines.push(`Your inheritance path unlocks in ${blocksToLabel(blocksLeft)} (block ${vault.inheritance_after.toLocaleString()}).`);
      lines.push("Until then, only the trustees can spend. Keep your seed backed up.");
    }
  } else if (role === "protector") {
    if (protectorOpen) {
      lines.push("Your protector path is OPEN. Sweep funds to a fresh vault if trustees have gone rogue.");
      cta = "Build a replacement vault first, then sweep.";
    } else if ((vault.protector_after ?? 0) > 0 && tip != null) {
      const blocksLeft = (vault.protector_after ?? 0) - t;
      lines.push(`Your rescue path unlocks in ${blocksToLabel(blocksLeft)} (block ${(vault.protector_after ?? 0).toLocaleString()}).`);
      lines.push("Watch the activity log. Step in only if trustees act in bad faith.");
    }
  } else if (role === "beneficiary") {
    if (vault.consent_quorum) {
      lines.push("Trustees CANNOT spend on the normal path without your signature.");
      lines.push("If a proposal looks wrong, refuse to sign -- the timelocked recovery path won't help them for months.");
    } else {
      lines.push("Trustees handle distributions on your behalf.");
      lines.push("File a distribution request when you need funds; trustees review against the trust doc.");
      cta = "File a request from the Requests tab.";
    }
  } else if (role === "viewer") {
    lines.push("You have read-only visibility. No signing authority.");
  }

  return { lines, cta };
}

// // -- VaultPhaseCard
// Plain-English summary of what's spendable RIGHT NOW on the
// vault. Complements TimelockCountdown (which shows per-path
// countdowns) with a single "trust phase" banner that a
// non-technical beneficiary can read. Refreshes every minute so
// an imminent unlock flips the banner without a manual reload.

type VaultPhase = {
  label: string;
  description: string;
  accent: string;
  paths: string[];
};

function computePhase(vault: Vault, tip: number | null): VaultPhase {
  if (tip == null) {
    return {
      label: "Loading...",
      description: "Waiting for chain tip.",
      accent: colors.muted,
      paths: [],
    };
  }
  const paths: string[] = ["Trustees (Path 1) - anytime"];
  let accent: string = colors.gold;
  let label = "Normal operation";
  let description =
    `${vault.founder_quorum} of ${vault.founder_keys.length} trustees can sign at any time.`;

  const inheritance = vault.inheritance_after ?? 0;
  const recovery = vault.recovery_after ?? 0;
  const protector = vault.protector_after ?? 0;

  if (inheritance > 0 && tip >= inheritance) {
    label = "Inheritance triggered";
    description = `After block ${inheritance.toLocaleString()}, heirs can spend without the trustees.`;
    accent = colors.green;
    paths.push(`Heirs (Path 3) - ${vault.heir_quorum} of ${vault.heir_keys.length}`);
  } else if (protector > 0 && tip >= protector) {
    label = "Protector window open";
    description = `After block ${protector.toLocaleString()}, the protector can rescue funds to a fresh vault.`;
    accent = colors.blue;
    paths.push(`Protector (Path 4) - ${vault.protector_quorum} of ${vault.protector_keys.length}`);
  } else if (recovery > 0 && tip >= recovery) {
    label = "Recovery window open";
    description =
      vault.recovery_quorum != null && vault.recovery_quorum !== vault.founder_quorum
        ? `After block ${recovery.toLocaleString()}, trustees can spend with a reduced quorum of ${vault.recovery_quorum}.`
        : `After block ${recovery.toLocaleString()}, the recovery path is available (same quorum as normal).`;
    accent = colors.blue;
    paths.push(`Recovery (Path 2) - ${vault.recovery_quorum ?? vault.founder_quorum} of ${vault.founder_keys.length}`);
  }

  // Always surface the next upcoming unlock so the phase card
  // tells a forward-looking story, not just the current state.
  const upcoming: { name: string; block: number }[] = [];
  if (recovery > tip) upcoming.push({ name: "Recovery", block: recovery });
  if (protector > tip && vault.protector_keys.length > 0) upcoming.push({ name: "Protector", block: protector });
  if (inheritance > tip) upcoming.push({ name: "Inheritance", block: inheritance });
  if (upcoming.length > 0) {
    const next = upcoming.sort((a, b) => a.block - b.block)[0];
    const blocksLeft = next.block - tip;
    const approx = blocksToLabel(blocksLeft);
    paths.push(`Next unlock: ${next.name} in ${approx} (block ${next.block.toLocaleString()})`);
  }

  return { label, description, accent, paths };
}

function VaultPhaseCard({ vault }: { vault: Vault }) {
  const [tip, setTip] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetchTip = () => {
      tipHeight(vault.network)
        .then(h => !cancelled && setTip(h))
        .catch(() => {});
    };
    fetchTip();
    const iv = window.setInterval(fetchTip, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [vault.network]);

  const phase = computePhase(vault, tip);
  const roleHint = rolePhaseHint(vault, tip);

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${phase.accent}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: phase.accent,
            textTransform: "uppercase",
          }}
        >
          {phase.label}
        </span>
        {tip != null && (
          <span style={{ fontSize: 11, color: colors.muted, fontFamily: fonts.mono }}>
            tip {tip.toLocaleString()}
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5, marginBottom: 8 }}>
        {phase.description}
      </div>
      {phase.paths.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: colors.sub, lineHeight: 1.7 }}>
          {phase.paths.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
      {roleHint.lines.length > 0 && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: `1px solid ${colors.border}`,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.1em",
              color: colors.muted,
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            Your role
          </div>
          {roleHint.lines.map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: colors.sub, lineHeight: 1.5 }}>
              {l}
            </div>
          ))}
          {roleHint.cta && (
            <div style={{ fontSize: 12, color: phase.accent, marginTop: 6, fontWeight: 600 }}>
              {roleHint.cta}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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

  // vault.recovery_after / inheritance_after are ABSOLUTE CLTV
  // block heights (baked into the Taproot leaf's `after(N)`).
  // Subtract the current tip to get the relative blocks-until-
  // unlock for display.
  const rows = [
    { label: "Recovery", absHeight: vault.recovery_after, color: colors.blue },
    { label: "Inheritance", absHeight: vault.inheritance_after, color: colors.green },
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
        const blocksLeft = tip != null ? Math.max(0, r.absHeight - tip) : r.absHeight;
        const unlocksAt = approxWallclockDate(blocksLeft);
        const unlocksLabel = blocksLeft === 0 && tip != null
          ? "Unlocked"
          : blocksToApproxLabel(blocksLeft);
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
                  ? `tip ${tip.toLocaleString()} / unlocks at block ${r.absHeight.toLocaleString()}`
                  : `unlocks at block ${r.absHeight.toLocaleString()}`}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, color: r.color, fontWeight: 600 }}>
                {unlocksLabel}
              </div>
              <div style={{ fontSize: 11, color: colors.muted }}>
                {blocksLeft > 0 ? unlocksAt.toLocaleDateString() : ""}
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
  const askPrompt = usePrompt();
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
                void (async () => {
                  const note = (await askPrompt({
                    title: "Decline request",
                    message: "Add a reason for declining (optional). The requester will see this.",
                    placeholder: "Reason (optional)",
                    confirmLabel: "Decline",
                  })) ?? undefined;
                  await resolve(r, "declined", note);
                })();
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
