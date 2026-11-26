import { useEffect, useState, useCallback, useMemo } from "react";
import { PANEL_FIT } from "../components/ui/panelFit";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { DOWNLOAD } from "../lib/download";
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
  type BlocPolicy,
} from "../lib/api";
import { supabase } from "../lib/supabase";
import { listKeys } from "../lib/keystore";
import { keyNetworkMatches } from "../lib/network";
import { fetchTapitDisplayNames } from "../lib/tapit-profile-lookup";
import { APP_NAME } from "../config";
import { useToast } from "../components/toast";
import { useConfirm, usePrompt } from "../components/dialog";
import { LoadingScreen } from "../components/LoadingScreen";
import { colors, fonts, radii, space } from "../theme";
import { Button, Input, Label, Textarea } from "../components/ui";
import { useRealtimeRefresh } from "../lib/realtime";
import { downloadVault } from "../lib/descriptor-backup";
import { formatDescriptorFingerprint } from "../lib/descriptor-fingerprint";
import { DescriptorQr } from "../components/DescriptorQr";
import { QrImage } from "../components/QrImage";
import { NewReceiveAddress } from "../components/NewReceiveAddress";
import { isFreshAddressVault } from "../lib/fresh-addresses";
import { RotatePathVault } from "../components/RotatePathVault";
import { PathDraftCard } from "../components/PathDraftCard";
import { pubkeyFromXpub, fingerprintFromXpub } from "../lib/xpub";
import { isLeafListVault } from "../lib/vault-spending-paths";
import { blocDecayLadder } from "../lib/blocks";
import { BehaviorTimeline, type SpendLeg } from "../components/vault-builder";
import { ledgerEventWords } from "../lib/ledger-verify";
import { VaultAddressGate } from "../components/VaultAddressGate";
import { useVaultKey } from "../lib/use-vault-key";
import { inviteLink } from "../lib/invite-link";
import { downloadActivityJson, downloadAuditPdf, downloadTaxSummary, downloadVaultPdf } from "../lib/reports";
import {
  encryptMessage,
  decryptMessage,
  getMessagingPubkey,
  messagingKeyLocked,
  messagingKeyUsesFaceId,
  unlockMessagingKey,
  lockMessagingKey,
  unlockMessagingKeyForGood,
  regenerateMessagingKey,
} from "../lib/messaging";
import { passkeysAvailable } from "../lib/passkey";
import { TrustTab } from "../components/TrustTab";
import { RemindersBanner } from "../components/RemindersBanner";
import { HaltVaultBar } from "../components/HaltVaultBar";
import { CirclePhraseSetup } from "../components/CirclePhraseSetup";
import { SentSecretsPanel } from "../components/SentSecretsPanel";
import { MessagingSafetyPanel, type PeerKey } from "../components/MessagingSafetyPanel";
import { peerKeyStatus, senderKeyMatches } from "../lib/messaging-safety";
import { VaultMembershipSetup } from "../components/VaultMembershipSetup";
import { MessagingKeyBackupPanel } from "../components/MessagingKeyBackupPanel";
import { tipHeight } from "../lib/chain";
import { opensWords, rotateDateWords, ROTATE_EXTENSIONS } from "../lib/timelock-words";
import { ElectrumServerSettings } from "../components/ElectrumServerSettings";
import { ActionGuide } from "./vault-detail/ActionGuide";
import { DistributionWalletsSection } from "./vault-detail/DistributionWallets";
import { DraftCompileButton, DraftReadinessCard } from "./vault-detail/DraftCards";
import { HistoryTab } from "./vault-detail/HistoryTab";
import { SendPrefill, SendTab } from "./vault-detail/SendTab";
import { SuccessionBanner } from "./vault-detail/SuccessionBanner";
import { UtxosSection } from "./vault-detail/UtxosSection";
import { VaultStructureTree } from "./vault-detail/VaultLeaves";
import { VaultPhaseCard } from "./vault-detail/VaultPhaseCard";
import { blocksToLabel, intervalLabel, isTrusteeRole, roleLabel, satsToBtc } from "./vault-detail/shared";


export default function VaultDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const stateVault = (location.state as { vault?: Vault } | null)?.vault;
  const [vault, setVault] = useState<Vault | null>(stateVault ?? null);

  // Compiling a draft navigates here again with the compiled vault in
  // state; the router keeps this same component, so take the new vault
  // (and remount below), or the address gate would never see it.
  useEffect(() => {
    if (stateVault && stateVault !== vault) setVault(stateVault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateVault]);

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
  // Nothing of the vault is shown until this phone has re-derived its
  // address from its descriptor and found it equal (VaultAddressGate).
  return (
    <VaultAddressGate key={`${vault.id}:${vault.address ?? ""}:${vault.descriptor ?? ""}`} vault={vault} onBack={() => navigate("/vaults")}>
      <VaultDetailInner vault={vault} onBack={() => navigate("/vaults")} />
    </VaultAddressGate>
  );
}

