import { useEffect, useState, useCallback } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { DOWNLOAD } from "../lib/download";
import { api, type Vault, type Proposal, type BalanceResult, type VaultMember } from "../lib/api";
import { supabase } from "../lib/supabase";
import { listKeys } from "../lib/keystore";
import { APP_NAME } from "../config";
import { useToast } from "../components/toast";
import { useConfirm, usePrompt } from "../components/dialog";
import { LoadingScreen } from "../components/LoadingScreen";
import { colors, fonts, } from "../theme";
import { Button } from "../components/ui";
import { useRealtimeRefresh } from "../lib/realtime";
import { QrImage } from "../components/QrImage";
import { NewReceiveAddress } from "../components/NewReceiveAddress";
import { isFreshAddressVault } from "../lib/fresh-addresses";
import { RotatePathVault } from "../components/RotatePathVault";
import { pubkeyFromXpub, fingerprintFromXpub } from "../lib/xpub";
import { isLeafListVault } from "../lib/vault-spending-paths";
import { VaultAddressGate } from "../components/VaultAddressGate";
import { useVaultKey } from "../lib/use-vault-key";
import { getMessagingPubkey } from "../lib/messaging";
import { TrustTab } from "../components/TrustTab";
import { HaltVaultBar } from "../components/HaltVaultBar";
import { CirclePhraseSetup } from "../components/CirclePhraseSetup";
import { SentSecretsPanel } from "../components/SentSecretsPanel";
import { ActivityTab } from "./vault-detail/ActivityTab";
import { DraftCompileButton } from "./vault-detail/DraftCards";
import { HistoryTab } from "./vault-detail/HistoryTab";
import { MembersTab } from "./vault-detail/MembersTab";
import { MessagesTab } from "./vault-detail/MessagesTab";
import { OverviewTab } from "./vault-detail/OverviewTab";
import { RequestsTab } from "./vault-detail/RequestsTab";
import { RotateVaultModal } from "./vault-detail/RotateVaultModal";
import { SendPrefill, SendTab } from "./vault-detail/SendTab";
import { roleLabel, satsToBtc } from "./vault-detail/shared";


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