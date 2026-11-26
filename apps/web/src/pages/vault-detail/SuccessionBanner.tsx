import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Vault } from "../../lib/api";
import { colors, fonts, } from "../../theme";
import { Button } from "../../components/ui";
import { SendPrefill } from "./SendTab";


// // -- DraftReadinessCard
// Onboarding UI for a draft vault. Teaches "one-shot compile"
// -- the vault address is baked from everyone's xpubs at
// compile time and cannot be changed after; members added later
// live on a rotated successor vault, not this one. Shows every
// slot's status (claimed / pending) with copy-invite-link for
// outstanding slots. Compiles are blocked (server-side too)
// until every slot has a key.

// // -- SuccessionBanner
// Links a rotated vault to its predecessor and (if any) successor.
// Shows the forward chain so members understand they're looking at
// one link in an evolving trust, not a dead end. The "Sweep to
// successor" CTA on the predecessor prefills the Send flow with
// the new vault's address so the migration of funds is one click.

export function SuccessionBanner({
  vault,
  onSendPrefill,
}: {
  vault: Vault;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  const [predecessor, setPredecessor] = useState<Vault | null>(null);
  const [successor, setSuccessor] = useState<Vault | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { vaults } = await api.vaults.list(true);
        if (cancelled) return;
        if (vault.predecessor_id) {
          const p = vaults.find(v => v.id === vault.predecessor_id);
          if (p) setPredecessor(p);
        }
        const s = vaults.find(v => v.predecessor_id === vault.id);
        if (s) setSuccessor(s);
      } catch {
        /* best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [vault.id, vault.predecessor_id]);

  if (!predecessor && !successor) return null;

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${colors.blue}`,
        borderRadius: 12,
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: colors.blue,
          textTransform: "uppercase",
        }}
      >
        Succession chain
      </div>
      {predecessor && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 16, color: colors.sub }}>
            Rotated from <strong style={{ color: colors.text }}>{predecessor.name}</strong>
            {predecessor.address && (
              <span style={{ color: colors.muted, marginLeft: 6, fontFamily: fonts.mono, fontSize: 15 }}>
                {predecessor.address.slice(0, 10)}...{predecessor.address.slice(-6)}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 15 }}
            onClick={() => navigate(`/vaults/${predecessor.id}`, { state: { vault: predecessor } })}
          >
            Open predecessor
          </Button>
        </div>
      )}
      {successor && (
        // Standing warning, by the operator's choice (2026-11-11): making
        // the new vault protects nothing. Until the coins are moved, this
        // vault's own dates still decide who can spend them.
        <div style={{ fontSize: 17, color: colors.orange, lineHeight: 1.55 }}>
          {successor.address
            ? "The rotation is not finished. Any coins still in this vault are under this vault's dates until you move them to the new one."
            : "The new vault is not finalized yet, so nothing has changed: this vault's dates still apply."}
        </div>
      )}
      {successor && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 16, color: colors.sub }}>
            Rotated to <strong style={{ color: colors.text }}>{successor.name}</strong>
            {successor.address
              ? (
                  <span style={{ color: colors.muted, marginLeft: 6, fontFamily: fonts.mono, fontSize: 15 }}>
                    {successor.address.slice(0, 10)}...{successor.address.slice(-6)}
                  </span>
                )
              : (
                  <span style={{ color: colors.orange, marginLeft: 6, fontSize: 15 }}>
                    draft -- awaiting compile
                  </span>
                )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {successor.address && (
              <Button
                size="sm"
                style={{ fontSize: 15 }}
                onClick={() =>
                  onSendPrefill({
                    destination: successor.address!,
                    memo: `Sweep to successor ${successor.name}`,
                  })
                }
              >
                Sweep to successor
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 15 }}
              onClick={() => navigate(`/vaults/${successor.id}`, { state: { vault: successor } })}
            >
              Open successor
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
