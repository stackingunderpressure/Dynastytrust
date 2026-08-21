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
  type BlocPolicy,
} from "../lib/api";
import { supabase } from "../lib/supabase";
import { listKeys, revealMnemonic, type LocalKey } from "../lib/keystore";
import { keyNetworkMatches } from "../lib/network";
import { signPsbtWithMnemonic, countSignatures, mergePsbts, verifyPsbtMatchesRequest } from "../lib/psbt-signer";
import { fetchTapitDisplayNames } from "../lib/tapit-profile-lookup";
import { assembleLivenessGateInput } from "../lib/liveness-gate";
import { evaluateSigningGate, ceremonyFromProposal } from "@dynastytrust/policy-engine";
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
import { downloadVault, downloadDistributionWalletBackup } from "../lib/descriptor-backup";
import { DescriptorQr } from "../components/DescriptorQr";
import { pubkeyFromXpub, fingerprintFromXpub } from "../lib/xpub";
import { buildPsbtKeyOrigins } from "../lib/descriptor-keys";
import { sha256 } from "@noble/hashes/sha256";
import { blocDecayLadder } from "../lib/blocks";
import { BehaviorTimeline, type SpendLeg, selectStyle } from "../components/vault-builder";

function toHexBytes(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Stable binding identity for a PSBT's hex, mirroring BlocBuilder.tsx's
// psbtBindingHash. Only meaningful compared against ANOTHER hash of the
// exact same pristine, pre-signature hex -- see signWithKey's comment on
// why it is only checked against the first signature in a session.
function psbtBindingHash(psbtHex: string): string {
  return toHexBytes(sha256(new TextEncoder().encode(psbtHex)));
}
import { ensureMessagingKey, encryptMessage, decryptMessage, getMessagingPubkey } from "../lib/messaging";
import { TrustTab } from "../components/TrustTab";
import { RemindersBanner } from "../components/RemindersBanner";
import { HaltVaultBar } from "../components/HaltVaultBar";
import { CirclePhraseSetup } from "../components/CirclePhraseSetup";
import { SentSecretsPanel } from "../components/SentSecretsPanel";
import { VaultMembershipSetup } from "../components/VaultMembershipSetup";
import { NotifyCircleViaNostr } from "../components/NotifyCircleViaNostr";
import { MessagingKeyBackupPanel } from "../components/MessagingKeyBackupPanel";
import { tipHeight, txConfirmations, blocksToApproxLabel } from "../lib/chain";
import { buildStandardTrustDoc, standardConfigFromCompiledVault } from "../lib/trust-doc";


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

// Best-effort trust-doc auto-fill for a draft compiled from VaultDetail
// itself (DraftReadinessCard / DraftCompileButton below) -- members
// brought their own keys via invite, so this never passes through
// VaultWizard.tsx's own runCompile, which has the identical hook for the
// wizard's own compile path (lib/trust-doc.ts's buildStandardTrustDoc
// generates the same content either way). Never overwrites a doc the
// owner already started writing before compiling; a failed save never
// blocks navigating to the now-successfully-compiled vault.
function autofillTrustDocIfEmpty(preCompile: Vault, compiled: Vault) {
  const d = preCompile.trust_doc;
  const alreadyHasContent =
    !!d && (!!d.purpose || !!d.distribution_rules || !!d.succession_notes || !!(d.beneficiaries ?? []).length);
  if (alreadyHasContent) return;
  tipHeight(compiled.network)
    .catch(() => null)
    .then(tip => api.vaults.updateTrustDoc(
      compiled.id,
      buildStandardTrustDoc({ vaultName: compiled.name, config: standardConfigFromCompiledVault(compiled, tip) }),
    ))
    .catch(() => {});
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
  // The plain, one-tap "halt signing" control (2026-08-08 phone-callback
  // follow-up). null = no toggle made this session, read straight off
  // `vault.duress`; once toggled, holds the fresh value so the banner and
  // the signing gate both reflect it immediately without a full reload.
  const [duressOverride, setDuressOverride] = useState<boolean | null>(null);
  const effectiveDuress = duressOverride ?? vault.duress;
  const [duressBusy, setDuressBusy] = useState(false);

  async function toggleDuress(next: boolean) {
    setDuressBusy(true);
    try {
      await api.vaults.setDuress(vault.id, next);
      setDuressOverride(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update halt state");
    } finally {
      setDuressBusy(false);
    }
  }

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
    ["founder", "heir"].includes(myMember.role) &&
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

      <main className="dt-page-main dt-page-main--narrow" style={{ paddingBottom: 64 }}>
        {vault.status === "compiled" && (
          <div style={{ marginBottom: 16 }}>
            <HaltVaultBar duress={effectiveDuress} busy={duressBusy} onToggle={toggleDuress} />
          </div>
        )}
        {vault.status === "compiled" && (
          <CirclePhraseSetup
            vaultId={vault.id}
            vaultDescriptor={vault.descriptor}
            vaultName={vault.name}
            founderKeys={vault.founder_keys}
          />
        )}
        {vault.status === "compiled" && <SentSecretsPanel vaultId={vault.id} />}
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
          {vault.address && (
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 10, lineHeight: 1.5 }}>
              This vault has one fixed address, reused for every deposit --
              anyone who sees one payment to it can see every payment to it
              and the eventual full spend. That's the tradeoff for hardware-
              wallet compatibility; keep that in mind for how you fund it.
            </div>
          )}
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
            vault={duressOverride === null ? vault : { ...vault, duress: duressOverride }}
            balance={balance}
            prefill={sendPrefill}
            onDone={() => { setSendPrefill(null); void load(); setTab("history"); }}
          />
        )}
        {tab === "history" && (
          <HistoryTab vault={vault} proposals={proposals} onRefresh={load} />
        )}
        {tab === "members" && <MembersTab vault={vault} />}
        {tab === "activity" && (
          <ActivityTab vault={vault} onOpenTab={id => setTab(id as typeof tab)} />
        )}
        {tab === "requests" && <RequestsTab vault={vault} onSendPrefill={prefillSend} />}
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
  const navigate = useNavigate();
  const isBloc = vault.bloc_policy != null;

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
    // Bloc vaults render their own overview (BlocOverviewTab, below)
    // which fetches its own tip -- skip the redundant fetch here.
    if (plain || isBloc) return;
    let cancelled = false;
    tipHeight(vault.network)
      .then(h => !cancelled && setChainTip(h))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [plain, isBloc, vault.network]);

  // Dynasty Bloc vaults don't use the founders/heirs/recovery/inheritance
  // shape at all -- everything below this point (paths, VaultPhaseCard,
  // VaultStructureTree, SuccessionBanner, ActionGuide, StipendsSection)
  // assumes that shape and would render nonsense (0-of-0 quorums, a
  // "recovery unlocks at block 0" countdown) against a Bloc vault's empty
  // founder_keys/heir_keys. Isolating Bloc into its own small overview
  // rather than threading bloc_policy checks through all of those --
  // narrower blast radius, zero regression risk to the standard-vault
  // overview that's already shipped and working. Declared after every
  // hook in this component so the early return never changes hook order
  // (react-hooks/rules-of-hooks).
  if (vault.bloc_policy) {
    return <BlocOverviewTab vault={vault} copy={copy} copied={copied} onSendPrefill={onSendPrefill} />;
  }

  const blocksFromNow = (abs: number | null | undefined) => {
    if (!abs || abs <= 0) return 0;
    if (chainTip == null) return abs; // fall back while tip is loading
    return Math.max(0, abs - chainTip);
  };

  // "Gift Locker"-shaped vaults (recovery_after === 0 but heirs +
  // inheritance_after ARE set -- see DynastyPolicy::has_recovery() in
  // protocol/src/policy_compiler.rs) have no recovery leaf at all.
  // `plain` alone can't detect this shape (it requires heir_keys empty
  // too), so the Recovery path entry needs its own explicit gate --
  // showing it here would describe a spending path that doesn't exist
  // in this vault's actual descriptor.
  const hasRecoveryPath = !plain && vault.recovery_after > 0;
  // Mirrors hasRecoveryPath's own guard -- a vault with zero heir keys has
  // no inheritance leaf in the compiled descriptor at all (see PATH 1-only
  // taproot trees like Gift Locker/emergency-backup shapes). Without this,
  // the details table below unconditionally showed "Successor quorum: 1 of
  // 0" and "Inheritance: unlocks at block 0" for a vault that structurally
  // has no second leaf -- reading as "already unlocked" for a path that
  // was never compiled, not as "not configured."
  const hasInheritancePath = (vault.heir_keys?.length ?? 0) > 0;

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
        ...(hasRecoveryPath
          ? [
              {
                num: 2,
                color: colors.blue,
                title: "Recovery - " + blocksToLabel(blocksFromNow(vault.recovery_after)),
                body:
                  vault.recovery_quorum != null && vault.recovery_quorum !== vault.founder_quorum
                    ? `${vault.recovery_quorum} of ${vault.founder_keys.length} trustee signatures after ${blocksFromNow(vault.recovery_after).toLocaleString()} blocks. Insurance against a lost device: quorum drops below the normal ${vault.founder_quorum}-of-${vault.founder_keys.length} so trustees can still spend if one key is gone.`
                    : `Trustees can recover after ${blocksFromNow(vault.recovery_after).toLocaleString()} blocks. Note: the recovery quorum matches the normal quorum, so this path grants no extra capability.`,
              },
            ]
          : []),
        {
          num: 3,
          color: colors.green,
          title: "Inheritance - " + blocksToLabel(blocksFromNow(vault.inheritance_after)),
          body: `${vault.heir_quorum} of ${vault.heir_keys.length} successor signatures after ${blocksFromNow(vault.inheritance_after).toLocaleString()} blocks. Triggered only if the trustees are unreachable for the full window.`,
        },
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
      {!plain && <VaultStructureTree vault={vault} />}
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
          ...(hasInheritancePath
            ? [["Successor quorum", `${vault.heir_quorum} of ${vault.heir_keys.length}`]]
            : []),
          ...(hasRecoveryPath
            ? [["Recovery", `unlocks at block ${vault.recovery_after.toLocaleString()} (${blocksToLabel(blocksFromNow(vault.recovery_after))})`]]
            : []),
          ...(hasInheritancePath
            ? [["Inheritance", `unlocks at block ${vault.inheritance_after.toLocaleString()} (${blocksToLabel(blocksFromNow(vault.inheritance_after))})`]]
            : []),
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
        <div style={{ marginBottom: 8 }}>
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
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-start", marginBottom: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11, whiteSpace: "normal" }}
              disabled={!vault.descriptor}
              onClick={() => vault.descriptor && copy(vault.descriptor, "desc")}
            >
              {copied === "desc" ? "Copied" : "Copy descriptor"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11, whiteSpace: "normal" }}
              onClick={() => downloadVault(vault)}
            >
              Download backup
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11, whiteSpace: "normal" }}
              disabled={vault.status !== "compiled"}
              onClick={async () => {
                const url = await api.pdfUrl(vault.id);
                window.open(url, "_blank");
              }}
            >
              Download PDF
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11, whiteSpace: "normal" }}
              disabled={!vault.descriptor}
              onClick={() => setShowDescriptorQr(v => !v)}
            >
              {showDescriptorQr ? "Hide QR" : "Show descriptor QR"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11, whiteSpace: "normal" }}
              disabled={!vault.descriptor}
              onClick={() => navigate(`/vaults/${vault.id}/legacy-recovery`)}
            >
              Legacy recovery setup
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 11, whiteSpace: "normal" }}
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
              style={{ padding: "3px 9px", fontSize: 11, whiteSpace: "normal" }}
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
              style={{ padding: "3px 9px", fontSize: 11, whiteSpace: "normal" }}
              onClick={async () => {
                const url = await api.activityExportUrl(vault.id);
                window.open(url, "_blank");
              }}
            >
              Activity JSON
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
        {showDescriptorQr && vault.descriptor && (
          <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
            <DescriptorQr descriptor={vault.descriptor} label="Descriptor QR" size={240} />
          </div>
        )}
      </div>
    </div>
  );
}

