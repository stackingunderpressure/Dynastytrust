import { useEffect, useState } from "react";
import { api, type Vault, type VaultMember } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { fetchTapitDisplayNames } from "../../lib/tapit-profile-lookup";
import { useToast } from "../../components/toast";
import { colors, fonts, } from "../../theme";
import { tipHeight, blocksToApproxLabel } from "../../lib/chain";
import { VaultLeafStatus, buildVaultLeaves, leafWho } from "./leaves";


function VaultLeafStatusPill({ status, absHeight, tip }: { status: VaultLeafStatus; absHeight: number | null; tip: number | null }) {
  if (status === "active") {
    return (
      <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.06em", color: colors.gold, textTransform: "uppercase", whiteSpace: "nowrap" }}>
        Active now
      </span>
    );
  }
  if (status === "per_coin") {
    return (
      <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.06em", color: colors.muted, textTransform: "uppercase", whiteSpace: "nowrap" }}>
        Per coin -- see coins
      </span>
    );
  }
  if (status === "unlocked") {
    return (
      <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.06em", color: colors.green, textTransform: "uppercase", whiteSpace: "nowrap" }}>
        Unlocked
      </span>
    );
  }
  const blocksLeft = tip != null && absHeight != null ? Math.max(0, absHeight - tip) : null;
  return (
    <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.06em", color: colors.muted, textTransform: "uppercase", whiteSpace: "nowrap" }}>
      {blocksLeft != null ? `Locked -- ${blocksToApproxLabel(blocksLeft)}` : "Locked"}
    </span>
  );
}

export function VaultStructureTree({ vault }: { vault: Vault }) {
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
      data-dt-spending-paths
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          fontSize: 15,
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
        <div style={{ fontSize: 16, color: colors.sub, fontFamily: fonts.mono, wordBreak: "break-all" }}>
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
                <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>{leaf.label}</div>
                <VaultLeafStatusPill status={leaf.status} absHeight={leaf.absHeight} tip={tip} />
              </div>
              <div style={{ fontSize: 16, color: colors.sub, marginTop: 4 }}>
                {leafWho(leaf)} required
                {leaf.absHeight ? ` -- unlocks at block ${leaf.absHeight.toLocaleString()}` : ""}
              </div>
              <div style={{ fontSize: 15, color: colors.muted, marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
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
                          fontSize: 15,
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
                        style={{ fontSize: 15, color: colors.gold, background: "none", border: "none", cursor: "pointer", padding: 0 }}
                      >
                        {saving ? "..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingPubkey(null)}
                        style={{ fontSize: 15, color: colors.muted, background: "none", border: "none", cursor: "pointer", padding: 0 }}
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
                      {idx < (leaf.mustSign ?? 0) ? "must sign: " : ""}{keyLabel(pk)}
                    </span>
                  ),
                )}
              </div>
              {leaf.note && (
                <div style={{ fontSize: 15, color: colors.orange, marginTop: 6 }}>{leaf.note}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
