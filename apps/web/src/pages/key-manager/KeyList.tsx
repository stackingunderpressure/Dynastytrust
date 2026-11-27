// The Keys page's list: one tab per kind of key, compact rows, and a
// "Needs you" strip that names only what is actually outstanding.
//
// Operator, 2026-11-27: "Tabs for each kind of key instead of mixed. Tapit
// keys also a tab. And any other thing to tidy it up compact without
// loosing functionality or awareness" (docs/key-manager-tidy-build-note.md).
// Layout only: every action still runs through KeyManager's own modals and
// keystore calls, reached by tapping a row (the detail screen).

import { useEffect, useState, type ReactNode } from "react";
import { passkeyLockPlan, type LocalKey } from "../../lib/keystore";
import { passkeysAvailable } from "../../lib/passkey";
import { getMfaState } from "../../lib/mfa";
import { DOWNLOAD } from "../../lib/download";
import { colors, fonts } from "../../theme";
import { Button, Input } from "../../components/ui";
import { keyKind, lockLabel, KIND_TABS, type KindTab } from "./kinds";

export function KeyList({
  keys, onOpen, onBackup, onGenerate, onRestore, onImportXpub, phoneTop, tapitTop, accountId,
}: {
  keys: LocalKey[];
  onOpen: (k: LocalKey) => void;
  onBackup: (k: LocalKey) => void;
  onGenerate: () => void;
  onRestore: () => void;
  onImportXpub: () => void;
  /** Shown under the Phone keys tab's keys ("Face ID for your keys"). */
  phoneTop?: ReactNode;
  /** Shown under the Tapit tab's keys (Tapit sign-in). */
  tapitTop?: ReactNode;
  /** The id of the Account & sign-in section, for the strip to scroll to. */
  accountId: string;
}) {
  // null until the person picks a tab: the keys load after the first
  // render, so the opening tab is worked out from them each time until then.
  const [picked, setTab] = useState<KindTab | null>(null);
  const tab = picked ?? firstTab(keys);
  const [search, setSearch] = useState("");
  const [persona, setPersona] = useState("all");
  const [twoStepOff, setTwoStepOff] = useState(false);

  useEffect(() => {
    if (DOWNLOAD) return;
    let live = true;
    void getMfaState().then(s => { if (live) setTwoStepOff(!s.factorId); }).catch(() => { /* card shows its own state */ });
    return () => { live = false; };
  }, []);

  const inTab = (t: KindTab) => keys.filter(k => keyKind(k) === t);
  const notBackedUp = (k: LocalKey) => k.status === "active" && k.origin === "software" && !k.backedUp;
  const shown = KIND_TABS.filter(t => t.always || inTab(t.id).length > 0);
  const current = shown.some(t => t.id === tab) ? tab : shown[0].id;

  // ---- the "Needs you" strip: only what is outstanding, each line a way to it
  const unbacked = keys.filter(notBackedUp);
  const passwordKeys = passkeysAvailable() ? passkeyLockPlan().ready.length : 0;
  const needs: { text: string; go: () => void }[] = [];
  if (unbacked.length) {
    needs.push({
      text: `${unbacked.length} key${unbacked.length === 1 ? " is" : "s are"} not backed up`,
      go: () => { setSearch(""); setTab(keyKind(unbacked[0])); },
    });
  }
  if (passwordKeys) {
    needs.push({
      text: `${passwordKeys} key${passwordKeys === 1 ? " still opens" : "s still open"} with a typed password`,
      go: () => { setSearch(""); setTab("phone"); },
    });
  }
  if (twoStepOff) {
    needs.push({
      text: "Two-step sign-in is off (optional)",
      go: () => document.getElementById(accountId)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    });
  }

  const q = search.trim().toLowerCase();
  const list = q
    ? keys.filter(k => k.label.toLowerCase().includes(q) || k.fingerprint.toLowerCase().includes(q))
    : inTab(current);
  const personas = Array.from(new Set(list.map(k => k.persona)));
  const visible = !q && persona !== "all" && personas.includes(persona) ? list.filter(k => k.persona === persona) : list;

  return (
    <div>
      {needs.length > 0 && (
        <div style={{ border: `1px solid ${colors.orange}55`, background: colors.orange + "0D", borderRadius: 12, padding: "8px 14px", marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: colors.orange, letterSpacing: 0.4, marginTop: 4 }}>NEEDS YOU</div>
          {needs.map(n => (
            <button
              key={n.text}
              type="button"
              onClick={n.go}
              style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "10px 0", minHeight: 44, fontSize: 17, color: colors.text, cursor: "pointer" }}
            >
              {n.text} <span style={{ color: colors.orange }}>›</span>
            </button>
          ))}
        </div>
      )}

      <div role="tablist" aria-label="Kinds of key" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {shown.map(t => {
          const n = inTab(t.id).length;
          const on = !q && t.id === current;
          const dot = t.id !== "archived" && inTab(t.id).some(notBackedUp);
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => { setSearch(""); setPersona("all"); setTab(t.id); }}
              style={{
                minHeight: 44, padding: "0 13px", borderRadius: 10, cursor: "pointer", fontSize: 16, fontWeight: on ? 700 : 500,
                background: on ? colors.gold + "1A" : colors.surface,
                border: `1px solid ${on ? colors.gold : colors.border}`,
                color: on ? colors.gold : colors.sub,
              }}
            >
              {t.label} {n}
              {dot && <span aria-label="has a key not backed up" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: colors.orange, marginLeft: 6, verticalAlign: "middle" }} />}
            </button>
          );
        })}
      </div>

      <Input
        placeholder="Search all keys by name or fingerprint"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: "100%", padding: "9px 12px", marginBottom: 12, boxSizing: "border-box" }}
      />

      {!q && <TabIntro tab={current} count={list.length} onGenerate={onGenerate} onRestore={onRestore} onImportXpub={onImportXpub} />}

      {!q && personas.length > 1 && list.length > 4 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {["all", ...personas].map(p => (
            <button
              key={p}
              type="button"
              onClick={() => setPersona(p)}
              style={{
                minHeight: 36, padding: "0 11px", borderRadius: 18, fontSize: 15, cursor: "pointer", background: "none",
                border: `1px solid ${persona === p ? colors.gold : colors.border}`, color: persona === p ? colors.gold : colors.sub,
              }}
            >
              {p === "all" ? "Everyone" : p}
            </button>
          ))}
        </div>
      )}

      {q && visible.length === 0 && <p style={{ fontSize: 17, color: colors.muted }}>No keys match your search.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {visible.map(k => (
          <KeyRow key={k.keyId} k={k} showKind={!!q} onOpen={() => onOpen(k)} onBackup={notBackedUp(k) ? () => onBackup(k) : undefined} />
        ))}
      </div>

      {/* The tab's own setting, under its keys: keys first. */}
      {!q && current === "phone" && phoneTop && <div style={{ marginTop: 14 }}>{phoneTop}</div>}
      {!q && current === "tapit" && tapitTop && <div style={{ marginTop: 14 }}>{tapitTop}</div>}
    </div>
  );
}