function VaultDetailInner({ vault, onBack }: { vault: Vault; onBack: () => void }) {
  const toast = useToast();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const navigate = useNavigate();
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [tab, setTab] = useState<"overview" | "send" | "history" | "members" | "activity" | "requests" | "messages" | "trust">("overview");
  // Every in-page "go to that tab" button comes through here. The download
  // has no Members or Messages tab (they need other people and our
  // server), so a button that would open them -- "See who can sign" on a
  // nearing inheritance, an activity row -- shows the spending paths on
  // the overview instead: who holds which key, the one-person answer.
  // Every tab change brings the opened tab to the top of the screen
  // (operator, 2026-11-25: "You might have to scroll to a section after you
  // click a button"). Overview goes back to the very top, where the balance is.
  const showTab = useCallback((id: typeof tab) => {
    setTab(id);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (id === "overview") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      const target = document.querySelector("[data-dt-tabs]");
      if (!target) return;
      const bar = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
      window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - bar - 8, behavior: "smooth" });
    }));
  }, []);
  const openTab = useCallback((id: string) => {
    if (DOWNLOAD && (id === "members" || id === "messages" || id === "requests" || id === "trust")) {
      setTab("overview");
      // Land the heading BELOW the sticky top bar, not under it.
      requestAnimationFrame(() => {
        const target = document.querySelector("[data-dt-spending-paths]");
        if (!target) return;
        const bar = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
        window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - bar - 12, behavior: "smooth" });
      });
      return;
    }
    showTab(id as typeof tab);
  }, [showTab]);
  const [archiving, setArchiving] = useState(false);
  const [showRotate, setShowRotate] = useState(false);
  // Bumped when a rotation dialog closes, to remount the overview: its
  // succession banner looks the successor up once on mount, so without
  // this the old vault showed no warning and no Sweep button until the
  // page was reloaded (caught walking the flow, 2026-11-11).
  const [rotationTick, setRotationTick] = useState(0);
  const [showReceive, setShowReceive] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
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
    showTab("send");
  }

  const load = useCallback(async () => {
    const [balRes, propRes] = await Promise.allSettled([
      vault.address
        ? api.vaultBalance(vault)
        : Promise.resolve(null),
      api.proposals.list(vault.id),
    ]);
    if (balRes.status === "fulfilled" && balRes.value) setBalance(balRes.value);
    if (propRes.status === "fulfilled") setProposals(propRes.value.proposals);
  }, [vault]);

  useEffect(() => { void load(); }, [load]);

  // Self-heal for a leaf-list vault compiled before compile-leaves.js
  // wrote key_origins (2026-08-25 fix). No BIP371 tap_key_origins ever
  // got attached to its PSBT inputs, so a real hardware wallet correctly
  // refused to sign it: "Signing with this seed did not add a valid
  // signature." Silent, on load, same spirit as keystore.ts's
  // repairPubkeys() -- recomputes what compile-leaves.js should have
  // written by matching each leaf's own stored pubkey against this
  // browser's local keys, and repairs it server-side. A no-op once
  // key_origins is actually populated, by this repair or a fresh compile.
  useEffect(() => {
    if (!Array.isArray(vault.leaves) || !vault.leaves.length) return;
    if (vault.key_origins && vault.key_origins.length > 0) return;
    const local = listKeys().filter(k => k.status === "active");
    const seen = new Set<string>();
    const origins: { pubkey: string; fingerprint: string; derivation_path: string }[] = [];
    for (const leaf of vault.leaves) {
      for (const keyStr of leaf.keys) {
        const lower = keyStr.toLowerCase();
        if (seen.has(lower)) continue;
        const match = local.find(k => k.pubkey?.toLowerCase() === lower);
        const fp = match?.masterFingerprint ?? match?.fingerprint;
        if (!match || !fp || !match.derivationPath) continue;
        seen.add(lower);
        origins.push({
          pubkey: lower,
          fingerprint: fp,
          derivation_path: match.derivationPath.replace(/\/+$/, "") + "/0/0",
        });
      }
    }
    if (!origins.length) return;
    void api.vaults.repairKeyOrigins(vault.id, origins).catch(() => {});
  }, [vault]);

  // Vault key housekeeping on every open (zero-knowledge plan Z1): the owner
  // creates or replaces it, members share it with whoever lacks it.
  useVaultKey(vault.id);

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
            fontSize: 17,
            cursor: "pointer",
            fontFamily: fonts.sans,
          }}
        >
          Back
        </button>
        <span
          style={{
            fontFamily: fonts.display,
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: "0.12em",
            color: colors.gold,
            // On a very narrow phone the name gives way so Rotate and
            // Delete stay on screen (they ran 32px off the side at 320px).
            minWidth: 0,
            flex: "0 1 auto",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {APP_NAME}
        </span>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {/* Rotating makes the successor vault on our server: not in the
              download yet (lib/download.ts). */}
          {vault.status === "compiled" && vault.bloc_policy == null && !DOWNLOAD && (
            <Button
              variant="ghost"
              size="sm"
              disabled={archiving}
              style={{ fontSize: 16 }}
              onClick={() => setShowRotate(true)}
            >
              Rotate
            </Button>
          )}
        </div>
      </header>
      {showRotate && isLeafListVault(vault) && (
        <RotatePathVault
          vault={vault}
          onClose={() => { setShowRotate(false); setRotationTick(t => t + 1); void load(); }}
          onOpenNew={v => {
            setShowRotate(false);
            navigate(`/vaults/${v.id}`, { state: { vault: v } });
          }}
        />
      )}
      {showRotate && !isLeafListVault(vault) && (
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
        {vault.status === "compiled" && effectiveDuress && (
          <div style={{ marginBottom: 16 }}>
            <HaltVaultBar duress={effectiveDuress} busy={duressBusy} onToggle={toggleDuress} vaultId={vault.id} isOwner={(vault as Vault & { my_role?: string }).my_role === "owner"} />
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
        {/* Balance (docs/screen-cleanse-build-note.md, operator 2026-11-25):
            on Overview, the balance with Send and Receive as the two things
            to do; on every other tab, one line, so the tab's own content is
            what is on screen. */}
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 16,
            padding: tab === "overview" ? "24px 20px" : "12px 16px",
            marginBottom: tab === "overview" ? 20 : 12,
          }}
        >
          <div
            style={{
              fontSize: 15,
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
              fontSize: tab === "overview" ? 36 : 22,
              fontWeight: 700,
              color: colors.text,
              fontFamily: fonts.display,
              margin: tab === "overview" ? "8px 0 4px" : "2px 0 0",
            }}
          >
            {balance ? satsToBtc(balance.total_sats) : "--"}
            <span style={{ fontSize: tab === "overview" ? 18 : 15, color: colors.muted }}> BTC</span>
            {tab !== "overview" && balance?.usd_value != null && (
              <span style={{ fontSize: 15, color: colors.sub, fontFamily: fonts.sans, fontWeight: 400 }}>
                {" "}. ${balance.usd_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </span>
            )}
          </div>
          {tab === "overview" && (
            <>
              {balance?.usd_value != null && (
                <div style={{ fontSize: 18, color: colors.sub, marginBottom: 8 }}>
                  ${balance.usd_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </div>
              )}
              {balance && balance.unconfirmed_sats !== 0 && (
                <div style={{ fontSize: 16, color: colors.orange, marginBottom: 8 }}>
                  + {satsToBtc(balance.unconfirmed_sats)} BTC unconfirmed
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                {vault.status === "draft" ? (
                  // A path-builder draft is finished from its own card below
                  // (PathDraftCard); this button counts planned founders,
                  // which that shape does not have.
                  isLeafListVault(vault) ? null : <DraftCompileButton vault={vault} />
                ) : (
                  <>
                    <Button style={{ flex: 1, padding: "12px", minHeight: 48 }} onClick={() => showTab("send")}>
                      Send
                    </Button>
                    {vault.address && (
                      <Button
                        variant="ghost"
                        style={{ flex: 1, padding: "12px", minHeight: 48 }}
                        onClick={() => setShowReceive(v => !v)}
                      >
                        {showReceive ? "Close" : "Receive"}
                      </Button>
                    )}
                  </>
                )}
              </div>
              {showReceive && vault.address && vault.status !== "draft" && isFreshAddressVault(vault) && <NewReceiveAddress vault={vault} />}
              {showReceive && vault.address && !isFreshAddressVault(vault) && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                  <div style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.text, wordBreak: "break-all" }}>{vault.address}</div>
                  <Button style={{ minHeight: 44, alignSelf: "stretch" }} onClick={() => copy(vault.address!, "addr")}>
                    {copied === "addr" ? "Copied" : "Copy address"}
                  </Button>
                  <QrImage data={vault.address} size={220} />
                  <div style={{ fontSize: 15, color: colors.sub, lineHeight: 1.5 }}>
                    Check that the wallet you send from shows an address ending in{" "}
                    <span style={{ fontFamily: fonts.mono, color: colors.text }}>{vault.address.slice(-8)}</span>.
                    First deposit? Send a small amount, wait until it shows here, then send the rest.
                  </div>
                  <div style={{ fontSize: 15, color: colors.muted, lineHeight: 1.5 }}>
                    This vault has one fixed address, reused for every deposit -- anyone who sees one payment to it can
                    see every payment to it and the eventual full spend. That's the tradeoff for hardware-wallet
                    compatibility; keep that in mind for how you fund it.
                  </div>
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0 16px", marginTop: 12 }}>
                {balance && (
                  <a href={balance.mempool_url} target="_blank" rel="noreferrer" style={{ fontSize: 15, color: colors.muted, minHeight: 44, display: "inline-flex", alignItems: "center" }}>
                    See it on the explorer
                  </a>
                )}
                {/* The halt switch: always one tap away, never above the
                    balance (operator's chip, 2026-11-25). While a hold is on,
                    the red banner at the top of the page says so. */}
                {vault.status === "compiled" && !effectiveDuress && (
                  <HaltVaultBar duress={false} busy={duressBusy} onToggle={toggleDuress} vaultId={vault.id} isOwner={(vault as Vault & { my_role?: string }).my_role === "owner"} />
                )}
              </div>
            </>
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
            <div style={{ fontSize: 17, color: colors.text, lineHeight: 1.5 }}>
              You claimed the <strong>{roleLabel(myMember!.role)}</strong> slot but haven't attached a
              signing key. The vault can't be compiled or signed by you until you do.
            </div>
            <Button size="sm" onClick={() => openTab("members")}>
              Add your key
            </Button>
          </div>
        )}

        {/* Tabs: four, plus More for the rest (operator's chip, 2026-11-25) --
            eight in two wrapped rows buried the one with a badge. */}
        {(() => {
          const all = vault.status === "draft"
            ? [
                { id: "overview", label: "Overview" },
                // Members and Messages need other people and our server:
                // not in the download (lib/download.ts). Trust (members'
                // signed agreements, proof of life) needs them too.
                ...(DOWNLOAD ? [] : [{ id: "members", label: "Members" }, { id: "messages", label: "Messages" }, { id: "trust", label: "Trust" }]),
                { id: "activity", label: "Activity" },
              ]
            : [
                { id: "overview", label: "Overview" },
                { id: "send", label: "Send" },
                { id: "history", label: "History", count: pendingCount },
                ...(DOWNLOAD ? [] : [{ id: "members", label: "Members" }]),
                // Requests (a beneficiary asking for funds) needs other
                // people and our server too.
                ...(DOWNLOAD ? [] : [{ id: "requests", label: "Requests" }, { id: "messages", label: "Messages" }, { id: "trust", label: "Trust" }]),
                { id: "activity", label: "Activity" },
              ];
          const primary = all.slice(0, vault.status === "draft" ? 2 : 4);
          const more = all.slice(primary.length);
          const inMore = more.some(t => t.id === tab);
          const tabStyle = (active: boolean) => ({
            flex: "1 1 auto",
            minWidth: 0,
            minHeight: 44,
            padding: "8px 4px",
            border: "none",
            fontSize: 16,
            cursor: "pointer",
            fontFamily: fonts.sans,
            background: active ? colors.input : "transparent",
            color: active ? colors.text : colors.muted,
            borderBottom: active ? `2px solid ${colors.gold}` : "2px solid transparent",
            borderTopLeftRadius: 6,
            borderTopRightRadius: 6,
            marginBottom: -1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            whiteSpace: "nowrap" as const,
          });
          const badge = (n?: number) => n != null && n > 0 && (
            <span style={{ background: colors.orange, color: colors.bg, fontSize: 14, fontWeight: 700, borderRadius: 10, padding: "1px 6px" }}>{n}</span>
          );
          return (
            <div data-dt-tabs style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", columnGap: 2, borderBottom: `1px solid ${colors.border}` }}>
                {primary.map(t => (
                  <button key={t.id} onClick={() => { setMoreOpen(false); showTab(t.id as typeof tab); }} style={tabStyle(tab === t.id && !moreOpen)}>
                    {t.label}
                    {badge((t as { count?: number }).count)}
                  </button>
                ))}
                {more.length > 0 && (
                  <button onClick={() => setMoreOpen(v => !v)} style={tabStyle(inMore || moreOpen)} aria-expanded={moreOpen}>
                    {inMore && !moreOpen ? more.find(t => t.id === tab)?.label : "More"}
                  </button>
                )}
              </div>
              {moreOpen && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 10 }}>
                  {more.map(t => (
                    <Button
                      key={t.id}
                      variant={tab === t.id ? "primary" : "ghost"}
                      size="sm"
                      style={{ fontSize: 16, minHeight: 44, flex: "1 1 40%" }}
                      onClick={() => { setMoreOpen(false); showTab(t.id as typeof tab); }}
                    >
                      {t.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {tab === "overview" && (
          <OverviewTab
            key={rotationTick}
            vault={vault}
            copy={copy}
            copied={copied}
            onSendPrefill={prefillSend}
            proposals={proposals}
            onOpenTab={openTab}
            coinsKey={`${balance?.total_sats ?? ""}:${balance?.utxo_count ?? ""}`}
            balance={balance}
            onReloadBalance={() => { void load(); }}
          />
        )}
        {tab === "overview" && (
          // Delete lives at the bottom, away from everyday buttons
          // (operator's chip, 2026-11-25); it still asks for the name.
          <div style={{ marginTop: 32, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.08em", color: colors.muted, marginBottom: 8 }}>
              REMOVE THIS VAULT
            </div>
            <Button variant="danger" size="sm" style={{ fontSize: 16, minHeight: 44 }} disabled={archiving} onClick={() => void deleteVault()}>
              Delete vault
            </Button>
          </div>
        )}
        {tab === "send" && (
          <SendTab
            vault={duressOverride === null ? vault : { ...vault, duress: duressOverride }}
            balance={balance}
            prefill={sendPrefill}
            onPickCoins={prefillSend}
            onDone={() => { setSendPrefill(null); void load(); showTab("history"); }}
          />
        )}
        {tab === "history" && (
          <HistoryTab vault={vault} proposals={proposals} onRefresh={load} />
        )}
        {tab === "members" && !DOWNLOAD && <MembersTab vault={vault} />}
        {tab === "activity" && (
          <ActivityTab vault={vault} onOpenTab={openTab} />
        )}
        {tab === "requests" && !DOWNLOAD && <RequestsTab vault={vault} onSendPrefill={prefillSend} />}
        {tab === "messages" && !DOWNLOAD && <MessagesTab vault={vault} />}
        {tab === "trust" && !DOWNLOAD && <TrustTab vault={vault} />}
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
  coinsKey,
  balance,
  onReloadBalance,
}: {
  vault: Vault;
  copy: (text: string, id: string) => void;
  copied: string | null;
  onSendPrefill: (p: SendPrefill) => void;
  proposals: Proposal[];
  onOpenTab: (id: string) => void;
  /** Changes when the balance reloads, so the coins card refreshes too. */
  coinsKey?: string;
  balance?: BalanceResult | null;
  /** Reload the balance (after the coin-lookup server changed). */
  onReloadBalance?: () => void;
}) {
  // Ranged slice 6: a vault with a new address every time shows, copies and
  // QR-codes the descriptor of EVERY address (<0;1>/*) -- what a wallet or
  // SeedSigner must register -- never the one-address form.
  const shownDescriptor = vault.descriptor_version === 2 ? (vault.descriptor_multipath ?? null) : vault.descriptor;
  const toast = useToast();
  // Reports are built on this device from the vault's rows, opened with the
  // vault key (zero-knowledge storage); the server never renders them.
  const [reportBusy, setReportBusy] = useState(false);
  async function runReport(make: () => Promise<boolean>) {
    if (reportBusy) return;
    setReportBusy(true);
    try {
      await make();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the report");
    } finally {
      setReportBusy(false);
    }
  }
  const askPrompt = usePrompt();
  const navigate = useNavigate();
  const isBloc = vault.bloc_policy != null;

  // A custom leaf-list vault never populates founder_keys/heir_keys/
  // recovery_after/inheritance_after at all -- those columns sit at their
  // bare DB defaults (founder_quorum 2, founder_keys [], recovery_after
  // 26000, etc.), the exact same discriminator VaultPhaseCard/
  // VaultStructureTree/buildVaultLeaves already use. Those two components
  // are already gated `{!plain && ...}` below and correctly show this
  // vault's real per-leaf spending paths; the legacy `paths`/"Details"
  // block further down was never given the same gate, so a leaf-list
  // vault showed BOTH the correct leaf-aware summary above AND a bogus
  // "2 of 0 trustee signatures" / "Recovery unlocks at block 26,000"
  // block below it, reading straight off the unpopulated named-field
  // defaults. Operator, pasting the live page: the "PATH 1/2/3" and
  // "Details" block under the correct VaultStructureTree output showed
  // exactly that -- "2 of 0", "after 0 blocks", "unlocks at block
  // 26,000" for a vault whose real leaves are "Everyday signers 1 of 1"
  // and "Path 2 1 of 1 after ~6 months."
  const isLeafList = Array.isArray(vault.leaves) && vault.leaves.length > 0;

  // Inheritance vaults get all three spending paths; plain vaults
  // (no heirs, no timelocks) get only the trustee-now path.
  const plain =
    (vault.heir_keys?.length ?? 0) === 0 &&
    vault.recovery_after === 0 &&
    vault.inheritance_after === 0;

  const [showDescriptorQr, setShowDescriptorQr] = useState(false);
  const [showBackups, setShowBackups] = useState(false);

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
          // The date is fixed in the vault's script. It used to say here
          // "Triggered only if the trustees are unreachable for the full
          // window", which is false for an absolute timelock: nothing
          // anyone does or does not do moves it (see lib/timelock-words.ts).
          title: "Inheritance - " + (chainTip == null ? "checking the chain..." : opensWords(vault.inheritance_after, chainTip, new Date())),
          body:
            chainTip != null && chainTip >= vault.inheritance_after
              ? `Open now: ${vault.heir_quorum} of ${vault.heir_keys.length} successors can spend without the trustees.`
              : `${vault.heir_quorum} of ${vault.heir_keys.length} successor signatures, from block ${vault.inheritance_after.toLocaleString()}. It opens on that date whatever happens before it -- it does not wait for anyone to go silent. To keep it closed longer, the trustees rotate the vault and move the coins before then.`,
        },
      ];

  // Draft vaults have no address yet and no timelocks to countdown
  // on, so short-circuit the usual overview and show the onboarding
  // roster + one-shot-compile education instead.
  if (vault.status === "draft") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <RemindersBanner vaultId={vault.id} />
        {/* A path-builder draft has its own card: the older one counts
            planned founders, which this shape does not have. The trust
            document describes every path, so it is the owner's to see
            until the vault is finalized. */}
        {isLeafList ? <PathDraftCard vault={vault} /> : <DraftReadinessCard vault={vault} onOpenTab={onOpenTab} />}
        {(!isLeafList || (vault as Vault & { my_role?: string }).my_role === "owner") && <TrustDocSection vault={vault} />}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* What needs the person comes first (operator, 2026-11-25: "the right
          attention ... at the right time"; docs/screen-cleanse-build-note.md),
          then the coins and when each path opens for each one. */}
      <RemindersBanner vaultId={vault.id} />
      <SuccessionBanner vault={vault} onSendPrefill={onSendPrefill} />
      <ActionGuide
        vault={vault}
        proposals={proposals}
        onOpenTab={onOpenTab}
        onSendPrefill={onSendPrefill}
      />
      {vault.status !== "draft" && (
        <>
          <UtxosSection vault={vault} onSendPrefill={onSendPrefill} refreshKey={coinsKey} balance={balance} />
          {/* Which server looks the coins up, and the person's own Electrum
              server (docs/chain-lookups-build-note.md). */}
          <ElectrumServerSettings network={vault.network} source={balance?.source} onChanged={() => onReloadBalance?.()} />
        </>
      )}
      {!plain && <VaultPhaseCard vault={vault} />}
      {!plain && <VaultStructureTree vault={vault} />}
      <TrustDocSection vault={vault} />
      {/* Stipends and distribution wallets are kept by our server and
          paid to other people: not in the download (lib/download.ts). */}
      {!DOWNLOAD && <StipendsSection vault={vault} onSendPrefill={onSendPrefill} />}
      {!DOWNLOAD && <DistributionWalletsSection vault={vault} onSendPrefill={onSendPrefill} />}
      {/* Spending paths + Details: named-field vault only -- a leaf-list
          vault's real paths are already shown above by VaultStructureTree
          (and its phase by VaultPhaseCard), built from the real vault.leaves
          array. Rendering this block too for a leaf-list vault would read
          straight off its unpopulated founder_keys/heir_keys/recovery_after/
          inheritance_after defaults -- see isLeafList's header comment. */}
      {!isLeafList && (
        <>
          <span data-dt-spending-paths />
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
                  fontSize: 14,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  color: p.color,
                  marginBottom: 4,
                }}
              >
                PATH {p.num}
              </div>
              <div style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
                {p.title}
              </div>
              <div style={{ fontSize: 16, color: colors.sub, lineHeight: 1.5 }}>{p.body}</div>
            </div>
          ))}

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
                <span style={{ fontSize: 17, color: colors.muted }}>{k}</span>
                <span style={{ fontSize: 17, color: colors.text }}>{v}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Backups and exports (operator, 2026-11-25: "cluttered from all the
          building"): closed until asked for. The fingerprint stays in view --
          it is the one thing to write down. */}
      <div
        data-dt-backups
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: colors.muted,
            }}
          >
            BACKUPS AND EXPORTS
          </span>
          <Button variant="ghost" size="sm" style={{ fontSize: 15, minHeight: 44 }} onClick={() => setShowBackups(v => !v)}>
            {showBackups ? "Hide" : "Show"}
          </Button>
        </div>
        {shownDescriptor && (
          <div
            style={{
              marginTop: 12,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              padding: "8px 14px",
              border: `1px solid ${colors.gold}`,
              borderRadius: radii.md,
            }}
          >
            <span style={{ fontSize: 14, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Descriptor fingerprint
            </span>
            <span style={{ fontSize: 18, color: colors.gold, fontFamily: fonts.mono, letterSpacing: 2 }}>
              {formatDescriptorFingerprint(shownDescriptor)}
            </span>
            <span style={{ fontSize: 14, color: colors.muted, textAlign: "center", maxWidth: 380 }}>
              Write this down separately (paper, not this screen). Before trusting a
              descriptor on a signer or a re-downloaded backup, recompute its
              fingerprint and compare -- a mismatch means don't sign.
            </span>
          </div>
        )}
        {showBackups && (
          <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-start", marginBottom: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 15, whiteSpace: "normal" }}
              disabled={!shownDescriptor}
              onClick={() => shownDescriptor && copy(shownDescriptor, "desc")}
            >
              {copied === "desc" ? "Copied" : "Copy descriptor"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 15, whiteSpace: "normal" }}
              onClick={() => void downloadVault(vault)}
            >
              Download backup
            </Button>
            {/* The PDFs, tax summary, activity export and sealed record read
                their data from our server; Legacy recovery looks the address up on a
                public explorer. None of them in the download yet. */}
            {!DOWNLOAD && (
              <Button
                variant="ghost"
                size="sm"
                style={{ padding: "3px 9px", fontSize: 15, whiteSpace: "normal" }}
                disabled={vault.status !== "compiled"}
                onClick={() => void runReport(() => downloadVaultPdf(vault.id))}
              >
                Download PDF
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              style={{ padding: "3px 9px", fontSize: 15, whiteSpace: "normal" }}
              disabled={!shownDescriptor}
              onClick={() => setShowDescriptorQr(v => !v)}
            >
              {showDescriptorQr ? "Hide QR" : "Show descriptor QR"}
            </Button>
            {!DOWNLOAD && (
              <Button
                variant="ghost"
                size="sm"
                style={{ padding: "3px 9px", fontSize: 15, whiteSpace: "normal" }}
                disabled={!shownDescriptor}
                onClick={() => navigate(`/vaults/${vault.id}/legacy-recovery`)}
              >
                Legacy recovery setup
              </Button>
            )}
            {!DOWNLOAD && (
              <Button
                variant="ghost"
                size="sm"
                style={{ padding: "3px 9px", fontSize: 15, whiteSpace: "normal" }}
                onClick={() => navigate(`/vaults/${vault.id}/record`, { state: { vaultName: vault.name } })}
              >
                Sealed record
              </Button>
            )}
            {!DOWNLOAD && (
              <Button
                variant="ghost"
                size="sm"
                style={{ padding: "3px 9px", fontSize: 15, whiteSpace: "normal" }}
                onClick={() => void runReport(() => downloadAuditPdf(vault.id))}
              >
                Audit PDF
              </Button>
            )}
            {!DOWNLOAD && (
              <Button
                variant="ghost"
                size="sm"
                style={{ padding: "3px 9px", fontSize: 15, whiteSpace: "normal" }}
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
                  await runReport(() => downloadTaxSummary(vault.id, year));
                }}
              >
                Tax summary
              </Button>
            )}
            {!DOWNLOAD && (
              <Button
                variant="ghost"
                size="sm"
                style={{ padding: "3px 9px", fontSize: 15, whiteSpace: "normal" }}
                onClick={() => void runReport(() => downloadActivityJson(vault.id))}
              >
                Activity JSON
              </Button>
            )}
        </div>
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 14,
            color: colors.sub,
            wordBreak: "break-all",
            lineHeight: 1.6,
          }}
        >
          {shownDescriptor}
        </div>
        {showDescriptorQr && shownDescriptor && (
          <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
            <DescriptorQr descriptor={shownDescriptor} label="Descriptor QR" size={240} />
          </div>
        )}
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
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.08em", color: colors.muted, marginBottom: 10 }}>
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
            <span style={{ fontSize: 17, color: colors.muted }}>{k}</span>
            <span style={{ fontSize: 17, color: colors.text }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Descriptor */}
      <div style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.08em", color: colors.muted }}>DESCRIPTOR</span>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="ghost" size="sm" style={{ padding: "3px 9px", fontSize: 15 }} disabled={!vault.descriptor} onClick={() => vault.descriptor && copy(vault.descriptor, "desc")}>
              {copied === "desc" ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" size="sm" style={{ padding: "3px 9px", fontSize: 15 }} onClick={() => void downloadVault(vault)}>
              Download backup
            </Button>
            <Button variant="ghost" size="sm" style={{ padding: "3px 9px", fontSize: 15 }} disabled={!vault.descriptor} onClick={() => setShowDescriptorQr(v => !v)}>
              {showDescriptorQr ? "Hide QR" : "Show QR"}
            </Button>
          </div>
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.sub, wordBreak: "break-all", lineHeight: 1.6 }}>
          {vault.descriptor}
        </div>
        {vault.descriptor && (
          <div
            style={{
              marginTop: 12,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              padding: "8px 14px",
              border: `1px solid ${colors.gold}`,
              borderRadius: radii.md,
            }}
          >
            <span style={{ fontSize: 14, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Descriptor fingerprint
            </span>
            <span style={{ fontSize: 18, color: colors.gold, fontFamily: fonts.mono, letterSpacing: 2 }}>
              {formatDescriptorFingerprint(vault.descriptor)}
            </span>
            <span style={{ fontSize: 14, color: colors.muted, textAlign: "center", maxWidth: 380 }}>
              Write this down separately (paper, not this screen). Before trusting a
              descriptor on a signer or a re-downloaded backup, recompute its
              fingerprint and compare -- a mismatch means don't sign.
            </span>
          </div>
        )}
        {showDescriptorQr && vault.descriptor && (
          <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
            <DescriptorQr descriptor={vault.descriptor} label="Descriptor QR" size={240} />
          </div>
        )}
      </div>
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

  if (loading) return <p style={{ color: colors.muted, fontSize: 17 }}>Loading members...</p>;
  if (err) return <p style={{ color: colors.red, fontSize: 17 }}>{err}</p>;

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
          vaultMultipath={vault.descriptor_version === 2 ? vault.descriptor_multipath : null}
          changeVault={vault}
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
            fontSize: 17,
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
              fontSize: 15,
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
          <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>
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
            vaultCompiled={vault.status !== "draft"}
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
            fontSize: 16,
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
              fontSize: 17,
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
                const url = inviteLink(inv.token, { vaultName: vault.name, label: inv.invited_label ?? undefined });
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
            setRecentLink(inviteLink(invite.token, { vaultName: vault.name, label: invite.invited_label ?? undefined }));
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

// The vault's own signing keys (as pubkey hex) that this browser holds a
// local key for. The owner's member row carries no key of its own when the
// keys went straight into the vault (the path builder, and the standard
// wizard's direct keys), so "no key on your row" is not "you can't sign":
// what decides it is whether any of the vault's keys are here.
function vaultKeysHeldHere(vault: Vault): { held: number; total: number } {
  const all = new Set<string>();
  const add = (x: unknown) => {
    if (typeof x !== "string") return;
    if (/^0[23][0-9a-fA-F]{64}$/.test(x)) { all.add(x.toLowerCase()); return; }
    try { all.add(pubkeyFromXpub(x).toLowerCase()); } catch { /* not a key */ }
  };
  for (const leaf of vault.leaves ?? []) {
    leaf.keys.forEach(add);
    (leaf.required_keys ?? []).forEach(add);
  }
  for (const list of [vault.founder_keys, vault.heir_keys, vault.backup_keys, vault.second_heir_keys, vault.consent_keys]) {
    (list ?? []).forEach(add);
  }
  vault.bloc_policy?.parent_pubkeys.forEach(add);
  vault.bloc_policy?.kid_pubkeys.forEach(add);
  const here = new Set(
    listKeys().filter(k => k.status === "active" && k.origin !== "tapit").map(k => k.pubkey.toLowerCase()),
  );
  let held = 0;
  for (const pk of all) if (here.has(pk)) held++;
  return { held, total: all.size };
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
  // The owner who put the keys straight into the vault: say how many of
  // them are on this device instead of "no key yet" (signet walk
  // 2026-11-19: the dashboard said "You can sign now" while this card said
  // the opposite, for keys generated in this very browser).
  const ownerKeys = !hasKey && me.role === "owner" ? vaultKeysHeldHere(vault) : null;
  if (ownerKeys) {
    const some = ownerKeys.held > 0;
    return (
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderLeft: `3px solid ${some ? colors.green : colors.orange}`,
          borderRadius: 12,
          padding: "14px 16px",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: colors.gold, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Your slot
        </div>
        <div style={{ fontSize: 17, color: colors.text, marginTop: 2 }}>
          {me.label ?? "Unnamed"} <span style={{ color: colors.muted }}>({roleLabel(me.role)})</span>
        </div>
        <div style={{ fontSize: 16, color: some ? colors.sub : colors.orange, marginTop: 4 }}>
          {some
            ? `${ownerKeys.held} of this vault's ${ownerKeys.total} keys ${ownerKeys.held === 1 ? "is" : "are"} on this device -- you can sign with ${ownerKeys.held === 1 ? "it" : "them"} here.`
            : `None of this vault's ${ownerKeys.total} keys are on this device. To sign here, restore one in Keys, or sign with the hardware wallet that holds it.`}
        </div>
      </div>
    );
  }
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
        <div style={{ fontSize: 15, fontWeight: 700, color: colors.gold, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Your slot
        </div>
        <div style={{ fontSize: 17, color: colors.text, marginTop: 2 }}>
          {me.label ?? "Unnamed"} <span style={{ color: colors.muted }}>({roleLabel(me.role)})</span>
        </div>
        <div style={{ fontSize: 16, color: hasKey ? colors.sub : colors.orange, marginTop: 4 }}>
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
      }, vault.id);
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
          ...PANEL_FIT,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
          {me.xpub ? "Change your key" : "Add your key"}
        </div>
        <p style={{ fontSize: 17, color: colors.sub, lineHeight: 1.5, marginBottom: 14 }}>
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
              fontSize: 17,
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
                  fontSize: 17,
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
  vaultCompiled,
  onRemove,
}: {
  member: VaultMember;
  /** The owner's own row carries no key when the keys went straight into
   *  the vault, so on a compiled vault it is not "no key yet". */
  vaultCompiled?: boolean;
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
        <div style={{ fontSize: 17, fontWeight: 500, color: colors.text }}>
          {tapitName ?? m.label ?? "Unnamed"}
          {tapitName && m.label && tapitName !== m.label && (
            <span style={{ fontWeight: 400, color: colors.muted }}> ({m.label})</span>
          )}
          {m.role === "owner" && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 14,
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
                fontSize: 14,
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
        <div style={{ fontSize: 15, color: colors.muted }}>
          {roleLabel(m.role)}
          {m.fingerprint
            ? ` / ${m.fingerprint}`
            : m.role === "owner" && vaultCompiled
              // Signet walk 2026-11-19: "Primary trustee / no key yet" on a
              // vault whose 3 keys were all on this device.
              ? " / keys set in the vault"
              : " / no key yet"}
        </div>
      </div>
      {m.role !== "owner" && (
        <Button variant="ghost" size="sm" style={{ fontSize: 16 }} onClick={onRemove}>
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
        <div style={{ fontSize: 17, color: colors.text }}>
          {invite.invited_label ?? "Unnamed"} ({roleLabel(invite.invited_role)})
        </div>
        <div style={{ fontSize: 15, color: colors.muted }}>
          Expires {expires.toLocaleDateString()}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 16 }} onClick={onCopyLink}>
          Copy link
        </Button>
        <Button variant="ghost" size="sm" style={{ fontSize: 16 }} onClick={onCopyCode}>
          Copy code
        </Button>
        <Button variant="danger" size="sm" style={{ fontSize: 16 }} onClick={onRevoke}>
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
          ...PANEL_FIT,
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
                fontSize: 17,
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
          {err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}
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
  // Face ID for messages (operator, 2026-11-13: "Make browser keys Face
  // ID for everything important"). A locked key opens once per visit,
  // on a tap -- Safari only shows Face ID in answer to one.
  // Read live each render; faceTick forces a redraw after a change.
  const [, setFaceTick] = useState(0);
  const keyLocked = messagingKeyLocked();
  const usesFaceId = messagingKeyUsesFaceId();
  const [faceBusy, setFaceBusy] = useState(false);

  useEffect(() => {
    // Ensure local keypair exists before rendering (public half only:
    // never needs Face ID).
    getMessagingPubkey();
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
  // Threat model E: every OTHER member's messaging key against the one this
  // phone first saw (lib/messaging-safety.ts). A changed key pauses sending
  // to them until the safety code is compared by voice.
  const [safetyTick, setSafetyTick] = useState(0);
  const peers = useMemo<PeerKey[]>(() => {
    void safetyTick;
    if (!myUserId) return [];
    const seen = new Set<string>();
    return members
      .filter(m => m.status === "active" && m.user_id && m.messaging_pubkey)
      .filter(m => m.user_id !== myUserId && !seen.has(m.user_id) && seen.add(m.user_id))
      .map(m => ({ member: m, pubkey: m.messaging_pubkey!, status: peerKeyStatus(vault.id, m.user_id, m.messaging_pubkey!) }));
  }, [members, myUserId, vault.id, safetyTick]);
  const pausedIds = new Set(peers.filter(p => p.status === "changed").map(p => p.member.user_id));
  const sendable = keyedMembers.filter(m => !pausedIds.has(m.user_id));

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !myUserId) return;
    setBusy(true);
    try {
      // Never to a member whose key changed and has not been checked again.
      const recipients = sendable
        .filter(m => m.messaging_pubkey)
        .map(m => ({ user_id: m.user_id, pubkey: m.messaging_pubkey! }));
      if (recipients.length === 0) {
        toast.error("No members have published a messaging key yet.");
        return;
      }
      if (messagingKeyLocked()) { await unlockMessagingKey(); setFaceTick(n => n + 1); }
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
    regenerateMessagingKey();
    setFaceTick(n => n + 1);
    setShowKeyReset(false);
    setKeyBackupRefresh(n => n + 1);
    void load();
  }

  async function faceId(action: "unlock" | "lock" | "off") {
    setFaceBusy(true);
    try {
      if (action === "unlock") await unlockMessagingKey();
      if (action === "lock") {
        await lockMessagingKey();
        toast.success("Your messages are now locked with Face ID.");
      }
      if (action === "off") {
        if (!(await askConfirm({ title: "Stop using Face ID for messages", message: "Your messaging key will be kept in this browser without Face ID again. Anyone who can open this browser could read your messages.", confirmLabel: "Stop using Face ID" }))) return;
        await unlockMessagingKeyForGood();
        toast.success("Messages no longer need Face ID.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Face ID did not work");
    } finally {
      setFaceTick(n => n + 1);
      setFaceBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {keyLocked && (
        <div style={{ padding: "12px 14px", background: colors.surface, border: `1px solid ${colors.gold}55`, borderRadius: radii.md, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 17, color: colors.text, lineHeight: 1.5 }}>
            Your messages are locked with Face ID. Unlock them to read and send on this visit.
          </div>
          <Button style={{ minHeight: 44 }} disabled={faceBusy} onClick={() => void faceId("unlock")}>
            {faceBusy ? "Waiting for Face ID..." : "Unlock messages with Face ID"}
          </Button>
        </div>
      )}
      <div
        style={{
          padding: "10px 12px",
          background: colors.gold + "0C",
          border: `1px solid ${colors.gold}33`,
          borderRadius: radii.sm,
          fontSize: 16,
          color: colors.sub,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: colors.gold }}>End-to-end encrypted.</strong> Messages are sealed to each recipient's X25519 key before they leave your browser. The server stores ciphertext only and cannot read them.
      </div>

      <MessagingSafetyPanel vaultId={vault.id} peers={peers} onChanged={() => setSafetyTick(n => n + 1)} />

      <MessagingKeyBackupPanel refreshToken={keyBackupRefresh} onRestored={() => { setFaceTick(n => n + 1); void load(); }} />

      {pendingMembers.length > 0 && (
        <div
          style={{
            padding: "8px 12px",
            background: colors.orange + "0C",
            border: `1px solid ${colors.orange}33`,
            borderRadius: radii.sm,
            fontSize: 16,
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
          placeholder={`Message to ${sendable.length} member${sendable.length === 1 ? "" : "s"}...`}
        />
        {keyedMembers.length === 0 && (
          <div style={{ fontSize: 16, color: colors.orange, lineHeight: 1.5 }}>
            {pendingMembers.length > 0
              ? `Can't send yet -- ${pendingMembers.length} member${pendingMembers.length === 1 ? " hasn't" : "s haven't"} opened this vault to publish a messaging key. Messages are end-to-end encrypted to each recipient, so everyone must visit the vault once first.`
              : "No other members can receive messages yet. Invite co-signers from the Members tab; each publishes a messaging key the first time they open the vault."}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 15, color: colors.muted }}>
            {sendable.length} recipient{sendable.length === 1 ? "" : "s"}
            {pausedIds.size > 0 ? ` (${pausedIds.size} paused: key changed)` : ""}
            {pendingMembers.length > 0 && keyedMembers.length > 0
              ? ` (${pendingMembers.length} not ready)`
              : ""}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              style={{ fontSize: 15 }}
              onClick={() => setShowKeyReset(s => !s)}
            >
              {showKeyReset ? "Cancel" : "Key settings"}
            </Button>
            <Button type="submit" disabled={busy || !draft.trim() || sendable.length === 0}>
              {busy ? "Sending..." : "Send"}
            </Button>
          </div>
        </div>
        {showKeyReset && (
          <div
            style={{
              fontSize: 15,
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
                style={{ fontSize: 15 }}
                onClick={rekey}
              >
                Regenerate key
              </Button>
              <span style={{ marginLeft: 8 }}>Deletes your local private key. Past messages become unreadable.</span>
            </div>
            {usesFaceId ? (
              <div style={{ marginTop: 10 }}>
                <span style={{ display: "block", marginBottom: 6 }}>Locked with Face ID: reading messages on this phone needs your face once per visit.</span>
                <Button variant="ghost" size="sm" type="button" style={{ fontSize: 15, minHeight: 44 }} disabled={faceBusy} onClick={() => void faceId("off")}>
                  Stop using Face ID for messages
                </Button>
              </div>
            ) : passkeysAvailable() ? (
              <div style={{ marginTop: 10 }}>
                <span style={{ display: "block", marginBottom: 6 }}>Lock your messaging key with Face ID, so this phone needs your face before it can read your messages. Keep your passphrase backup above too: Face ID stays with this phone and your iCloud passkeys.</span>
                <Button size="sm" type="button" style={{ fontSize: 15, minHeight: 44 }} disabled={faceBusy} onClick={() => void faceId("lock")}>
                  {faceBusy ? "Waiting for Face ID..." : "Lock messages with Face ID"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </form>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 17, color: colors.muted, textAlign: "center", padding: "24px 0" }}>
            No messages yet. Trustees + beneficiaries use this thread for off-chain coordination -- visible only to vault members.
          </div>
        )}
        {messages.map(m => {
          const plaintext = myUserId ? decryptMessage(m, myUserId) : null;
          const sender = members.find(mem => mem.user_id === m.sender_user_id);
          const senderLabel = sender?.label || "(unknown)";
          const mine = m.sender_user_id === myUserId;
          // Threat model E: a message sealed with a key other than the one
          // this phone remembers for its sender is labelled, not hidden.
          const keyMismatch = !mine && senderKeyMatches(vault.id, m.sender_user_id, m.sender_pubkey) === false;
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
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: colors.muted, marginBottom: 4 }}>
                <span>
                  <strong style={{ color: mine ? colors.gold : colors.text }}>{senderLabel}</strong>
                  {sender?.role ? ` . ${sender.role}` : ""}
                </span>
                <span>{new Date(m.created_at).toLocaleString()}</span>
              </div>
              {keyMismatch && (
                <div style={{ fontSize: 15, color: colors.red, lineHeight: 1.5, marginBottom: 4 }}>
                  Sent with a different key than the one this phone knows for {senderLabel}. Do not act on it until you have
                  compared your safety code with them by voice.
                </div>
              )}
              <div style={{ fontSize: 17, color: colors.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {plaintext !== null ? plaintext : (
                  <span style={{ color: colors.muted, fontStyle: "italic" }}>
                    {keyLocked && m.recipients.some((r: { user_id: string }) => r.user_id === myUserId)
                      ? "(locked -- unlock your messages with Face ID above)"
                      : m.recipients.some(r => r.user_id === myUserId)
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

  if (loading) return <p style={{ color: colors.muted, fontSize: 17 }}>Loading activity...</p>;
  if (err) return <p style={{ color: colors.red, fontSize: 17 }}>{err}</p>;
  if (events.length === 0)
    return <p style={{ color: colors.muted, fontSize: 17 }}>No activity yet.</p>;

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
      <div style={{ fontSize: 16, color: colors.muted, marginBottom: 10, lineHeight: 1.5 }}>
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
  if (["invite_created", "invite_revoked", "member_joined", "member_removed", "key_confirmed", "grant_sent", "grant_accepted", "grant_declined", "grant_left"].includes(e.event_type)) {
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
          fontSize: 17,
          fontWeight: 700,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, color: colors.text }}>{title}</div>
        <div style={{ fontSize: 15, color: colors.muted, marginTop: 2 }}>
          {new Date(event.created_at).toLocaleString()}
        </div>
      </div>
      {clickable && (
        <div style={{ color: colors.muted, fontSize: 17, alignSelf: "center", flexShrink: 0 }}>
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
    case "signed": {
      // Since 2026-11-12 a signature is sealed with the signer's role and
      // the capacity their key signed in on the path.
      const as = Array.isArray(meta.signed_as) ? (meta.signed_as as { as?: string | null }[]) : [];
      const how = as.some(a => a.as === "must_sign") ? " with a must-sign key"
        : as.some(a => a.as === "consent") ? " as a consenting key"
        : "";
      const role = typeof meta.role === "string" ? ` (${meta.role})` : "";
      return { icon: "S", title: `${actor}${role} signed${how}`, color: colors.gold };
    }
    case "key_confirmed":
      return { icon: "K", title: `${actor} confirmed a member's key`, color: colors.green };
    case "invite_revoked":
      return { icon: "x", title: `${actor} withdrew an invite (${String(meta.role ?? "member")})`, color: colors.muted };
    case "grant_sent":
      return { icon: "i", title: `${actor} offered membership to ${String(meta.recipient_label ?? "a member")}`, color: colors.blue };
    case "grant_accepted":
      return { icon: "@", title: `${String(meta.recipient_label ?? "A member")} accepted membership`, color: colors.green };
    case "grant_declined":
      return { icon: "x", title: `${String(meta.recipient_label ?? "A member")} declined membership`, color: colors.muted };
    case "grant_left":
      return { icon: "-", title: `${String(meta.recipient_label ?? "A member")} stepped away`, color: colors.red };
    case "duress_raised":
      return { icon: "!", title: `${actor} raised the duress alarm`, color: colors.red };
    case "duress_cleared":
      return { icon: "o", title: `${actor} cleared the duress alarm`, color: colors.orange };
    case "halt_on":
      return { icon: "!", title: `${actor} halted the vault -- signing paused`, color: colors.red };
    case "halt_off":
      return { icon: "o", title: `${actor} lifted the halt`, color: colors.green };
    case "vault_renamed":
      return { icon: "N", title: `${actor} renamed the vault${meta.to ? ` to "${String(meta.to)}"` : ""}`, color: colors.sub };
    case "vault_archived":
      return { icon: "A", title: `${actor} archived the vault`, color: colors.muted };
    case "vault_unarchived":
      return { icon: "A", title: `${actor} brought the vault back from the archive`, color: colors.sub };
    case "trust_doc_updated":
      return { icon: "T", title: `${actor} changed the trust document`, color: colors.orange };
    case "key_label_changed":
      return { icon: "K", title: `${actor} renamed a key${meta.to ? ` to "${String(meta.to)}"` : ""}`, color: colors.sub };
    case "key_origins_repaired":
      return { icon: "K", title: `${actor} changed a key's hardware wallet details`, color: colors.orange };
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
      // Same plain words as the sealed record page, never the raw event
      // name (operator's screenshot showed "Owner: message_sent").
      return { icon: "*", title: `${actor}: ${ledgerEventWords(e.event_type)}`, color: colors.sub };
  }
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
  // Kept as raw text, not a number: a fully-controlled number input bound
  // straight to a number state snaps back to that number the instant the
  // field is empty (Number('') || 0 equals whatever it already was), so
  // backspacing to retype a new value never actually clears the field.
  // Text state lets it sit empty mid-edit; the numeric value used below
  // just treats "not yet hydrated" or "currently empty" as 0.
  const [recoveryOffsetText, setRecoveryOffsetText] = useState<string | null>(null);
  const [inheritanceOffsetText, setInheritanceOffsetText] = useState<string | null>(null);
  const recoveryOffset = recoveryOffsetText ? Number(recoveryOffsetText) || 0 : 0;
  const inheritanceOffset = inheritanceOffsetText ? Number(inheritanceOffsetText) || 0 : 0;

  useEffect(() => {
    if (tip == null) return;
    if (recoveryOffsetText == null) setRecoveryOffsetText(String(offsetFromAbs(vault.recovery_after)));
    if (inheritanceOffsetText == null) setInheritanceOffsetText(String(offsetFromAbs(vault.inheritance_after)));
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
          recovery_after: hasInheritance ? recoveryOffset : 0,
          inheritance_after: hasInheritance ? inheritanceOffset : 0,
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
          ...PANEL_FIT,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, fontFamily: fonts.display, color: colors.text, marginBottom: 6 }}>
          Rotate vault
        </div>
        <div style={{ fontSize: 17, color: colors.muted, lineHeight: 1.5, marginBottom: 16 }}>
          Creates a successor draft that inherits this vault's trust document, members, and shape. A vault's dates are fixed for good, so this is also the only way to push the inheritance date out: choose a later date below, compile the new vault, then move the coins to it. Old and new stay linked in the audit trail.
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
                  value={recoveryOffsetText ?? ''}
                  onChange={e => setRecoveryOffsetText(e.target.value)}
                />
                <div style={{ fontSize: 16, color: colors.sub, marginTop: 4, lineHeight: 1.5 }}>
                  {tip == null ? "Checking the chain..." : rotateDateWords(recoveryOffset, vault.recovery_after, tip, new Date())}
                </div>
              </div>
              <div>
                <Label>Inheritance timelock (blocks from compile)</Label>
                <Input
                  type="number"
                  min={0}
                  value={inheritanceOffsetText ?? ''}
                  onChange={e => setInheritanceOffsetText(e.target.value)}
                />
                <div style={{ fontSize: 16, color: colors.sub, marginTop: 4, lineHeight: 1.5 }}>
                  {tip == null ? "Checking the chain..." : rotateDateWords(inheritanceOffset, vault.inheritance_after, tip, new Date())}
                </div>
                {tip != null && vault.inheritance_after > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {ROTATE_EXTENSIONS.map(x => (
                      <Button
                        key={x.label}
                        type="button"
                        variant="ghost"
                        size="sm"
                        style={{ minHeight: 40 }}
                        onClick={() => setInheritanceOffsetText(String(Math.max(0, vault.inheritance_after - tip) + x.extraBlocks))}
                      >
                        {x.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          <div
            style={{
              padding: "10px 12px",
              background: colors.gold + "0C",
              border: `1px solid ${colors.gold}33`,
              borderRadius: radii.sm,
              fontSize: 16,
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
      }, r.vault_id);
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

  if (loading) return <p style={{ color: colors.muted, fontSize: 17 }}>Loading...</p>;

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
        <div style={{ fontSize: 17, color: colors.muted }}>
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
              fontSize: 17,
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
        <p style={{ color: colors.muted, fontSize: 17 }}>
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
              fontSize: 17,
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
          <span style={{ fontSize: 17, fontWeight: 600, color: colors.text, fontFamily: fonts.display }}>
            {(r.amount_sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0"} BTC
          </span>
          {r.rule_name && (
            <span style={{ color: colors.muted, fontSize: 16, marginLeft: 8 }}>
              via {r.rule_name}
            </span>
          )}
        </div>
        <span
          style={{
            fontSize: 14,
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
      <div style={{ fontSize: 16, color: colors.muted }}>
        Requested by {requesterLabel}
        {r.recipient_name ? ` for ${r.recipient_name}` : ""}
        {" / "}
        {new Date(r.created_at).toLocaleDateString()}
      </div>
      {r.reason && (
        <div style={{ fontSize: 17, color: colors.sub, whiteSpace: "pre-wrap" }}>{r.reason}</div>
      )}
      {r.resolution_note && (
        <div style={{ fontSize: 16, color: colors.muted, fontStyle: "italic" }}>
          Note: {r.resolution_note}
        </div>
      )}
      {r.status === "pending" && (iAmTrustee || iAmRequester) && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          {iAmTrustee && onApprove && (
            <Button size="sm" style={{ fontSize: 16 }} onClick={onApprove}>
              Approve + create proposal
            </Button>
          )}
          {iAmTrustee && onDecline && (
            <Button variant="danger" size="sm" style={{ fontSize: 16 }} onClick={onDecline}>
              Decline
            </Button>
          )}
          {iAmRequester && onCancel && (
            <Button variant="ghost" size="sm" style={{ fontSize: 16 }} onClick={onCancel}>
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
          ...PANEL_FIT,
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
          {err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}
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