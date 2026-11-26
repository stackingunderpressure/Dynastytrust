import { useEffect, useState, useCallback } from "react";
import { PANEL_FIT } from "../components/ui/panelFit";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { DOWNLOAD } from "../lib/download";
import { api, type Vault, type Proposal, type BalanceResult, type VaultMember, type BlocPolicy } from "../lib/api";
import { supabase } from "../lib/supabase";
import { listKeys } from "../lib/keystore";
import { APP_NAME } from "../config";
import { useToast } from "../components/toast";
import { useConfirm, usePrompt } from "../components/dialog";
import { LoadingScreen } from "../components/LoadingScreen";
import { colors, fonts, radii, space } from "../theme";
import { Button, Input, Label } from "../components/ui";
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
import { VaultAddressGate } from "../components/VaultAddressGate";
import { useVaultKey } from "../lib/use-vault-key";
import { downloadActivityJson, downloadAuditPdf, downloadTaxSummary, downloadVaultPdf } from "../lib/reports";
import { getMessagingPubkey } from "../lib/messaging";
import { TrustTab } from "../components/TrustTab";
import { RemindersBanner } from "../components/RemindersBanner";
import { HaltVaultBar } from "../components/HaltVaultBar";
import { CirclePhraseSetup } from "../components/CirclePhraseSetup";
import { SentSecretsPanel } from "../components/SentSecretsPanel";
import { tipHeight } from "../lib/chain";
import { opensWords, rotateDateWords, ROTATE_EXTENSIONS } from "../lib/timelock-words";
import { ElectrumServerSettings } from "../components/ElectrumServerSettings";
import { ActionGuide } from "./vault-detail/ActionGuide";
import { ActivityTab } from "./vault-detail/ActivityTab";
import { DistributionWalletsSection } from "./vault-detail/DistributionWallets";
import { DraftCompileButton, DraftReadinessCard } from "./vault-detail/DraftCards";
import { HistoryTab } from "./vault-detail/HistoryTab";
import { MembersTab } from "./vault-detail/MembersTab";
import { MessagesTab } from "./vault-detail/MessagesTab";
import { RequestsTab } from "./vault-detail/RequestsTab";
import { SendPrefill, SendTab } from "./vault-detail/SendTab";
import { StipendsSection } from "./vault-detail/Stipends";
import { SuccessionBanner } from "./vault-detail/SuccessionBanner";
import { TrustDocSection } from "./vault-detail/TrustDoc";
import { UtxosSection } from "./vault-detail/UtxosSection";
import { VaultStructureTree } from "./vault-detail/VaultLeaves";
import { VaultPhaseCard } from "./vault-detail/VaultPhaseCard";
import { blocksToLabel, roleLabel, satsToBtc } from "./vault-detail/shared";


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