function firstTab(keys: LocalKey[]): KindTab {
  if (keys.some(k => keyKind(k) === "phone")) return "phone";
  return KIND_TABS.find(t => keys.some(k => keyKind(k) === t.id))?.id ?? "phone";
}

function TabIntro({ tab, count, onGenerate, onRestore, onImportXpub }: {
  tab: KindTab; count: number; onGenerate: () => void; onRestore: () => void; onImportXpub: () => void;
}) {
  const text: Record<KindTab, string> = {
    phone: count
      ? "Keys whose words are on this phone, opened with Face ID or a password."
      : "A key is one signer in a vault. Each person (founder, heir) holds their own. Make one here -- Face ID locks it on this phone -- or bring one back from its written words.",
    hardware: "A hardware wallet's public key (xpub). Its private key never leaves the device; it signs there.",
    tapit: "Keys held in someone's Tapit wallet. They're added when you put a Tapit holder in a vault (Start a vault).",
    test: "Unlocked keys for trying things out. Never for real funds.",
    archived: "Hidden from the other tabs, not deleted. Tap one to bring it back or delete it.",
  };
  const add =
    tab === "phone" ? (
      <>
        <Button style={{ background: colors.green, fontSize: 17, minHeight: 44 }} onClick={onGenerate}>+ New key</Button>
        <Button variant="ghost" style={{ minHeight: 44 }} onClick={onRestore}>Restore from words</Button>
      </>
    ) : tab === "hardware" ? (
      <Button style={{ background: colors.green, fontSize: 17, minHeight: 44 }} onClick={onImportXpub}>+ Import xpub</Button>
    ) : tab === "test" ? (
      <Button variant="ghost" style={{ minHeight: 44 }} onClick={onGenerate}>+ New test key</Button>
    ) : null;
  return (
    <div style={{ marginBottom: 12 }}>
      <p style={{ fontSize: 16, color: colors.muted, lineHeight: 1.5, margin: "0 0 10px" }}>{text[tab]}</p>
      {add && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{add}</div>}
    </div>
  );
}

function KeyRow({ k, showKind, onOpen, onBackup }: { k: LocalKey; showKind: boolean; onOpen: () => void; onBackup?: () => void }) {
  const badge = (text: string, c: string) => (
    <span style={{ fontSize: 14, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: c + "22", color: c, whiteSpace: "nowrap" }}>{text}</span>
  );
  const lock = lockLabel(k);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 12, padding: "4px 6px 4px 14px" }}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${k.label}: details and actions`}
        style={{ flex: 1, minWidth: 0, minHeight: 56, background: "none", border: "none", padding: "8px 0", textAlign: "left", cursor: "pointer", color: colors.text }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 17, fontWeight: 600, overflowWrap: "anywhere" }}>{k.label}</span>
          {badge(lock.text, lock.color)}
          {onBackup && badge("NOT BACKED UP", colors.orange)}
          {k.status !== "active" && badge(k.status.toUpperCase(), colors.muted)}
          {showKind && k.status === "active" && <span style={{ fontSize: 14, color: colors.muted }}>{KIND_TABS.find(t => t.id === keyKind(k))?.label}</span>}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 3, fontSize: 15 }}>
          <span style={{ fontFamily: fonts.mono, color: colors.muted }}>{k.fingerprint}</span>
          <span style={{ color: k.network === "mainnet" ? colors.gold : colors.green }}>{k.network.toUpperCase()}</span>
          <span style={{ color: colors.muted }}>{k.persona}</span>
        </div>
      </button>
      {onBackup ? (
        <Button variant="ghost" size="sm" style={{ fontSize: 16, minHeight: 44, flexShrink: 0, color: colors.orange, borderColor: colors.orange + "66" }} onClick={onBackup}>
          Back up
        </Button>
      ) : (
        <span aria-hidden style={{ color: colors.muted, fontSize: 22, paddingRight: 8 }}>›</span>
      )}
    </div>
  );
}
