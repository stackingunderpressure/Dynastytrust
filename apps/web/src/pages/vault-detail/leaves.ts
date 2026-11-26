import { type Vault } from "../../lib/api";
import { whoSignsShort, mustSignMeaning } from "../../lib/path-words";
import { colors } from "../../theme";
import { blocksToLabel } from "./shared";


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
// "per_coin": an "if untouched" path (older) opens separately for each coin,
// once that coin has sat unmoved long enough -- never for the vault as a
// whole, so it is never "can spend right now" here (operator, 2026-11-25, a
// screenshot: the coin card said "Path 2: 100 blocks left" while this card
// said Path 2 could spend right now). The coins list shows each coin's wait.
export type VaultLeafStatus = "active" | "unlocked" | "locked" | "per_coin";
export const openNowStatus = (l: { status: VaultLeafStatus }) => l.status === "active" || l.status === "unlocked";
export const perCoinWords = (l: VaultLeaf) =>
  `"${l.label}" (${leafWho(l)}) opens for each coin once that coin has sat unmoved for about ${blocksToLabel(l.untouchedBlocks ?? 0)} -- the coins list above shows how long each one has left.`;

interface VaultLeaf {
  id: string;
  label: string;
  color: string;
  quorum: number;
  /** Every key on the path, must-sign keys FIRST (the first `mustSign`). */
  keyPubkeys: string[];
  /** How many of keyPubkeys must each sign, on top of `quorum` of the rest. */
  mustSign?: number;
  absHeight: number | null;
  status: VaultLeafStatus;
  /** For a "per_coin" path: how many blocks a coin must sit unmoved. */
  untouchedBlocks?: number;
  note?: string;
}

// "2 of 3" -- or "1 must-sign + 1 of 2" on a path with must-sign keys.
export const leafWho = (l: VaultLeaf) => whoSignsShort(l.quorum, l.keyPubkeys.length - (l.mustSign ?? 0), l.mustSign ?? 0);

function vaultLeafStatus(absHeight: number | null, tip: number | null): VaultLeafStatus {
  if (!absHeight || absHeight <= 0) return "active";
  if (tip != null && tip >= absHeight) return "unlocked";
  return "locked";
}

export function buildVaultLeaves(vault: Vault, tip: number | null): VaultLeaf[] {
  // Generic leaf-list ("custom builder") vault -- has no founder_keys/
  // heir_keys etc. at all (those columns sit at their bare DB defaults,
  // 2-of-0, for a vault created this way), so the fixed founders/recovery/
  // backup/heirs shape below does not apply. Build directly from the real
  // leaf list instead, same discriminator pattern as trust-doc.ts's
  // buildLeavesTrustDoc and the PDF/audit/tax exports already use.
  if (Array.isArray(vault.leaves) && vault.leaves.length > 0) {
    const palette = [colors.gold, colors.blue, colors.green, colors.orange];
    return vault.leaves.map((leaf, i) => {
      const absHeight = leaf.unlock.type === "after" ? leaf.unlock.blocks : null;
      const status: VaultLeafStatus =
        leaf.unlock.type === "after" ? vaultLeafStatus(absHeight, tip)
          : leaf.unlock.type === "older" ? "per_coin"
          : "active";
      const note =
        leaf.unlock.type === "older"
          ? `Opens if the vault sits untouched for about ${blocksToLabel(leaf.unlock.blocks)} -- any spend from any path resets this clock.`
          : leaf.decay
            ? `Required signers step down over time to a floor of ${leaf.decay.floor_quorum}.`
            : undefined;
      return {
        id: leaf.id,
        label: leaf.label,
        color: palette[i % palette.length],
        quorum: leaf.quorum,
        keyPubkeys: [...(leaf.required_keys ?? []), ...leaf.keys],
        mustSign: (leaf.required_keys ?? []).length,
        absHeight,
        status,
        untouchedBlocks: leaf.unlock.type === "older" ? leaf.unlock.blocks : undefined,
        note: [mustSignMeaning((leaf.required_keys ?? []).length), note].filter(Boolean).join(" ") || undefined,
      };
    });
  }

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