// Same rung math as BlocBuilder.tsx's live preview, generalized (via
// blocDecayLadder in lib/blocks.ts) to the persisted, already-absolute
// policy shape. afterBlocks in the returned legs is BLOCKS-FROM-NOW
// (matching BehaviorTimeline's "immediate" / "after X" grouping), not
// the raw absolute CLTV height stored in bloc_policy.
function blocPolicyLegs(bp: BlocPolicy, blocksFromNow: (abs: number) => number): SpendLeg[] {
  const legs: SpendLeg[] = [
    {
      label: "Parents together",
      who: `${bp.parents_together_quorum} of ${bp.parent_pubkeys.length} parents`,
      afterBlocks: 0,
      requiredSigners: bp.parents_together_quorum,
      meaning: "Any normal spend, right away.",
    },
    {
      label: "One parent + the kids",
      who: `${bp.coparent_quorum} parent + ${bp.kids_with_parent_quorum} of ${bp.kid_pubkeys.length} kids`,
      afterBlocks: 0,
      requiredSigners: bp.coparent_quorum + bp.kids_with_parent_quorum,
      meaning: "A parent co-signs with the kids, right away.",
    },
    {
      label: "One parent alone",
      who: `${bp.parent_solo_quorum} of ${bp.parent_pubkeys.length} parents`,
      afterBlocks: blocksFromNow(bp.parent_solo_after),
      requiredSigners: bp.parent_solo_quorum,
      meaning: "Backstop if the other parent is unreachable.",
    },
  ];
  for (const rung of blocDecayLadder(bp)) {
    legs.push({
      label: `Kids alone (${rung.q}-of-${bp.kid_pubkeys.length})`,
      who: `${rung.q} of ${bp.kid_pubkeys.length} kids`,
      afterBlocks: blocksFromNow(rung.absAfter),
      requiredSigners: rung.q,
      meaning: rung.q === 1 ? "Any single kid, alone." : `Any ${rung.q} kids together.`,
      weak: rung.q === 1,
    });
  }
  return legs;
}

