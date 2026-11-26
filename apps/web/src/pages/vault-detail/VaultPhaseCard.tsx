import { useEffect, useState } from "react";
import { type Vault } from "../../lib/api";
import { colors, fonts, } from "../../theme";
import { tipHeight } from "../../lib/chain";
import { opensWords } from "../../lib/timelock-words";
import { buildVaultLeaves, leafWho, openNowStatus, perCoinWords } from "./leaves";
import { blocksToLabel } from "./shared";


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

  // Generic leaf-list vault -- the fixed owner/founder/heir/beneficiary
  // role script below assumes founder_keys/heir_keys/recovery_after/
  // inheritance_after are real data, which they are not for this shape
  // (same DB-default gap as computePhase/buildVaultLeaves above). A
  // leaf's role isn't one of the fixed enum values either (it's the
  // leaf's own label/id), so give an honest, role-agnostic summary of
  // what's actually open instead of guessing a persona.
  if (Array.isArray(vault.leaves) && vault.leaves.length > 0) {
    const leaves = buildVaultLeaves(vault, tip);
    const available = leaves.filter(openNowStatus);
    const locked = leaves.filter(l => l.status === "locked" && l.absHeight != null);
    const perCoin = leaves.filter(l => l.status === "per_coin");
    const lines: string[] = [];
    lines.push(
      available.length > 0
        ? `Currently spendable: ${available.map(l => `"${l.label}" (${leafWho(l)})`).join(", ")}.`
        : "No spending path is open right now -- every path on this vault is still waiting on its own condition.",
    );
    if (locked.length > 0 && tip != null) {
      const next = locked.sort((a, b) => (a.absHeight ?? 0) - (b.absHeight ?? 0))[0];
      lines.push(`Next to open: "${next.label}", ${opensWords(next.absHeight ?? 0, tip, new Date())}. That date is fixed in the vault: it opens whatever happens before then.`);
    }
    for (const l of perCoin) lines.push(perCoinWords(l));
    return { lines };
  }

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
        `The recovery path opens ${opensWords(vault.recovery_after, t, new Date())} (block ${vault.recovery_after.toLocaleString()}), whether or not anyone signs before then.`,
      );
    } else if (recoveryOpen && vault.recovery_quorum != null && vault.recovery_quorum < vault.founder_quorum) {
      lines.push(`Recovery is OPEN: ${vault.recovery_quorum} of ${vault.founder_keys.length} can sign.`);
    }
    // A founder must hear the inheritance date too: it is fixed, and
    // after it the successors can spend without them.
    if ((vault.heir_keys?.length ?? 0) > 0 && vault.inheritance_after > 0 && tip != null) {
      lines.push(
        inheritanceOpen
          ? `Inheritance is OPEN: ${vault.heir_quorum} of ${vault.heir_keys.length} successors can spend without you now. If that is not what you want, rotate the vault and move the coins today.`
          : `Inheritance opens ${opensWords(vault.inheritance_after, t, new Date())}. After that, ${vault.heir_quorum} of ${vault.heir_keys.length} successors can spend without you, whatever you do. To push it out, rotate the vault and move the coins before then.`,
      );
    }
  } else if (role === "heir") {
    if (inheritanceOpen) {
      lines.push(
        `Inheritance is OPEN. ${vault.heir_quorum} of ${vault.heir_keys.length} successors can spend without the trustees.`,
      );
      cta = "What to do: open Send, choose the Inheritance path, enter the address of a wallet you control, and sign with your key. Each successor signs from their own account. If your key is not on this device, open Keys and restore it from its words first.";
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
  // Generic leaf-list vault -- founder_quorum/founder_keys/inheritance_after
  // etc. are unset DB defaults for this shape (2-of-0, 52560), not real
  // data. Build the phase summary from the real leaf list instead; see
  // buildVaultLeaves's header comment for the same discriminator.
  if (Array.isArray(vault.leaves) && vault.leaves.length > 0) {
    const leaves = buildVaultLeaves(vault, tip);
    const available = leaves.filter(openNowStatus);
    const openNow = leaves.filter(l => l.status === "unlocked");

    const label = openNow.length > 0 && available.length === openNow.length
      ? "Timelocked path open"
      : "Normal operation";
    const accent = openNow.length > 0 && available.length === openNow.length
      ? colors.green
      : colors.gold;
    const description = available.length > 0
      ? `${available.map(l => `${leafWho(l)} "${l.label}"`).join(" or ")} can spend right now.`
      : `No path is open right now -- this vault has ${leaves.length} spending path${leaves.length === 1 ? "" : "s"}, each waiting on its own condition.`;
    const paths = leaves.map(l => {
      if (l.status === "locked" && l.absHeight != null) {
        return `${l.label} - locked until block ${l.absHeight.toLocaleString()} (${leafWho(l)})`;
      }
      if (l.status === "per_coin") {
        return `${l.label} - ${leafWho(l)} - per coin, after about ${blocksToLabel(l.untouchedBlocks ?? 0)} unmoved`;
      }
      return `${l.label} - ${leafWho(l)}${l.status === "unlocked" ? " - OPEN" : ""}`;
    });

    return { label, description, accent, paths };
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

export function VaultPhaseCard({ vault }: { vault: Vault }) {
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
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: phase.accent,
            textTransform: "uppercase",
          }}
        >
          {phase.label}
        </span>
        {tip != null && (
          <span style={{ fontSize: 15, color: colors.muted, fontFamily: fonts.mono }}>
            tip {tip.toLocaleString()}
          </span>
        )}
      </div>
      <div style={{ fontSize: 17, color: colors.text, lineHeight: 1.5, marginBottom: 8 }}>
        {phase.description}
      </div>
      {phase.paths.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 16, color: colors.sub, lineHeight: 1.7 }}>
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
              fontSize: 14,
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
            <div key={i} style={{ fontSize: 16, color: colors.sub, lineHeight: 1.5 }}>
              {l}
            </div>
          ))}
          {roleHint.cta && (
            <div style={{ fontSize: 16, color: phase.accent, marginTop: 6, fontWeight: 600 }}>
              {roleHint.cta}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
