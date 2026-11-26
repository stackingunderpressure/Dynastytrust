import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DOWNLOAD } from "../../lib/download";
import { type Vault, type Proposal, type BalanceResult } from "../../lib/api";
import { useToast } from "../../components/toast";
import { usePrompt } from "../../components/dialog";
import { colors, fonts, radii, } from "../../theme";
import { Button } from "../../components/ui";
import { downloadVault } from "../../lib/descriptor-backup";
import { formatDescriptorFingerprint } from "../../lib/descriptor-fingerprint";
import { DescriptorQr } from "../../components/DescriptorQr";
import { PathDraftCard } from "../../components/PathDraftCard";
import { downloadActivityJson, downloadAuditPdf, downloadTaxSummary, downloadVaultPdf } from "../../lib/reports";
import { RemindersBanner } from "../../components/RemindersBanner";
import { tipHeight } from "../../lib/chain";
import { opensWords } from "../../lib/timelock-words";
import { ElectrumServerSettings } from "../../components/ElectrumServerSettings";
import { ActionGuide } from "./ActionGuide";
import { BlocOverviewTab } from "./BlocOverview";
import { DistributionWalletsSection } from "./DistributionWallets";
import { DraftReadinessCard } from "./DraftCards";
import { SendPrefill } from "./SendTab";
import { StipendsSection } from "./Stipends";
import { SuccessionBanner } from "./SuccessionBanner";
import { TrustDocSection } from "./TrustDoc";
import { UtxosSection } from "./UtxosSection";
import { VaultStructureTree } from "./VaultLeaves";
import { VaultPhaseCard } from "./VaultPhaseCard";
import { blocksToLabel } from "./shared";


// // -- Overview tab

export function OverviewTab({
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