// Dynasty Bloc's overview -- isolated from the standard founders/heirs
// overview above (see the bloc_policy branch at the top of OverviewTab).
// Shows the same behavior timeline the wizard previewed at configure
// time, now built from the vault's real, saved policy.
function BlocOverviewTab({
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
  // A Bloc vault still in draft (shape chosen, parent/kid keys not
  // filled in yet) persists bloc_policy as {} -- normalize the array
  // fields here so every .length read below stays safe instead of
  // throwing on the very first render of the overview tab.
  const rawBp = vault.bloc_policy!;
  const bp: BlocPolicy = {
    ...rawBp,
    parent_pubkeys: rawBp.parent_pubkeys ?? [],
    kid_pubkeys: rawBp.kid_pubkeys ?? [],
    parent_xpubs: rawBp.parent_xpubs ?? [],
    kid_xpubs: rawBp.kid_xpubs ?? [],
  };
  const [showDescriptorQr, setShowDescriptorQr] = useState(false);
  const [chainTip, setChainTip] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    tipHeight(vault.network)
      .then(h => !cancelled && setChainTip(h))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [vault.network]);
  const blocksFromNow = (abs: number) => {
    if (!abs || abs <= 0) return 0;
    if (chainTip == null) return abs;
    return Math.max(0, abs - chainTip);
  };
  const legs = blocPolicyLegs(bp, blocksFromNow);
  const floorWarning = bp.kids_decay_floor_quorum === 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <RemindersBanner vaultId={vault.id} />

      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: 16,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: colors.muted, marginBottom: 10 }}>
          HOW THIS VAULT BEHAVES OVER TIME
        </div>
        <BehaviorTimeline legs={legs} floorWarning={floorWarning} kidCount={bp.kid_pubkeys.length} />
      </div>

      {vault.status !== "draft" && <UtxosSection vault={vault} onSendPrefill={onSendPrefill} />}

      {/* Details */}
      <div style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden" }}>
        {[
          ["Address type", vault.address_type.toUpperCase()],
          ["Parents", `${bp.parents_together_quorum} of ${bp.parent_pubkeys.length} together`],
          ["Kids (with a parent)", `${bp.kids_with_parent_quorum} of ${bp.kid_pubkeys.length}`],
          ["One parent alone", `${bp.parent_solo_quorum} of ${bp.parent_pubkeys.length}, unlocks in ${blocksToLabel(blocksFromNow(bp.parent_solo_after))}`],
          ["Kids decay starts", blocksToLabel(blocksFromNow(bp.kids_decay_start_after))],
          ["Kids decay floor", `${bp.kids_decay_floor_quorum} of ${bp.kid_pubkeys.length}`],
        ].map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "11px 16px", borderBottom: `1px solid ${colors.border}` }}>
            <span style={{ fontSize: 13, color: colors.muted }}>{k}</span>
            <span style={{ fontSize: 13, color: colors.text }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Descriptor */}
      <div style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: colors.muted }}>DESCRIPTOR</span>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="ghost" size="sm" style={{ padding: "3px 9px", fontSize: 11 }} disabled={!vault.descriptor} onClick={() => vault.descriptor && copy(vault.descriptor, "desc")}>
              {copied === "desc" ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" size="sm" style={{ padding: "3px 9px", fontSize: 11 }} onClick={() => downloadVault(vault)}>
              Download backup
            </Button>
            <Button variant="ghost" size="sm" style={{ padding: "3px 9px", fontSize: 11 }} disabled={!vault.descriptor} onClick={() => setShowDescriptorQr(v => !v)}>
              {showDescriptorQr ? "Hide QR" : "Show QR"}
            </Button>
          </div>
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.sub, wordBreak: "break-all", lineHeight: 1.6 }}>
          {vault.descriptor}
        </div>
        {showDescriptorQr && vault.descriptor && (
          <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
            <DescriptorQr descriptor={vault.descriptor} label="Descriptor QR" size={240} />
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
  // Set when this send was started from a beneficiary's distribution
  // request (RequestsTab). On successful broadcast the request is
  // marked fulfilled and linked to the resulting proposal so the
  // audit trail closes the loop back to the actual payment.
  request_id?: string;
  // Set when this send is FUNDING a distribution-wallet tranche
  // (DistributionWalletsSection's "Fund" button). On successful
  // broadcast that tranche's funded_txid is patched in.
  distribution_wallet_id?: string;
  tranche_index?: number;
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
  // 2026-08-15 (operator: "did max spend should be no change but there
  // was some back to wallet miscalculation") -- the old "Max" button
  // wrote a GUESSED amount (balance minus a flat 2000-sat fee estimate)
  // into the plain amount field, which then went through the normal
  // fixed-amount build path; whenever the real fee differed from that
  // guess, the leftover became an unrequested change output. sweep
  // instead sends no amount at all -- psbt-binary.js (standard vaults)
  // / psbt-binary-bloc.js (Dynasty Bloc, same-day follow-up: "fix the
  // other ones") compute the exact fee for the real input count first,
  // then derive amount = totalIn - fee server-side, so there is nothing
  // left to become change.
  const [sweep, setSweep] = useState(false);

  // Dynasty Bloc: which of the four spend paths this proposal uses, and
  // (for the decaying kids-alone path) which rung. Ignored entirely for
  // standard vaults, which only ever propose founders_now.
  const bp = vault.bloc_policy;
  const blocLadder = bp ? blocDecayLadder(bp) : [];
  const [blocPath, setBlocPath] = useState<"parents_now" | "coparent_kids" | "parent_solo" | "kids_decay">("parents_now");
  const [blocRungIdx, setBlocRungIdx] = useState(0);

  // Standard (non-Bloc) vault: which leaf this proposal spends through.
  // founders_now is always available; the rest only show up once the
  // vault actually has that leaf configured (psbt-binary.js's
  // leafSignerCounts/leafCountForTree only know how to size these five).
  const hasRecovery = vault.recovery_after > 0;
  const hasInheritance = vault.heir_keys.length > 0 && vault.inheritance_after > 0;
  const hasBackup = vault.backup_keys.length > 0 && vault.backup_quorum != null;
  const hasSecondInheritance =
    vault.second_heir_keys.length > 0 && vault.second_heir_quorum != null && vault.second_inheritance_after != null;
  const [standardPath, setStandardPath] = useState<
    "founders_now" | "recovery" | "inheritance" | "backup" | "second_inheritance"
  >("founders_now");

  const confirmedSats = balance?.confirmed_sats ?? 0;
  const amountSats = Math.round(parseFloat(amountBtc || "0") * 1e8);
  const rules = vault.trust_doc?.rules ?? [];
  const selectedRule = rules.find(r => r.id === ruleId);

  const useSweep = sweep;

  async function buildAndSign(e: React.FormEvent) {
    e.preventDefault();
    if (!useSweep) {
      if (amountSats < 546) { setErr("Minimum 546 sats (dust limit)"); return; }
      if (amountSats > confirmedSats) { setErr("Insufficient confirmed balance"); return; }
    }
    // Enforce the structured trust rule if one is picked or if the
    // trust has rules defined at all (in which case every spend
    // should be categorised).
    if (rules.length > 0 && !selectedRule) {
      setErr("Pick a distribution rule. Every spend on this trust must be categorised.");
      return;
    }
    // Sweep doesn't know the real amount until the backend computes it
    // (totalIn minus the exact fee) -- checked again below, right after
    // psbtRes comes back, using the real number instead of a guess.
    if (!useSweep && selectedRule?.max_sats && amountSats > selectedRule.max_sats) {
      setErr(
        `Amount exceeds the cap on rule "${selectedRule.name}" (max ${satsToBtc(selectedRule.max_sats)} BTC per spend).`,
      );
      return;
    }
    if (selectedRule?.requires_comment && !memo.trim()) {
      setErr(`Rule "${selectedRule.name}" requires a reason. Fill in the memo field.`);
      return;
    }
    // Dynasty Bloc requires a rung quorum when the kids-alone path is
    // chosen -- checked up front so a bad selection never reaches the
    // compiler as a malformed request.
    let blocRungQuorum: number | undefined;
    if (bp && blocPath === "kids_decay") {
      const rung = blocLadder[blocRungIdx];
      if (!rung) { setErr("Pick a kids-alone rung."); return; }
      blocRungQuorum = rung.q;
    }

    setBusy(true); setErr(null); setSlowHint(false);
    const slowTimer = window.setTimeout(() => setSlowHint(true), 1500);

    try {
      // 1. Build PSBT via Fly.io. Dynasty Bloc vaults (bloc_policy set)
      // go through the Bloc-specific endpoint, which knows how to look
      // up the saved policy + key origins from vault_id; every other
      // vault uses the standard founders/heirs endpoint.
      let psbtRes: {
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
      const path: string = bp ? blocPath : standardPath;

      if (bp) {
        const blocRes = await api.psbtBloc({
          vault_id: vault.id,
          destination: dest.trim(),
          ...(useSweep ? { sweep: true } : { amount_sats: amountSats }),
          fee_rate: feeRate ? parseFloat(feeRate) : undefined,
          path: blocPath,
          quorum: blocRungQuorum,
        });
        // psbtBloc's summary omits destination/fee_rate (it doesn't
        // need to echo back what the caller already sent) -- fold the
        // known request-side values in so the rest of this flow (and
        // the signing screen's summary card) can stay shape-agnostic.
        psbtRes = {
          ok: blocRes.ok,
          psbt_hex: blocRes.psbt_hex,
          psbt_b64: blocRes.psbt_b64,
          summary: {
            amount_sats: blocRes.summary.amount_sats,
            fee_sats: blocRes.summary.fee_sats,
            change_sats: blocRes.summary.change_sats,
            fee_rate: feeRate ? parseFloat(feeRate) : 0,
            destination: dest.trim(),
          },
        };
      } else {
        psbtRes = await api.psbt.generate({
          vault_id: vault.id,
          destination: dest.trim(),
          ...(useSweep ? { sweep: true } : { amount_sats: amountSats }),
          fee_rate: feeRate ? parseFloat(feeRate) : undefined,
          path: standardPath,
          selected_utxos: prefill?.selected_utxos,
        }) as typeof psbtRes;
      }

      if (psbtRes.status === "no_utxos") {
        setErr("No confirmed UTXOs. Fund the vault and wait for confirmation.");
        setBusy(false);
        return;
      }

      // Re-derive what the PSBT actually pays from its own bytes before
      // trusting the server's summary text at all -- see
      // verifyPsbtMatchesRequest's doc comment (Kimi K3 scan Family A).
      const psbtCheck = verifyPsbtMatchesRequest(psbtRes.psbt_hex, {
        destination: dest.trim(),
        amountSats: psbtRes.summary.amount_sats,
        network: vault.network,
      });
      if (!psbtCheck.ok) {
        setErr(`Refusing to sign: ${psbtCheck.reason}. This PSBT does not match what you requested -- try again, and contact support if this persists.`);
        setBusy(false);
        return;
      }

      // Sweep only learns the real amount here, once the backend has
      // computed totalIn minus the exact fee -- re-check the rule cap
      // against that real number before ever saving a proposal for it.
      if (useSweep && selectedRule?.max_sats && psbtRes.summary.amount_sats > selectedRule.max_sats) {
        setErr(
          `Sweeping the full balance (${satsToBtc(psbtRes.summary.amount_sats)} BTC) exceeds the cap on rule "${selectedRule.name}" (max ${satsToBtc(selectedRule.max_sats)} BTC per spend). Enter a specific amount under the cap instead.`,
        );
        setBusy(false);
        return;
      }

      // 2. Save proposal. Uses the backend's own summary.amount_sats
      // (the real, post-fee amount) rather than the client's amountSats
      // -- for a sweep those differ by definition (amountSats is 0/blank
      // client-side); for a normal spend the backend already enforces
      // they're identical, so this is never a behavior change there.
      const propRes = await api.proposals.create({
        vault_id: vault.id,
        destination: dest.trim(),
        amount_sats: psbtRes.summary.amount_sats,
        path,
        memo: selectedRule
          ? `Rule: ${selectedRule.name}${memo.trim() ? ` -- ${memo.trim()}` : ""}`
          : memo || undefined,
        psbt_hex: psbtRes.psbt_hex,
        psbt_b64: psbtRes.psbt_b64,
        fee_sats: psbtRes.summary.fee_sats,
      });

      // 3. Find local software keys
      // Only local keys whose /0/0 pubkey actually appears among this
      // vault's eligible signers for the chosen path should be offered
      // as signers. Anything else just adds confusion -- if it's in
      // the keyring but can't help this spend, don't show it. Derive
      // each vault xpub to pubkey hex and intersect with the local
      // keystore.
      // Tapit-origin keys hold no local key material and can never sign
      // in-browser, but they DO need to appear here so NotifyCircleViaNostr
      // (below) can find them and deliver the request to the right
      // person's Tapit inbox -- excluding them left that button with
      // nothing to ever show.
      const allLocalKeys = listKeys().filter(
        k => k.status === "active" && (k.origin === "software" || k.origin === "tapit"),
      );
      const vaultSignerPubkeys = new Set<string>();
      const addKey = (x: string) => {
        if (typeof x !== 'string') return;
        if (x.length === 66) {
          // Legacy rows / Bloc's pubkey lists store pubkey hex directly.
          vaultSignerPubkeys.add(x);
          return;
        }
        try {
          vaultSignerPubkeys.add(pubkeyFromXpub(x));
        } catch {
          /* skip malformed rows */
        }
      };
      let requiredSignatures: number;
      if (bp) {
        // parents_now / parent_solo / kids_decay each draw signers from
        // one side only; coparent_kids draws from both.
        if (blocPath === "parents_now" || blocPath === "parent_solo") {
          bp.parent_pubkeys.forEach(addKey);
        } else if (blocPath === "kids_decay") {
          bp.kid_pubkeys.forEach(addKey);
        } else {
          bp.parent_pubkeys.forEach(addKey);
          bp.kid_pubkeys.forEach(addKey);
        }
        requiredSignatures =
          blocPath === "parents_now" ? bp.parents_together_quorum
          : blocPath === "coparent_kids" ? bp.coparent_quorum + bp.kids_with_parent_quorum
          : blocPath === "parent_solo" ? bp.parent_solo_quorum
          : (blocRungQuorum ?? bp.kids_decay_floor_quorum);
      } else {
        // 2026-08-11 fix (operator: tested a single-key backup leaf with
        // no timelock and the signing screen said "0 of 2 signatures
        // needed" instead of "0 of 1") -- this used to always pull
        // founder_keys/founder_quorum no matter which of the vault's
        // leaves standardPath actually selected, so every non-founders
        // path (recovery, inheritance, backup,
        // second_inheritance) showed the wrong signer set and the wrong
        // required-signature count, even though the PSBT itself (built
        // server-side via api.psbt.generate's own path param) was
        // correctly scoped to the real leaf the whole time -- this was a
        // display/signer-discovery bug only, never a signing-authority
        // bug. founders_now ANDs in beneficiary consent when configured
        // (policy_compiler.rs's founder_thresh: and(trustee_thresh,
        // consent_thresh)) -- both quorums are required, not either/or,
        // so their counts add rather than override.
        switch (standardPath) {
          case "recovery":
            vault.founder_keys.forEach(addKey);
            requiredSignatures = vault.recovery_quorum ?? vault.founder_quorum;
            break;
          case "inheritance":
            vault.heir_keys.forEach(addKey);
            requiredSignatures = vault.heir_quorum;
            break;
          case "backup":
            vault.backup_keys.forEach(addKey);
            requiredSignatures = vault.backup_quorum ?? 0;
            break;
          case "second_inheritance":
            vault.second_heir_keys.forEach(addKey);
            requiredSignatures = vault.second_heir_quorum ?? 0;
            break;
          case "founders_now":
          default:
            vault.founder_keys.forEach(addKey);
            requiredSignatures = vault.founder_quorum;
            if (vault.consent_keys.length > 0 && vault.consent_quorum != null) {
              vault.consent_keys.forEach(addKey);
              requiredSignatures += vault.consent_quorum;
            }
            break;
        }
      }
      // Dedupe by pubkey (keep the first matching LocalKey record) --
      // same fix already applied in tapit-circle-members.ts for the
      // Members/circle-phrase UI (operator, 2026-08-11: "Why two tapit
      // sends for one key?"), needed again here because this Send flow
      // builds its own independent signer list rather than sharing that
      // helper. If the local keystore holds two LocalKey rows pointing
      // at the same real pubkey (e.g. the same Tapit key imported twice
      // under two keyIds), an unfiltered intersection renders two
      // identical "Founder (Tapit)" rows in NotifyCircleViaNostr and
      // sends the same psbt-cosign request twice to the same wallet.
      const seenSignerPubkeys = new Set<string>();
      const signingKeys = allLocalKeys.filter(k => {
        if (!vaultSignerPubkeys.has(k.pubkey)) return false;
        if (seenSignerPubkeys.has(k.pubkey)) return false;
        seenSignerPubkeys.add(k.pubkey);
        return true;
      });

      setSigning({
        psbt_hex: psbtRes.psbt_hex,
        psbt_b64: psbtRes.psbt_b64,
        summary: psbtRes.summary,
        proposal_id: propRes.proposal.id,
        signers: signingKeys.map(key => ({ key, status: "pending" })),
        signaturesCollected: 0,
        requiredSignatures,
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
      // Fail-closed gate: refuse to sign unless this exactly matches an
      // approved, non-duress, live proposal (docs/threat-model-and-fail-
      // closed.md section 4 -- "fail closed everywhere the app has
      // discretion"). Checked before the password prompt so a blocked
      // sign never bothers to ask for a key.
      const { proposals } = await api.proposals.list(vault.id);
      const proposal = signing.proposal_id ? proposals.find(p => p.id === signing.proposal_id) : undefined;
      if (!proposal) {
        throw new Error("could not find the proposal this spend is supposed to match");
      }

      // Liveness axis (2026-08-06): the previously-documented blocker --
      // tapit-attest's OpenTimestampsProvider re-export transitively pulling
      // in a broken `opentimestamps` npm package that failed to resolve under
      // Vite -- no longer reproduces (verified directly: importing
      // assembleLivenessGateInput here and running `npm run build` succeeds
      // cleanly). Node's own module resolution already falls back to
      // `index.js` when a package's declared `main` file is missing, and the
      // installed Vite/Rollup version now does the same. Wired for real: GET
      // the vault's held signals + resolved circle config, then fold them
      // into the gate exactly as liveness-gate.ts's own doc comment
      // prescribes. `config: null` (no liveness circle configured on this
      // vault) is the gate's own documented safe default -- undefined,
      // "not liveness-gated" -- same as before this wire. A FAILED fetch is
      // different from an absent config: we cannot tell whether this vault
      // has a circle we simply failed to see, so per the fail-closed
      // doctrine ("missing a piece -> build nothing",
      // docs/threat-model-and-fail-closed.md section 4) this blocks signing
      // rather than silently bypassing the liveness axis. Duress is still
      // enforced below via vault.duress independent of this.
      let liveness: ReturnType<typeof assembleLivenessGateInput>;
      try {
        const { config, proofs, redFlags } = await api.liveness.get(vault.id);
        // Uses the freshly-fetched proposal's own path (not a hardcoded
        // "founders_now") so this holds for Dynasty Bloc's four spend
        // paths too, not just the standard vault's single normal path.
        liveness = config
          ? assembleLivenessGateInput({ config, path: proposal.path, proofs, redFlags })
          : undefined;
      } catch (e) {
        throw new Error(
          "Could not confirm this vault's liveness status -- refusing to sign until it can be verified: " +
            (e instanceof Error ? e.message : "network error"),
        );
      }

      // Fetch duress fresh from the server immediately before gating,
      // rather than trusting `vault.duress` off React state -- that prop
      // already has `duressOverride` (a purely client-side, optimistic
      // value set locally right after the setDuress call, see line ~204)
      // layered on top of it. A stolen unlocked session (or a malicious
      // co-signer at the victim's own keyboard) could otherwise clear a
      // real halt through the app's own toggle control and sign before
      // the next full page load ever re-synced state from the server.
      // Same fail-closed posture as the liveness fetch just above: a
      // failed fetch blocks signing rather than silently treating it as
      // "not halted" (Kimi K3 scan #142).
      let freshDuress: boolean;
      try {
        const [{ vaults: activeVaults }, { vaults: archivedVaults }] = await Promise.all([
          api.vaults.list(false),
          api.vaults.list(true),
        ]);
        const fresh = [...activeVaults, ...archivedVaults].find(v => v.id === vault.id);
        if (!fresh) throw new Error("Vault not found");
        freshDuress = fresh.duress;
      } catch (e) {
        throw new Error(
          "Could not confirm this vault's duress status -- refusing to sign until it can be verified: " +
            (e instanceof Error ? e.message : "network error"),
        );
      }

      const ceremony = ceremonyFromProposal({
        proposal: {
          proposalId: proposal.id,
          vaultId: vault.id,
          status: proposal.status,
          destination: proposal.destination,
          amountSats: proposal.amount_sats,
          path: proposal.path,
        },
        authorizedPsbtHash: proposal.psbt_hex ? psbtBindingHash(proposal.psbt_hex) : "",
        // No separate per-member approval-vote step exists in this app yet
        // (see docs/integration-phase1-signin-and-bridge.md) -- vault_events'
        // "voted_approve"/"voted_decline" cases exist only as a display
        // label for an event type nothing ever actually writes. A single
        // synthetic voter stands for "the proposal reached a signable
        // status," matching BlocBuilder.tsx's own local-ceremony precedent
        // (approvalsRequired: 1, approvalsCollected: 1) -- this axis is
        // honestly vacuous today (any signable proposal satisfies it),
        // not a real per-member approval gate. Real per-member approval
        // voting is a genuine future improvement, not something this cut
        // regresses -- today's code enforced none of this at all.
        approveVoterIds: ["proposal-exists"],
        approvalsRequired: 1,
        duress: freshDuress,
      });

      // request.destination/amountSats deliberately come from `signing`
      // (the browser's own in-memory record of what was built and shown to
      // the human), NOT from the freshly-fetched proposal used for
      // `ceremony` above -- comparing the two closes the "compromised
      // device shows one destination but signs another" gap (P5 in the
      // threat model doc).
      //
      // The exact-PSBT-hash check is only meaningful against the PRISTINE,
      // never-mutated proposal.psbt_hex: signing.psbt_hex legitimately
      // changes as earlier signatures get merged in across a multi-signer
      // session, so re-hashing it after the first signature would produce
      // a false PSBT_HASH_MISMATCH. Checked strictly only for the first
      // signature in a session; every other check (destination, amount,
      // path, status, duress, liveness) still applies to later signers.
      const requestPsbtHash =
        signing.signaturesCollected === 0 ? psbtBindingHash(signing.psbt_hex) : ceremony.authorizedPsbtHash;

      const gate = evaluateSigningGate({
        request: {
          vaultId: vault.id,
          psbtHash: requestPsbtHash,
          destination: signing.summary.destination,
          amountSats: signing.summary.amount_sats,
          // Matches ceremony.path (also proposal.path) so the gate's
          // own PATH_MISMATCH check passes for any of Dynasty Bloc's
          // spend paths, not just the standard vault's founders_now.
          path: proposal.path,
        },
        ceremony,
        vault: { vaultId: vault.id, address: vault.address ?? "" },
        psbtBindsToVault: true,
        liveness,
      });

      if (!gate.allow) {
        throw new Error("Fail-closed gate blocked signing: " + gate.denials.map(d => d.message).join(" "));
      }

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
  // by the textarea paste flow, the QR scanner, and the Tapit
  // cross-tab handoff (Cut B stage B2) so the merge + signer-session
  // logging only lives in one place. label distinguishes the source
  // in the audit trail without needing a proposal-level column --
  // signers can genuinely mix methods (one via mnemonic, one via
  // Tapit, one via hardware), so per-signature attribution here is
  // the honest place for it, not a single proposals.signing_method.
  function externalImport(importedHex: string, label: string = "Hardware wallet") {
    if (!signing) return;
    const merged = mergePsbts([signing.psbt_hex, importedHex]);
    const totalSigs = countSignatures(merged);
    if (signing.proposal_id) {
      api.signerSessions
        .submit({
          proposal_id: signing.proposal_id,
          psbt_partial_hex: importedHex,
          label,
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

        // Close the loop on a beneficiary's distribution request: it
        // was pending/approved while this proposal was being built,
        // now the payment actually happened, so mark it fulfilled and
        // link it to the proposal that paid it. Non-fatal -- the funds
        // already moved; a failure here is an audit-trail gap to fix
        // later, not a reason to hide the successful broadcast.
        if (prefill?.request_id) {
          try {
            await api.vaultRequests.update(prefill.request_id, {
              status: "fulfilled",
              linked_proposal_id: signing.proposal_id,
            });
          } catch {
            /* non-fatal: broadcast already happened */
          }
        }
      }

      // Close the loop on a distribution-wallet tranche funding: this
      // send originated from the "Fund" button on a specific tranche,
      // so stamp that tranche's funded_txid. Fetch fresh rather than
      // trust a closed-over copy of the wallet, since the whole
      // tranches array must be sent back on PATCH (distribution
      // wallets have no per-tranche update endpoint). Non-fatal for
      // the same reason as the request-fulfillment closure above.
      if (prefill?.distribution_wallet_id && prefill.tranche_index != null) {
        try {
          const { wallets } = await api.distributionWallets.list(vault.id);
          const dw = wallets.find(w => w.id === prefill.distribution_wallet_id);
          if (dw) {
            const tranches = dw.tranches.map(t =>
              t.index === prefill.tranche_index ? { ...t, funded_txid: txid } : t,
            );
            await api.distributionWallets.update(dw.id, { tranches });
          }
        } catch {
          /* non-fatal: broadcast already happened */
        }
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

        {/* Browser keys signing -- Tapit-origin keys hold no local private
            material (importTapitPubkey stores pubkey only, see keystore.ts)
            so they can never actually unlock here; they're excluded from
            this list and only ever offered via "Notify circle via Nostr"
            below, which is what they were always meant for. Filtering by
            index (not a plain .filter()) keeps each row's signWithKey(i)
            call pointed at the right entry in the full signing.signers
            array, which NotifyCircleViaNostr and the quorum progress bar
            above both still read unfiltered. */}
        {signing.signers.some(s => s.key.origin !== "tapit") && (
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
              if (signer.key.origin === "tapit") return null;
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

        {/* "Sign via Tapit" (Cut B stage B2 -- window.open a new tab to
            Tapit's /sign route) is retired from this vault flow: it forced
            a fresh browser tab to re-establish its own Tapit session,
            which read as "trying to log me in" (operator, 2026-08-08).
            NotifyCircleViaNostr below does the same job silently over
            Nostr with no navigation and no second tab. 2026-08-15: the
            Tranche distribution-wallet claim flow (TrancheClaimModal,
            below in this file) hit the identical bug and got the same
            fix -- startTapitCosign/lib/tapit-cosign.ts's window.open
            cross-tab bridge has no remaining caller anywhere in this
            repo as of that fix. */}
        <NotifyCircleViaNostr
          subjectId={signing.proposal_id ?? ""}
          psbtHex={signing.psbt_hex}
          vaultDescriptor={vault.descriptor}
          vaultName={vault.name}
          signers={signing.signers}
          onSigned={(hex, label) => externalImport(hex, label)}
        />

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
            Export this transaction to your signing device, then paste or scan the signed result back here.
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
              {showQrDisplay ? "Hide QR" : "Show QR"}
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
          {prefill.selected_utxos.length > 1 && (
            <div style={{ marginTop: 4, color: colors.muted }}>
              Spending these together publicly links them to the same
              owner forever, even if they arrived separately.
            </div>
          )}
        </div>
      )}
      {(!prefill?.selected_utxos || prefill.selected_utxos.length === 0) && (
        <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5 }}>
          This picks your largest confirmed deposits first. If you are not
          spending the full balance, that may combine several previously-
          separate deposits into one public transaction. Pick specific
          coins under UTXOs below if that matters for this spend.
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
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 5 }}>
              {standardPath === "backup"
                ? "This path has no timelock, but it needs a separate set of keys from the day-to-day founders."
                : standardPath === "second_inheritance"
                  ? "This path is a separate heir group from the main inheritance path, with its own timelock -- only spendable once that timelock has passed."
                  : "This path is only spendable once its timelock has passed -- the compiler will reject the build otherwise."}
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
                fontSize: 14,
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
  // A proposal still waiting on signatures or broadcast is the thing the
  // operator actually needs to act on -- it should never sit buried below
  // old, finished (broadcast/cancelled) history just because those happen
  // to be more recent rows. Active first (newest first within that group),
  // then finished (newest first).
  const sorted = [...proposals].sort((a, b) => {
    const aTerminal = a.status === "broadcast" || a.status === "cancelled";
    const bTerminal = b.status === "broadcast" || b.status === "cancelled";
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {sorted.map(p => (
        <ProposalCard key={p.id} proposal={p} vault={vault} />
      ))}
    </div>
  );
}

function signerRoleLabel(role: string): string {
  if (role === "founder") return "Founder";
  if (role === "heir") return "Heir";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function ProposalCard({ proposal: p, vault }: { proposal: Proposal; vault: Vault }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const sc = statusColor(p.status);
  const terminal = p.status === "broadcast" || p.status === "cancelled";

  // Confirmation count for a broadcast spend -- fetched straight from
  // mempool.space (txConfirmations), same as the countdown timers
  // elsewhere on this page. null while loading/unknown, 0 means
  // broadcast but still unconfirmed. Polled every 30s only while this
  // proposal is still short of the 6-confirmation "settled" mark most
  // wallets treat as final -- no point re-fetching forever once it's
  // deep enough that another confirmation doesn't change anything the
  // owner needs to see.
  const [confirmations, setConfirmations] = useState<number | null>(null);
  useEffect(() => {
    if (p.status !== "broadcast" || !p.txid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        const n = await txConfirmations(vault.network, p.txid!);
        if (cancelled) return;
        setConfirmations(n);
        if (n !== null && n < 6) timer = setTimeout(() => void poll(), 30_000);
      } catch {
        // best-effort -- the row just won't show a count
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [vault.network, p.status, p.txid]);

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
              {p.status === "broadcast" && (
                <>
                  {" · "}
                  {confirmations == null
                    ? "checking confirmations..."
                    : confirmations === 0
                      ? "unconfirmed"
                      : confirmations < 6
                        ? `${confirmations} confirmation${confirmations === 1 ? "" : "s"}`
                        : `${confirmations} confirmations ✓`}
                </>
              )}
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
          <span
            style={{
              color: colors.muted,
              fontSize: 12,
              padding: 8,
              margin: -8,
              lineHeight: 1,
            }}
          >
            {expanded ? "^" : "v"}
          </span>
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
          {!terminal && p.signer_sessions && p.signer_sessions.length > 0 && (
            <div
              style={{
                marginBottom: 10,
                padding: 10,
                borderRadius: 8,
                background: colors.inset,
                border: `1px solid ${colors.border}`,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
                {p.signer_sessions.filter(s => s.signed).length} of {p.signer_sessions.length} signed
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {p.signer_sessions.map(s => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: colors.sub }}>
                      {s.label || signerRoleLabel(s.signer_role)} <span style={{ color: colors.muted }}>({signerRoleLabel(s.signer_role)})</span>
                    </span>
                    <span style={{ color: s.signed ? colors.green : colors.muted, fontWeight: 600 }}>
                      {s.signed ? "Signed" : "Waiting"}
                    </span>
                  </div>
                ))}
              </div>
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
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              variant={terminal ? "ghost" : "primary"}
              size="sm"
              style={{ fontSize: 12 }}
              onClick={() => navigate(`/vaults/${vault.id}/proposals/${p.id}`)}
            >
              {terminal ? "View votes & history" : "Sign / manage"}
            </Button>
            {p.psbt_hex && (
              <Button
                variant="ghost"
                size="sm"
                style={{ fontSize: 12 }}
                onClick={() => navigator.clipboard.writeText(p.psbt_hex!)}
              >
                Copy PSBT
              </Button>
            )}
          </div>
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
  const [memberTapitNames, setMemberTapitNames] = useState<Map<string, string>>(new Map());

  // Resolve each member's real Tapit identity the same way the Spending
  // paths card already does (2026-08-15, operator: "the name showing up...
  // not showing up as the actual identity. The name the person put in that
  // would be cool"). vault_members.label is whatever the vault owner typed
  // in when adding them -- often stale or a placeholder -- while the
  // person's own Tapit wallet publishes a self-authored kind-0 name. Both
  // still render (see MemberRow): the resolved identity leads, the local
  // label follows as a parenthetical so a mismatch is visible rather than
  // silently overwritten.
  const memberPubkeysKey = members.map(m => m.pubkey).filter((p): p is string => !!p).join(",");
  useEffect(() => {
    let cancelled = false;
    if (memberPubkeysKey.length === 0) { setMemberTapitNames(new Map()); return; }
    fetchTapitDisplayNames(memberPubkeysKey.split(","))
      .then(names => { if (!cancelled) setMemberTapitNames(names); })
      .catch(() => { /* best-effort -- members fall back to their local label */ });
    return () => { cancelled = true; };
  }, [memberPubkeysKey]);

  // "Make sure there's no branch work left over somewhere" -- a member
  // whose pubkey doesn't appear in any of the vault's current compiled
  // leaves is either mid-invite (no key uploaded yet, pubkey is null and
  // this correctly doesn't flag them) or a leftover: the vault was
  // recompiled with a different key set after they joined, or their key
  // was swapped out, and this app-access row never got cleaned up to
  // match. Owner-only path stays exempt -- an owner always has founder
  // standing even before their key is on file.
  const compiledPubkeys = new Set([
    ...vault.founder_keys, ...vault.heir_keys,
    ...vault.backup_keys, ...vault.consent_keys, ...vault.second_heir_keys,
  ]);
  const staleMembers = members.filter(
    m => m.role !== "owner" && m.status === "active" && m.pubkey && !compiledPubkeys.has(m.pubkey),
  );

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
      {vault.status === "compiled" && (
        <VaultMembershipSetup
          vaultId={vault.id}
          vaultDescriptor={vault.descriptor}
          vaultName={vault.name}
          founderKeys={vault.founder_keys}
          heirKeys={vault.heir_keys}
          backupKeys={vault.backup_keys}
          consentKeys={vault.consent_keys}
          secondHeirKeys={vault.second_heir_keys}
          leaves={vault.leaves}
          leafScripts={vault.leaf_scripts}
          keyLabels={vault.key_labels}
          isOwner={sessionUserId === vault.user_id}
        />
      )}
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
          <MemberRow
            key={m.id}
            member={m}
            tapitName={m.pubkey ? memberTapitNames.get(m.pubkey) : undefined}
            stale={staleMembers.some(sm => sm.id === m.id)}
            onRemove={() => void removeMember(m)}
          />
        ))}
      </div>

      {staleMembers.length > 0 && (
        <div
          style={{
            background: `${colors.gold}0d`,
            border: `1px solid ${colors.gold}44`,
            borderRadius: 12,
            padding: "12px 16px",
            fontSize: 12,
            color: colors.sub,
          }}
        >
          <div style={{ fontWeight: 600, color: colors.gold, marginBottom: 4 }}>
            {staleMembers.length} member{staleMembers.length === 1 ? "" : "s"} out of sync with the compiled vault
          </div>
          <div>
            {staleMembers.map(m => m.label ?? "Unlabeled").join(", ")} still {staleMembers.length === 1 ? "has" : "have"} app
            access here, but their key isn't in this vault's current compiled leaves -- either the vault was recompiled with a
            different key set since they joined, or their key changed. Remove their access below if they no longer belong, or
            have them re-add their current key if they do.
          </div>
        </div>
      )}

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
    k => k.status === "active" && keyNetworkMatches(k.network, vault.network),
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

function MemberRow({
  member: m,
  tapitName,
  stale,
  onRemove,
}: {
  member: VaultMember;
  /** The person's own chosen identity from their Tapit wallet's kind-0
   *  profile, if their key resolved to one. Leads the row when present;
   *  m.label (the owner-typed local label) follows as a parenthetical. */
  tapitName?: string;
  /** True when this member's key isn't in the vault's current compiled
   *  leaves -- see the "no branch work left over" audit in MembersTab. */
  stale?: boolean;
  onRemove: () => void;
}) {
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
          {tapitName ?? m.label ?? "Unnamed"}
          {tapitName && m.label && tapitName !== m.label && (
            <span style={{ fontWeight: 400, color: colors.muted }}> ({m.label})</span>
          )}
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
          {stale && (
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
              KEY OUT OF SYNC
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
  const [keyBackupRefresh, setKeyBackupRefresh] = useState(0);

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
    if (!(await askConfirm({ title: "Regenerate messaging key", message: "Regenerate your messaging key? You will lose access to messages sent with your current key unless you back up the new one too.", confirmLabel: "Regenerate", danger: true }))) return;
    localStorage.removeItem("dynastytrust:messaging:v1");
    ensureMessagingKey();
    setShowKeyReset(false);
    setKeyBackupRefresh(n => n + 1);
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
        <strong style={{ color: colors.gold }}>End-to-end encrypted.</strong> Messages are sealed to each recipient's X25519 key before they leave your browser. The server stores ciphertext only and cannot read them.
      </div>

      <MessagingKeyBackupPanel refreshToken={keyBackupRefresh} onRestored={() => void load()} />

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

function ActivityTab({ vault, onOpenTab }: { vault: Vault; onOpenTab: (id: string) => void }) {
  const [events, setEvents] = useState<VaultEvent[]>([]);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [ev, mem] = await Promise.all([
        api.vaultEvents.list(vault.id, 100),
        api.members.list(vault.id),
      ]);
      setEvents(ev.events);
      setMembers(mem.members);
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

  const memberLabel = (userId: string): string => {
    const m = members.find(m => m.user_id === userId);
    if (!m) return "A former member";
    return m.label || (m.role ? m.role.charAt(0).toUpperCase() + m.role.slice(1) : "A member");
  };

  const goToDestination = (dest: EventDestination) => {
    if (!dest) return;
    if (dest.kind === "proposal") navigate(`/vaults/${vault.id}/proposals/${dest.proposalId}`);
    else onOpenTab(dest.tab);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Every action taken on this vault, who took it, and a link to the full
        record -- the proposal it belongs to, or the Trust / Requests /
        Members tab that holds the source-of-truth detail.
      </div>
      {events.map(e => (
        <EventRow key={e.id} event={e} actor={memberLabel(e.user_id)} onOpen={goToDestination} />
      ))}
    </div>
  );
}

type EventDestination =
  | { kind: "proposal"; proposalId: string }
  | { kind: "tab"; tab: string }
  | null;

function eventDestination(e: VaultEvent): EventDestination {
  const meta = e.metadata || {};
  if (typeof meta.proposal_id === "string") {
    return { kind: "proposal", proposalId: meta.proposal_id };
  }
  if (typeof meta.attestation_id === "string" || e.event_type.startsWith("attestation_")) {
    return { kind: "tab", tab: "trust" };
  }
  if (typeof meta.request_id === "string" || e.event_type.startsWith("request_")) {
    return { kind: "tab", tab: "requests" };
  }
  if (["invite_created", "member_joined", "member_removed"].includes(e.event_type)) {
    return { kind: "tab", tab: "members" };
  }
  return null;
}

function EventRow({
  event,
  actor,
  onOpen,
}: {
  event: VaultEvent;
  actor: string;
  onOpen: (dest: EventDestination) => void;
}) {
  const { icon, title, color } = describeEvent(event, actor);
  const dest = eventDestination(event);
  const clickable = dest !== null;
  return (
    <div
      onClick={clickable ? () => onOpen(dest) : undefined}
      style={{
        display: "flex",
        gap: 12,
        padding: "12px 4px",
        borderBottom: `1px solid ${colors.border}`,
        cursor: clickable ? "pointer" : "default",
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
      {clickable && (
        <div style={{ color: colors.muted, fontSize: 14, alignSelf: "center", flexShrink: 0 }}>
          &gt;
        </div>
      )}
    </div>
  );
}

function describeEvent(e: VaultEvent, actor: string): { icon: string; title: string; color: string } {
  const meta = e.metadata || {};
  switch (e.event_type) {
    case "created":
      return { icon: "+", title: "Vault created", color: colors.gold };
    case "invite_created":
      return { icon: "i", title: `${actor} sent an invite (${String(meta.role ?? "member")})`, color: colors.blue };
    case "member_joined":
      return { icon: "@", title: `${actor} joined as ${String(meta.role ?? "member")}`, color: colors.green };
    case "member_removed":
      return { icon: "-", title: `${actor} was removed`, color: colors.red };
    case "psbt_generated":
      return {
        icon: "T",
        title: `${actor} created a proposal${meta.amount_sats ? ` (${(Number(meta.amount_sats) / 1e8).toFixed(8).replace(/\.?0+$/, "")} BTC)` : ""}`,
        color: colors.orange,
      };
    case "signed":
      return { icon: "S", title: `${actor} signed the PSBT`, color: colors.gold };
    case "broadcast":
      return {
        icon: "B",
        title: `${actor} broadcast the transaction${meta.txid ? ` (${String(meta.txid).slice(0, 12)}...)` : ""}`,
        color: colors.green,
      };
    case "cancelled":
      return { icon: "x", title: `${actor} cancelled the proposal`, color: colors.muted };
    case "commented":
      return { icon: "c", title: `${actor} commented`, color: colors.sub };
    case "voted_approve":
      return { icon: "+", title: `${actor} voted to approve`, color: colors.green };
    case "voted_abstain":
      return { icon: "o", title: `${actor} abstained`, color: colors.muted };
    case "voted_decline":
      return { icon: "-", title: `${actor} voted to decline`, color: colors.red };
    case "request_created":
      return {
        icon: "R",
        title: `${actor} filed a distribution request${meta.rule_name ? ` (${String(meta.rule_name)})` : ""}${meta.amount_sats ? ` -- ${(Number(meta.amount_sats) / 1e8).toFixed(8).replace(/\.?0+$/, "")} BTC` : ""}`,
        color: colors.orange,
      };
    case "request_approved":
      return { icon: "+", title: `${actor} approved the request`, color: colors.green };
    case "request_declined":
      return { icon: "x", title: `${actor} declined the request`, color: colors.red };
    case "request_fulfilled":
      return { icon: "!", title: "Request fulfilled", color: colors.green };
    case "request_cancelled":
      return { icon: "o", title: `${actor} cancelled the request`, color: colors.muted };
    case "attestation_trust_doc":
      return { icon: "T", title: `${actor} signed the trust doc`, color: colors.gold };
    case "attestation_proof_of_life":
      return { icon: "L", title: `${actor} checked in (proof of life)`, color: colors.green };
    case "attestation_death_declaration":
      return { icon: "!", title: `${actor} signed a death declaration`, color: colors.red };
    case "attestation_descriptor":
      return { icon: "D", title: `${actor} attested to the vault descriptor`, color: colors.blue };
    case "attestation_revoked":
      return { icon: "x", title: `${actor} revoked an attestation`, color: colors.muted };
    default:
      return { icon: "*", title: `${actor}: ${e.event_type}`, color: colors.sub };
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

  useEffect(() => {
    if (tip == null) return;
    if (recoveryOffset == null) setRecoveryOffset(offsetFromAbs(vault.recovery_after));
    if (inheritanceOffset == null) setInheritanceOffset(offsetFromAbs(vault.inheritance_after));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip]);

  const hasInheritance = vault.inheritance_after > 0 || vault.recovery_after > 0;

  async function rotate() {
    setBusy(true);
    try {
      const res = await api.vaults.rotate({
        vault_id: vault.id,
        overrides: {
          name: name.trim() || undefined,
          recovery_after: hasInheritance ? (recoveryOffset ?? 0) : 0,
          inheritance_after: hasInheritance ? (inheritanceOffset ?? 0) : 0,
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
      autofillTrustDocIfEmpty(vault, res.vault);
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
  // Bloc drafts have no vault_members rows at all -- they're single-owner,
  // keys come in directly through the wizard -- and no planned_founder/
  // heir_count either, so this readiness math doesn't apply to them at
  // all (plannedF would read 0 and slotsFilled would go true with zero
  // keys attached, offering a "Compile vault" button that calls the wrong
  // endpoint). Route Bloc drafts straight to the wizard instead.
  const isBloc = vault.bloc_policy != null;
  const slotsFilled = !isBloc && plannedF > 0 && foundersReady >= plannedF && heirsReady >= plannedH;

  async function compile() {
    setBusy(true);
    try {
      const res = await api.vaults.compile(vault.id);
      toast.success("Vault compiled -- ready to fund");
      autofillTrustDocIfEmpty(vault, res.vault);
      navigate(`/vaults/${res.vault.id}`, { state: { vault: res.vault } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Compile failed");
    } finally {
      setBusy(false);
    }
  }

  // "Continue setup" is the fix for the 2026-08-13 draft-save bug --
  // before this, a solo owner who picked keys in the wizard's Keys step
  // and hit "Save and finish later" landed here with no way back: this
  // button previously only understood the separate vault_members invite
  // flow, so an owner who brought their own keys directly (direct_keys
  // compile mode) had nothing to click. It always renders for a draft,
  // filled slots or not, and routes back into VaultWizard at the Keys
  // step for this same vault (VaultWizard.tsx's resumeVaultId effect).
  return (
    <div style={{ display: "flex", gap: 8, flex: 1 }}>
      {!isBloc && (
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
      )}
      <Button
        variant="ghost"
        style={isBloc ? { flex: 1, padding: "12px" } : { padding: "12px" }}
        onClick={() => navigate("/policy", { state: { resumeVaultId: vault.id } })}
      >
        Continue setup
      </Button>
    </div>
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
// trustees for spends that aren't allowed and successors know
// exactly when their power activates.
function rolePhaseHint(
  vault: Vault,
  tip: number | null,
): { lines: string[]; cta?: string } {
  const role = (vault as Vault & { my_role?: string }).my_role;
  const t = tip ?? 0;
  const recoveryOpen = vault.recovery_after > 0 && t >= vault.recovery_after;
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
// vault. Complements VaultStructureTree (which shows every path,
// its keys, and its own lock state) with a single "trust phase"
// banner that a non-technical beneficiary can read. Refreshes
// every minute so an imminent unlock flips the banner without a
// manual reload.

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
  let accent = colors.gold;
  let label = "Normal operation";
  let description =
    `${vault.founder_quorum} of ${vault.founder_keys.length} trustees can sign at any time.`;

  const inheritance = vault.inheritance_after ?? 0;
  const recovery = vault.recovery_after ?? 0;

  if (inheritance > 0 && tip >= inheritance) {
    label = "Inheritance triggered";
    description = `After block ${inheritance.toLocaleString()}, heirs can spend without the trustees.`;
    accent = colors.green;
    paths.push(`Heirs (Path 3) - ${vault.heir_quorum} of ${vault.heir_keys.length}`);
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

// // -- VaultStructureTree
// A literal picture of the compiled Taproot script: a root, and one
// branch per leaf actually present in this vault's descriptor -- not
// just the currently-active one. Operator (2026-08-13, looking at the
// old "Inheritance triggered" banner + a separate "Timelocks" card
// showing only Recovery/Inheritance): "The inheritance triggering
// should be very clear which branch it is which keys it is... needs
// [the] same type of visual structure" as the succession language in
// the trust doc. That prose describes exactly these leaves in words;
// this draws the leaves themselves -- label, quorum, the actual keys
// (resolved to the signer's name where a vault_members row matches
// that pubkey), and each leaf's own lock state -- so a reader can see
// the shape instead of inferring it from a paragraph. Supersedes the
// old TimelockCountdown, which only ever showed two of up to four
// possible leaves (never Backup or Second inheritance).
//
// Each leaf's status is reported independently rather than picking one
// "current phase" -- Bitcoin's OR-of-branches doesn't collapse to a
// single active path (Recovery and Inheritance can both be unlocked at
// once), so showing them as a single narrative would overclaim.
type VaultLeafStatus = "active" | "unlocked" | "locked";

interface VaultLeaf {
  id: string;
  label: string;
  color: string;
  quorum: number;
  keyPubkeys: string[];
  absHeight: number | null;
  status: VaultLeafStatus;
  note?: string;
}

function vaultLeafStatus(absHeight: number | null, tip: number | null): VaultLeafStatus {
  if (!absHeight || absHeight <= 0) return "active";
  if (tip != null && tip >= absHeight) return "unlocked";
  return "locked";
}

function buildVaultLeaves(vault: Vault, tip: number | null): VaultLeaf[] {
  const leaves: VaultLeaf[] = [
    {
      id: "founders_now",
      label: "Trustees -- Path 1",
      color: colors.gold,
      quorum: vault.founder_quorum,
      keyPubkeys: vault.founder_keys,
      absHeight: null,
      status: "active",
      note:
        vault.consent_quorum != null && vault.consent_keys.length > 0
          ? `+ ${vault.consent_quorum} of ${vault.consent_keys.length} beneficiary consent required`
          : undefined,
    },
  ];

  // "Gift Locker"-shaped vaults have recovery_after === 0 -- no
  // recovery leaf at all in the compiled descriptor.
  if (vault.recovery_after > 0) {
    leaves.push({
      id: "recovery",
      label: "Recovery -- Path 2",
      color: colors.blue,
      quorum: vault.recovery_quorum ?? vault.founder_quorum,
      keyPubkeys: vault.founder_keys,
      absHeight: vault.recovery_after,
      status: vaultLeafStatus(vault.recovery_after, tip),
    });
  }

  // Mutually exclusive with recovery (027_backup_path.sql) -- a
  // separate, untimelocked, harder-to-reach keyset.
  if (vault.backup_keys.length > 0) {
    leaves.push({
      id: "backup",
      label: "Backup -- anytime, harder",
      color: colors.blue,
      quorum: vault.backup_quorum ?? vault.backup_keys.length,
      keyPubkeys: vault.backup_keys,
      absHeight: null,
      status: "active",
    });
  }

  if (vault.heir_keys.length > 0) {
    leaves.push({
      id: "inheritance",
      label: "Heirs -- Path 3",
      color: colors.green,
      quorum: vault.heir_quorum,
      keyPubkeys: vault.heir_keys,
      absHeight: vault.inheritance_after,
      status: vaultLeafStatus(vault.inheritance_after, tip),
    });
  }

  if (vault.second_heir_keys.length > 0) {
    leaves.push({
      id: "second_inheritance",
      label: "Second heirs",
      color: colors.green,
      quorum: vault.second_heir_quorum ?? vault.second_heir_keys.length,
      keyPubkeys: vault.second_heir_keys,
      absHeight: vault.second_inheritance_after,
      status: vaultLeafStatus(vault.second_inheritance_after, tip),
    });
  }

  return leaves;
}

function VaultLeafStatusPill({ status, absHeight, tip }: { status: VaultLeafStatus; absHeight: number | null; tip: number | null }) {
  if (status === "active") {
    return (
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: colors.gold, textTransform: "uppercase", whiteSpace: "nowrap" }}>
        Active now
      </span>
    );
  }
  if (status === "unlocked") {
    return (
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: colors.green, textTransform: "uppercase", whiteSpace: "nowrap" }}>
        Unlocked
      </span>
    );
  }
  const blocksLeft = tip != null && absHeight != null ? Math.max(0, absHeight - tip) : null;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: colors.muted, textTransform: "uppercase", whiteSpace: "nowrap" }}>
      {blocksLeft != null ? `Locked -- ${blocksToApproxLabel(blocksLeft)}` : "Locked"}
    </span>
  );
}

function VaultStructureTree({ vault }: { vault: Vault }) {
  const toast = useToast();
  const [tip, setTip] = useState<number | null>(null);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [tapitNames, setTapitNames] = useState<Map<string, string>>(new Map());
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [editingPubkey, setEditingPubkey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  // Local, optimistic-on-success copy of vault.key_labels -- lets an
  // edit show up immediately without threading a vault-refresh callback
  // through every parent of this component, matching how TrustDocSection
  // and other sections on this page already manage their own post-save
  // display state independently of the page-level vault object.
  const [keyLabels, setKeyLabels] = useState(vault.key_labels);
  const isOwner = sessionUserId === vault.user_id;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSessionUserId(data.session?.user?.id ?? null);
    });
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    api.members
      .list(vault.id)
      .then(({ members: m }) => { if (!cancelled) setMembers(m); })
      .catch(() => { /* best-effort -- keys fall back to a short pubkey */ });
    return () => { cancelled = true; };
  }, [vault.id]);

  // Every pubkey that could appear on any leaf of this vault, once --
  // ask the Nostr relays who each one really is on Tapit. A hardware-
  // wallet-only key just never resolves (nobody published a kind-0
  // profile for it) and silently falls back to the local label below.
  // Depends on the joined string rather than the arrays themselves --
  // vault.founder_keys etc. get a fresh array identity on every fetch
  // even when the actual keys haven't changed, which would otherwise
  // re-open a relay subscription on every unrelated re-render.
  const allPubkeysKey = [
    ...vault.founder_keys,
    ...vault.backup_keys,
    ...vault.heir_keys,
    ...vault.second_heir_keys,
  ].join(",");
  useEffect(() => {
    let cancelled = false;
    if (allPubkeysKey.length === 0) return;
    fetchTapitDisplayNames(allPubkeysKey.split(","))
      .then(names => { if (!cancelled) setTapitNames(names); })
      .catch(() => { /* best-effort -- keys fall back to the local label */ });
    return () => { cancelled = true; };
  }, [allPubkeysKey]);

  // "The one founder key is the owner and anybody else can be the
  // trustees of that branch" (operator, 2026-08-15) -- a sensible
  // DEFAULT for the founders_now leaf's key pills when nobody has set
  // an explicit label yet: the first founder key (by position -- the
  // key the vault's own creator brought) reads "Owner", every other
  // founder key reads "Trustee". Every other leaf (recovery reuses the
  // same founder_keys array, so it inherits the same defaults; heir/
  // backup/second-heir keep no positional default at all -- those
  // role names were never the confusing part). Only a fallback:
  // an explicit key_labels entry always wins, including "you could
  // label them all founders if you wanted" -- nothing here forces
  // Owner/Trustee on anyone.
  const positionalDefault = (pubkey: string): string | null => {
    const idx = vault.founder_keys.indexOf(pubkey);
    if (idx < 0) return null;
    return idx === 0 ? "Owner" : "Trustee";
  };

  const customLabel = (pubkey: string): string | null => {
    // Exact match, not case-folded: an xpub is base58 and case-sensitive
    // (lowercasing one would corrupt it as a lookup key), and a hex
    // pubkey already arrives here lowercased from both sides (founder_keys
    // via keyStoreValue(), and key_labels via the backend's own
    // normalizeKeyIdentifier) -- see vaults.js's header comment on that
    // function for why blanket lowercasing here would be wrong.
    const entry = keyLabels.find(kl => kl.pubkey === pubkey);
    return entry?.label || null;
  };

  // Priority: an explicit label the owner actually typed always wins
  // (including overriding a resolved Tapit identity, since "who this
  // is" and "what to call their slot" are the owner's call once set)
  // -- then the real Tapit identity, since a person's own name beats a
  // generic role placeholder -- then the Owner/Trustee positional
  // default -- then vault_members.label -- then the hex fallback.
  const keyLabel = (pubkey: string): string => {
    const custom = customLabel(pubkey);
    if (custom) return custom;
    const tapitName = tapitNames.get(pubkey);
    if (tapitName) return tapitName;
    const positional = positionalDefault(pubkey);
    if (positional) return positional;
    const m = members.find(mm => mm.pubkey === pubkey);
    return m?.label || `Key ${pubkey.slice(0, 6)}`;
  };

  async function saveLabel(pubkey: string) {
    const trimmed = editValue.trim();
    setSaving(true);
    try {
      const res = await api.vaults.setKeyLabel(vault.id, pubkey, trimmed || null);
      setKeyLabels(res.vault.key_labels);
      setEditingPubkey(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save label");
    } finally {
      setSaving(false);
    }
  }

  const leaves = buildVaultLeaves(vault, tip);

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
          marginBottom: 12,
          textTransform: "uppercase",
        }}
      >
        Spending paths
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: colors.text, flexShrink: 0 }} />
        <div style={{ fontSize: 12, color: colors.sub, fontFamily: fonts.mono, wordBreak: "break-all" }}>
          {vault.address ? `${vault.address.slice(0, 10)}...${vault.address.slice(-6)}` : "This vault"}
        </div>
      </div>
      <div
        style={{
          borderLeft: `2px solid ${colors.border}`,
          marginLeft: 4,
          paddingLeft: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {leaves.map(leaf => (
          <div key={leaf.id} style={{ position: "relative" }}>
            <div
              style={{
                position: "absolute",
                left: -20,
                top: 15,
                width: 16,
                height: 2,
                background: colors.border,
              }}
            />
            <div
              style={{
                background: colors.input,
                border: `1px solid ${colors.border}`,
                borderLeft: `3px solid ${leaf.color}`,
                borderRadius: 8,
                padding: "10px 12px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{leaf.label}</div>
                <VaultLeafStatusPill status={leaf.status} absHeight={leaf.absHeight} tip={tip} />
              </div>
              <div style={{ fontSize: 12, color: colors.sub, marginTop: 4 }}>
                {leaf.quorum} of {leaf.keyPubkeys.length} required
                {leaf.absHeight ? ` -- unlocks at block ${leaf.absHeight.toLocaleString()}` : ""}
              </div>
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {leaf.keyPubkeys.map((pk, idx) =>
                  editingPubkey === pk ? (
                    <span key={idx} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                      <input
                        autoFocus
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") void saveLabel(pk);
                          if (e.key === "Escape") setEditingPubkey(null);
                        }}
                        placeholder="e.g. Owner, Trustee, Dad"
                        maxLength={60}
                        style={{
                          fontSize: 11,
                          padding: "2px 6px",
                          borderRadius: 4,
                          border: `1px solid ${colors.gold}`,
                          background: colors.input,
                          color: colors.text,
                          width: 120,
                        }}
                      />
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void saveLabel(pk)}
                        style={{ fontSize: 11, color: colors.gold, background: "none", border: "none", cursor: "pointer", padding: 0 }}
                      >
                        {saving ? "..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingPubkey(null)}
                        style={{ fontSize: 11, color: colors.muted, background: "none", border: "none", cursor: "pointer", padding: 0 }}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span
                      key={idx}
                      onClick={
                        isOwner
                          ? () => {
                              setEditingPubkey(pk);
                              setEditValue(customLabel(pk) ?? "");
                            }
                          : undefined
                      }
                      title={isOwner ? "Click to relabel this key" : undefined}
                      style={{
                        background: colors.surface,
                        border: `1px solid ${colors.border}`,
                        borderRadius: 4,
                        padding: "2px 6px",
                        cursor: isOwner ? "pointer" : "default",
                      }}
                    >
                      {keyLabel(pk)}
                    </span>
                  ),
                )}
              </div>
              {leaf.note && (
                <div style={{ fontSize: 11, color: colors.orange, marginTop: 6 }}>{leaf.note}</div>
              )}
            </div>
          </div>
        ))}
      </div>
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

function RequestsTab({ vault, onSendPrefill }: { vault: Vault; onSendPrefill: (p: SendPrefill) => void }) {
  const toast = useToast();
  const askPrompt = usePrompt();
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
    // There's no destination address on a distribution request --
    // only the trustee decides where funds actually go -- so amount
    // and context prefill, the address stays for the trustee to
    // enter. request_id rides along so a successful broadcast can
    // close the loop: mark this request fulfilled and link it to
    // the proposal that paid it (see SendTab's broadcast()).
    onSendPrefill({
      amount_sats: r.amount_sats,
      rule_id: r.rule_id,
      name: r.rule_name ?? undefined,
      memo: r.reason
        ? `Distribution: ${r.reason}`
        : r.recipient_name
          ? `Distribution for ${r.recipient_name}`
          : "Distribution request",
      request_id: r.id,
    });
    toast.info("Request loaded into the Send tab -- enter the destination address to finish.");
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
              isOwner={isOwner}
              onSendPrefill={onSendPrefill}
              onClaimed={() => void load()}
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
  isOwner,
  onSendPrefill,
  onClaimed,
}: {
  wallet: DistributionWallet;
  vault: Vault;
  isOwner: boolean;
  onSendPrefill: (p: SendPrefill) => void;
  onClaimed: () => void;
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
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 11 }}
            onClick={() => downloadDistributionWalletBackup(wallet, vault.name)}
          >
            Download backup
          </Button>
          <Button variant="ghost" size="sm" style={{ fontSize: 11 }} onClick={() => setExpanded(e => !e)}>
            {expanded ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {wallet.tranches.map(t => (
            <TrancheRow
              key={t.index}
              tranche={t}
              tip={tip}
              wallet={wallet}
              isOwner={isOwner}
              onFund={() =>
                onSendPrefill({
                  destination: t.address,
                  amount_sats: t.amount_sats,
                  memo: `Fund ${wallet.name} tranche ${t.index + 1}`,
                  distribution_wallet_id: wallet.id,
                  tranche_index: t.index,
                })
              }
              onClaimed={onClaimed}
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
  wallet,
  isOwner,
  onFund,
  onClaimed,
}: {
  tranche: DistributionTranche;
  tip: number | null;
  wallet: DistributionWallet;
  isOwner: boolean;
  onFund: () => void;
  onClaimed: () => void;
}) {
  const [claimPath, setClaimPath] = useState<"beneficiary" | "trustee" | null>(null);
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
        {isClaimed && (
          <div style={{ color: colors.green }}>
            claimed
            {t.claimed_txid && (
              <>
                {" "}
                <a
                  href={explorerTxUrl(wallet.network, t.claimed_txid)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: colors.gold }}
                >
                  view
                </a>
              </>
            )}
          </div>
        )}
        {!isClaimed && !isFunded && (
          <Button size="sm" style={{ fontSize: 10, padding: "2px 6px", marginTop: 3 }} onClick={onFund}>
            Fund
          </Button>
        )}
        {!isClaimed && isFunded && (
          <div style={{ display: "flex", gap: 4, marginTop: 3, justifyContent: "flex-end" }}>
            {unlocked && (
              <Button size="sm" style={{ fontSize: 10, padding: "2px 6px" }} onClick={() => setClaimPath("beneficiary")}>
                Claim
              </Button>
            )}
            {isOwner && (
              <Button
                variant="ghost"
                size="sm"
                style={{ fontSize: 10, padding: "2px 6px" }}
                onClick={() => setClaimPath("trustee")}
              >
                Trustee escape
              </Button>
            )}
          </div>
        )}
      </div>
      {claimPath && (
        <TrancheClaimModal
          wallet={wallet}
          tranche={t}
          path={claimPath}
          onClose={() => setClaimPath(null)}
          onClaimed={() => { setClaimPath(null); onClaimed(); }}
        />
      )}
    </div>
  );
}

// Claims a single tranche -- either the beneficiary after its
// timelock, or a trustee via the escape hatch. Deliberately mirrors
// SendTab's own build -> sign -> broadcast shape (same PSBT helpers,
// same hardware-wallet QR/paste block) rather than inventing a new
// pattern, since a tranche's PSBT is signed exactly the same way a
// main-vault PSBT is -- only the source script differs. Tapit signing
// (both the B2 cross-tab handoff and the B3 Nostr round trip) is wired
// in below, same as SendTab's -- this used to be out of scope, but
// nothing about a tranche claim's PSBT makes it any different to sign.
function TrancheClaimModal({
  wallet,
  tranche,
  path,
  onClose,
  onClaimed,
}: {
  wallet: DistributionWallet;
  tranche: DistributionTranche;
  path: "beneficiary" | "trustee";
  onClose: () => void;
  onClaimed: () => void;
}) {
  const toast = useToast();
  const askPassword = usePrompt();
  const navigate = useNavigate();
  const [step, setStep] = useState<"form" | "signing" | "done">("form");
  const [dest, setDest] = useState("");
  const [sweepAll, setSweepAll] = useState(true);
  const [amountBtc, setAmountBtc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [psbtHex, setPsbtHex] = useState("");
  const [summary, setSummary] = useState<{ amount_sats: number; fee_sats: number; change_sats: number } | null>(null);
  const [signers, setSigners] = useState<Array<{ key: LocalKey; status: "pending" | "signing" | "signed" | "error"; error?: string }>>([]);
  const [signaturesCollected, setSignaturesCollected] = useState(0);
  const [txid, setTxid] = useState<string | null>(null);
  const [showQrDisplay, setShowQrDisplay] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  // 2026-08-12 (operator: "every PSBT has some kind of request tied to it
  // ... especially in the bigger vaults"): a Tranche claim used to
  // broadcast with zero request/vote/history trail at all -- no
  // proposals row, so this claim could never show up in the vault's
  // History tab or ProposalDetail's votes/discussion/audit view the way
  // every standard and Bloc spend already does. Filed as a real proposal
  // (path='tranche_claim') the moment the PSBT is built.
  const [proposalId, setProposalId] = useState<string | null>(null);

  const requiredSignatures = path === "beneficiary" ? 1 : wallet.trustee_quorum;
  const eligiblePubkeys = path === "beneficiary" ? [wallet.beneficiary_pubkey] : wallet.trustee_keys;

  async function build(e: React.FormEvent) {
    e.preventDefault();
    if (!dest.trim()) { setErr("Destination address required"); return; }
    const amount_sats = sweepAll ? undefined : Math.round(parseFloat(amountBtc || "0") * 1e8);
    if (!sweepAll && (!amount_sats || amount_sats < 546)) {
      setErr("Minimum 546 sats");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.distributionWallets.buildClaim({
        distribution_wallet_id: wallet.id,
        tranche_index: tranche.index,
        destination: dest.trim(),
        amount_sats,
        path,
      });
      if (res.status === "no_utxos") {
        setErr(res.message || "No confirmed funds at this tranche address yet.");
        setBusy(false);
        return;
      }
      setPsbtHex(res.psbt_hex);
      setSummary(res.summary);

      try {
        const { proposal } = await api.proposals.create({
          vault_id: wallet.vault_id,
          destination: dest.trim(),
          amount_sats: res.summary.amount_sats,
          fee_sats: res.summary.fee_sats,
          path: "tranche_claim",
          memo: `${wallet.name} tranche #${tranche.index + 1} claim (${path})`,
          psbt_hex: res.psbt_hex,
          distribution_wallet_id: wallet.id,
          tranche_index: tranche.index,
        });
        setProposalId(proposal.id);
      } catch {
        // Non-fatal: the claim can still be signed and broadcast without a
        // proposal row (matches the pre-2026-08-12 behavior) -- it just
        // won't show up in the vault's request history afterward.
      }

      // Tapit-origin keys hold no local key material and can never sign
      // in-browser, but they DO need to appear here so NotifyCircleViaNostr
      // below can find them and deliver the request to the right person's
      // Tapit inbox -- excluding them left that component with nothing to
      // ever show, and the standalone "Sign via Tapit" window.open button
      // that used to fill the gap forced a fresh browser tab to
      // re-establish its own Tapit session, which read as "trying to log
      // me in" (operator, 2026-08-08 on the main Send flow; 2026-08-15,
      // same bug, reported here). Matches the identical fix already
      // shipped for the main proposal signing flow above.
      const localKeys = listKeys().filter(
        k => k.status === "active" && (k.origin === "software" || k.origin === "tapit") && keyNetworkMatches(k.network, wallet.network),
      );
      const matching = localKeys.filter(k => eligiblePubkeys.includes(k.pubkey));
      setSigners(matching.map(key => ({ key, status: "pending" })));
      setSignaturesCollected(0);
      setStep("signing");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to build transaction");
    } finally {
      setBusy(false);
    }
  }

  async function signWithKey(index: number) {
    const entry = signers[index];
    setSigners(prev => prev.map((s, i) => (i === index ? { ...s, status: "signing" } : s)));
    try {
      let pw: string | undefined;
      if (!entry.key.testMnemonic) {
        const result = await askPassword({
          title: "Unlock key",
          message: `Enter the password for "${entry.key.label}" to sign.`,
          password: true,
          confirmLabel: "Sign",
        });
        if (result === null) {
          setSigners(prev => prev.map((s, i) => (i === index ? { ...s, status: "pending" } : s)));
          return;
        }
        pw = result;
      }
      const mnemonic = await revealMnemonic(entry.key.keyId, pw);
      const result = await signPsbtWithMnemonic(psbtHex, mnemonic, entry.key.derivationPath, wallet.network);
      const merged = mergePsbts([psbtHex, result.psbt_hex]);
      setPsbtHex(merged);
      setSignaturesCollected(countSignatures(merged));
      setSigners(prev => prev.map((s, i) => (i === index ? { ...s, status: "signed" } : s)));
    } catch (e) {
      setSigners(prev =>
        prev.map((s, i) => (i === index ? { ...s, status: "error", error: e instanceof Error ? e.message : "Failed" } : s)),
      );
    }
  }

  function externalImport(importedHex: string) {
    const merged = mergePsbts([psbtHex, importedHex]);
    setPsbtHex(merged);
    setSignaturesCollected(countSignatures(merged));
  }

  async function broadcast() {
    setBusy(true);
    setErr(null);
    try {
      const finalized = await api.psbt.finalize(psbtHex);
      const res = await fetch(broadcastTxUrl(wallet.network), {
        method: "POST",
        body: finalized.raw_tx_hex,
        headers: { "Content-Type": "text/plain" },
      });
      const newTxid = (await res.text()).trim();
      if (!res.ok || newTxid.length !== 64) {
        throw new Error("Broadcast failed: " + newTxid.slice(0, 100));
      }

      try {
        const { wallets } = await api.distributionWallets.list(wallet.vault_id);
        const dw = wallets.find(w => w.id === wallet.id);
        if (dw) {
          const tranches = dw.tranches.map(t =>
            t.index === tranche.index ? { ...t, claimed_txid: newTxid } : t,
          );
          await api.distributionWallets.update(dw.id, { tranches });
        }
      } catch {
        /* non-fatal: the claim already broadcast; the row just won't
           show "claimed" until a manual refresh picks up the txid
           from chain state elsewhere. */
      }

      if (proposalId) {
        try {
          await api.proposals.update(proposalId, {
            status: "broadcast",
            psbt_hex: psbtHex,
            txid: newTxid,
          });
        } catch {
          /* non-fatal: the on-chain spend already succeeded; the request
             history just won't reflect the final signed PSBT/txid until a
             manual retry. */
        }
      }

      setTxid(newTxid);
      setStep("done");
      toast.success("Tranche claimed");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Broadcast failed");
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
        if (e.target === e.currentTarget && step !== "signing") onClose();
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: "28px 32px",
          width: "100%",
          maxWidth: 480,
          maxHeight: "85vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
          {path === "beneficiary" ? "Claim tranche" : "Trustee escape hatch"} -- {wallet.name} #{tranche.index + 1}
        </div>

        {step === "form" && (
          <form onSubmit={e => void build(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <Label>Send to</Label>
              <Input mono value={dest} onChange={e => setDest(e.target.value)} placeholder="Destination address" />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: colors.text }}>
              <input type="checkbox" checked={sweepAll} onChange={e => setSweepAll(e.target.checked)} />
              Sweep the full tranche balance
            </label>
            {!sweepAll && (
              <div>
                <Label>Amount (BTC)</Label>
                <Input mono value={amountBtc} onChange={e => setAmountBtc(e.target.value)} placeholder="0.00" />
              </div>
            )}
            {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <Button type="submit" disabled={busy} style={{ flex: 1 }}>
                {busy ? "Building..." : "Build transaction"}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        )}

        {step === "signing" && summary && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, color: colors.muted }}>
              {satsToBtc(summary.amount_sats)} BTC + {summary.fee_sats} sats fee
              {summary.change_sats > 0 && <> . {satsToBtc(summary.change_sats)} BTC change</>}
            </div>
            <div style={{ fontSize: 12, color: colors.muted }}>
              {signaturesCollected} of {requiredSignatures} signature{requiredSignatures !== 1 ? "s" : ""} collected
            </div>

            {signers.some(s => s.key.origin !== "tapit") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {signers.map((signer, i) => {
                  if (signer.key.origin === "tapit") return null;
                  return (
                    <div
                      key={signer.key.keyId}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 12px",
                        border: `1px solid ${colors.border}`,
                        borderRadius: 8,
                        cursor: signer.status === "pending" || signer.status === "error" ? "pointer" : "default",
                        opacity: signer.status === "signing" ? 0.7 : 1,
                      }}
                      onClick={() => (signer.status === "pending" || signer.status === "error") && void signWithKey(i)}
                    >
                      <div>
                        <div style={{ fontSize: 14, color: colors.text }}>{signer.key.label}</div>
                        {signer.error && <div style={{ fontSize: 11, color: colors.red }}>{signer.error}</div>}
                      </div>
                      <div style={{ fontSize: 12, color: colors.muted }}>
                        {signer.status === "signed" ? "signed" : signer.status === "signing" ? "signing..." : "tap to sign"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* "Sign via Tapit" (window.open a new tab to Tapit's /sign
                route) is retired from this flow for the same reason it was
                already retired from the main Send flow above: it forced a
                fresh browser tab to re-establish its own Tapit session,
                which read as "trying to log me in." NotifyCircleViaNostr
                below does the same job silently over Nostr with no
                navigation and no second tab -- now that tapit-origin keys
                are included in `signers` above, it has something to show. */}
            <NotifyCircleViaNostr
              subjectId={`${wallet.id}-tranche-${tranche.index}`}
              psbtHex={psbtHex}
              vaultDescriptor={tranche.descriptor}
              vaultName={`${wallet.name} tranche ${tranche.index + 1}`}
              signers={signers}
              onSigned={hex => externalImport(hex)}
            />

            <div
              style={{
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
                Sign with hardware wallet
              </div>
              <div style={{ fontSize: 11, color: colors.muted, marginBottom: 10 }}>
                Export this transaction to your signing device, then paste or scan the signed result back here.
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <Button variant="ghost" size="sm" style={{ fontSize: 11 }} onClick={() => setShowQrDisplay(s => !s)}>
                  {showQrDisplay ? "Hide QR" : "Show QR"}
                </Button>
                <Button variant="ghost" size="sm" style={{ fontSize: 11 }} onClick={() => setShowQrScanner(s => !s)}>
                  {showQrScanner ? "Hide scanner" : "Scan signed QR"}
                </Button>
              </div>
              {showQrDisplay && (
                <div style={{ marginBottom: 10 }}>
                  <PsbtQrDisplay psbtHex={psbtHex} />
                </div>
              )}
              {showQrScanner && (
                <div style={{ marginBottom: 10 }}>
                  <PsbtQrScanner
                    onResult={hex => { setShowQrScanner(false); externalImport(hex); }}
                    onCancel={() => setShowQrScanner(false)}
                  />
                </div>
              )}
              <ExternalPsbtInput onImport={externalImport} />
            </div>

            {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}

            {signaturesCollected >= requiredSignatures ? (
              <Button disabled={busy} style={{ background: colors.green }} onClick={() => void broadcast()}>
                {busy ? "Broadcasting..." : "Broadcast claim"}
              </Button>
            ) : (
              <div style={{ fontSize: 13, color: colors.muted, textAlign: "center" }}>
                {requiredSignatures - signaturesCollected} more signature{requiredSignatures - signaturesCollected !== 1 ? "s" : ""} needed
              </div>
            )}
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        )}

        {step === "done" && txid && (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.green, marginBottom: 8 }}>
              Tranche claimed
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, wordBreak: "break-all", marginBottom: 14 }}>
              {txid}
            </div>
            <a href={explorerTxUrl(wallet.network, txid)} target="_blank" rel="noreferrer" style={{ color: colors.gold, fontSize: 13 }}>
              View on mempool.space
            </a>
            {proposalId && (
              <div style={{ marginTop: 10 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  style={{ fontSize: 12 }}
                  onClick={() => navigate(`/vaults/${wallet.vault_id}/proposals/${proposalId}`)}
                >
                  View votes & history
                </Button>
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <Button onClick={onClaimed}>Done</Button>
            </div>
          </div>
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
    k.status === "active" && keyNetworkMatches(k.network, vault.network),
  );

  useEffect(() => {
    // Default first unlock = current tip + one interval
    tipHeight(vault.network)
      .then(h => setFirstUnlockBlock(h + 4380))
      .catch(() => setFirstUnlockBlock(100_000));
  }, [vault.network]);

  // vault.founder_keys already holds pubkey hex (the /0/0 child,
  // per the Nunchuk key-material parity fix) for any vault compiled
  // under the current PolicyBuilder -- calling pubkeyFromXpub on
  // that unconditionally threw, since HDKey.fromExtendedKey rejects
  // a bare hex string. Mirror the same defensive length check
  // buildAndSign already uses for this exact ambiguity (a handful
  // of pre-fix vaults may still hold a bare xpub) instead of
  // assuming one shape.
  function deriveTrusteePubkeys(): string[] {
    const pubkeys: string[] = [];
    for (const x of vault.founder_keys) {
      if (typeof x !== "string") continue;
      if (x.length === 66) { pubkeys.push(x); continue; }
      try {
        pubkeys.push(pubkeyFromXpub(x));
      } catch {
        /* skip malformed rows */
      }
    }
    return pubkeys;
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

      // BIP32 origins for hardware-wallet compatibility (2026-08-12 fix --
      // the same 2026-08-06 fix already applied to the standard vault and
      // to Bloc, never extended to tranches, so a real hardware wallet had
      // no way to recognize its own key on a tranche claim's leaf and
      // correctly refused to sign). Trustees come from vault_members, the
      // same source the standard vault's own fix reads from; the
      // beneficiary comes from the locally selected key, if one was
      // picked, since it's already in hand with its own fingerprint and
      // derivation path. A pasted xpub with no local key behind it has no
      // derivation path available and is skipped -- same graceful
      // degradation buildPsbtKeyOrigins documents for any missing key.
      let keyOrigins: { pubkey: string; fingerprint: string; derivation_path: string }[] = [];
      try {
        const { members } = await api.members.list(vault.id);
        const trusteeSelected = members
          .filter(
            (m): m is typeof m & { pubkey: string; fingerprint: string; derivation_path: string } =>
              !!m.pubkey && !!m.fingerprint && !!m.derivation_path && trusteeKeys.includes(m.pubkey),
          )
          .map(m => ({
            pubkey: m.pubkey,
            keyId: m.id,
            label: m.label ?? "",
            persona: "",
            xpub: "",
            fingerprint: m.fingerprint,
            derivationPath: m.derivation_path,
            network: vault.network,
          }));
        const beneficiarySelected = beneficiaryKeyId
          ? localKeys.filter(k => k.keyId === beneficiaryKeyId)
          : [];
        keyOrigins = buildPsbtKeyOrigins([...trusteeSelected, ...beneficiarySelected]);
      } catch {
        /* non-fatal: this wallet just won't have hardware-wallet
           recognition until it's recreated once vault_members is
           reachable -- browser and Tapit signing are unaffected. */
      }

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
        key_origins: keyOrigins,
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
            <Button size="sm" style={{ fontSize: 11 }} onClick={spendPicked}>
              Spend selected
            </Button>
          </div>
          {pickedCount > 1 && (
            <div style={{ marginTop: 6, color: colors.muted, fontSize: 11.5, lineHeight: 1.4 }}>
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
