import { useEffect, useState } from "react";
import { type Vault, type BlocPolicy } from "../../lib/api";
import { colors, fonts, radii, } from "../../theme";
import { Button } from "../../components/ui";
import { downloadVault } from "../../lib/descriptor-backup";
import { formatDescriptorFingerprint } from "../../lib/descriptor-fingerprint";
import { DescriptorQr } from "../../components/DescriptorQr";
import { blocDecayLadder } from "../../lib/blocks";
import { BehaviorTimeline, type SpendLeg } from "../../components/vault-builder";
import { RemindersBanner } from "../../components/RemindersBanner";
import { tipHeight } from "../../lib/chain";
import { SendPrefill } from "./SendTab";
import { UtxosSection } from "./UtxosSection";
import { blocksToLabel } from "./shared";


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
export function BlocOverviewTab({
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
