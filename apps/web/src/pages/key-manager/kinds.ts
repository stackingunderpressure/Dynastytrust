// Which tab a key belongs on, and how it opens -- read straight off the
// fields lib/keystore.ts already sets. Archived (or compromised) keys of
// every kind go on the Archived tab.
import type { LocalKey } from "../../lib/keystore";
import { colors } from "../../theme";

export type KindTab = "phone" | "hardware" | "tapit" | "test" | "archived";

export const KIND_TABS: { id: KindTab; label: string; always: boolean }[] = [
  { id: "phone", label: "Phone keys", always: true },
  { id: "hardware", label: "Hardware", always: true },
  { id: "tapit", label: "Tapit", always: true },
  { id: "test", label: "Test", always: false },
  { id: "archived", label: "Archived", always: false },
];

export function keyKind(k: LocalKey): KindTab {
  if (k.status !== "active") return "archived";
  if (k.origin === "tapit") return "tapit";
  if (k.origin === "imported_xpub") return "hardware";
  if (k.testMnemonic) return "test";
  return "phone";
}

/** How the key opens, as the row shows it. */
export function lockLabel(k: LocalKey): { text: string; color: string } {
  if (k.origin === "tapit") return { text: "TAPIT", color: colors.gold };
  if (k.origin === "imported_xpub") return { text: "HARDWARE", color: colors.blue };
  if (k.testMnemonic) return { text: "TEST -- NO LOCK", color: colors.green };
  if (k.passkeyMnemonic) return { text: "FACE ID", color: colors.blue };
  if (k.encryptedMnemonic) return { text: "PASSWORD", color: colors.sub };
  return { text: "NO WORDS HERE", color: colors.muted };
}
