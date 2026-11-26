import { useEffect, useState, useCallback } from "react";
import { api, type Vault, type DistributionWallet, type DistributionTranche } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { explorerTxUrl } from "../../config";
import { useToast } from "../../components/toast";
import { colors, fonts, } from "../../theme";
import { Button } from "../../components/ui";
import { useRealtimeRefresh } from "../../lib/realtime";
import { downloadDistributionWalletBackup } from "../../lib/descriptor-backup";
import { tipHeight } from "../../lib/chain";
import { DistributionWalletCreator } from "./DistributionWalletCreator";
import { SendPrefill } from "./SendTab";
import { TrancheClaimModal } from "./TrancheClaimModal";
import { satsToBtc } from "./shared";


// // -- Distribution wallets (T-vesting)
// Each wallet splits a lump sum into N tranches, each gated by
// CLTV at an absolute block height. Beneficiary claims alone after
// the unlock; trustees always retain an escape hatch on every
// tranche so unclaimed funds aren't stranded. The creation
// ceremony calls api.distributionWallets.compileTranche once per
// tranche (via Fly.io), collects the addresses, then POSTs the
// whole plan in one shot.

export function DistributionWalletsSection({
  vault,
  onSendPrefill,
}: {
  vault: Vault;
  onSendPrefill: (p: SendPrefill) => void;
}) {
  const toast = useToast();
  const [wallets, setWallets] = useState<DistributionWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [session, setSession] = useState<{ user: { id: string } } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session as unknown as { user: { id: string } });
    });
  }, []);

  const isOwner = session?.user.id === vault.user_id;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.distributionWallets.list(vault.id);
      setWallets(res.wallets);
    } catch {
      /* empty state is fine */
    } finally {
      setLoading(false);
    }
  }, [vault.id]);

  useEffect(() => { void load(); }, [load]);

  useRealtimeRefresh(
    { table: "distribution_wallets", filter: `vault_id=eq.${vault.id}` },
    () => void load(),
  );

  if (loading) return null;
  if (!isOwner && wallets.length === 0) return null;
  // Distribution wallets only make sense once a vault is compiled
  // (the ceremony needs the vault's trustee pubkeys).
  if (vault.status === "draft") return null;

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: wallets.length === 0 && !creating ? 0 : 10,
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: colors.muted,
            textTransform: "uppercase",
          }}
        >
          Distribution wallets
        </div>
        {isOwner && !creating && (
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 15, padding: "3px 9px" }}
            onClick={() => setCreating(true)}
          >
            New plan
          </Button>
        )}
      </div>

      {wallets.length === 0 && !creating && isOwner && (
        <div style={{ fontSize: 16, color: colors.muted, marginTop: 8 }}>
          None yet: a lump sum paid out in parts on a schedule.
        </div>
      )}

      {wallets.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {wallets.map(w => (
            <DistributionWalletRow
              key={w.id}
              wallet={w}
              vault={vault}
              isOwner={isOwner}
              onSendPrefill={onSendPrefill}
              onClaimed={() => void load()}
            />
          ))}
        </div>
      )}

      {creating && (
        <div style={{ marginTop: 10 }}>
          <DistributionWalletCreator
            vault={vault}
            onCancel={() => setCreating(false)}
            onSaved={() => { setCreating(false); void load(); toast.success("Distribution wallet created"); }}
          />
        </div>
      )}
    </div>
  );
}

function DistributionWalletRow({
  wallet,
  vault,
  isOwner,
  onSendPrefill,
  onClaimed,
}: {
  wallet: DistributionWallet;
  vault: Vault;
  isOwner: boolean;
  onSendPrefill: (p: SendPrefill) => void;
  onClaimed: () => void;
}) {
  const [tip, setTip] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    tipHeight(vault.network).then(setTip).catch(() => {});
  }, [vault.network]);

  const total = wallet.tranches.reduce((n, t) => n + t.amount_sats, 0);
  const claimed = wallet.tranches.filter(t => t.claimed_txid).length;
  const funded = wallet.tranches.filter(t => t.funded_txid).length;

  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>
            {wallet.name}
            {wallet.beneficiary_name && (
              <span style={{ color: colors.muted, fontWeight: 400, marginLeft: 6 }}>
                -- {wallet.beneficiary_name}
              </span>
            )}
          </div>
          <div style={{ fontSize: 16, color: colors.muted }}>
            {wallet.tranches.length} tranches . {satsToBtc(total)} BTC total
            {funded > 0 && <> . {funded} funded</>}
            {claimed > 0 && <> . {claimed} claimed</>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 15 }}
            onClick={() => void downloadDistributionWalletBackup(wallet, vault.name)}
          >
            Download backup
          </Button>
          <Button variant="ghost" size="sm" style={{ fontSize: 15 }} onClick={() => setExpanded(e => !e)}>
            {expanded ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {wallet.tranches.map(t => (
            <TrancheRow
              key={t.index}
              tranche={t}
              tip={tip}
              wallet={wallet}
              isOwner={isOwner}
              onFund={() =>
                onSendPrefill({
                  destination: t.address,
                  amount_sats: t.amount_sats,
                  memo: `Fund ${wallet.name} tranche ${t.index + 1}`,
                  distribution_wallet_id: wallet.id,
                  tranche_index: t.index,
                })
              }
              onClaimed={onClaimed}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TrancheRow({
  tranche: t,
  tip,
  wallet,
  isOwner,
  onFund,
  onClaimed,
}: {
  tranche: DistributionTranche;
  tip: number | null;
  wallet: DistributionWallet;
  isOwner: boolean;
  onFund: () => void;
  onClaimed: () => void;
}) {
  const [claimPath, setClaimPath] = useState<"beneficiary" | "trustee" | null>(null);
  const isClaimed = !!t.claimed_txid;
  const isFunded = !!t.funded_txid;
  const blocksLeft = tip != null ? Math.max(0, t.unlock_block - tip) : null;
  const unlocked = tip != null && tip >= t.unlock_block;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        fontSize: 16,
        padding: "6px 8px",
        borderRadius: 6,
        background: isClaimed
          ? colors.green + "11"
          : unlocked
            ? colors.gold + "11"
            : "transparent",
        border: `1px solid ${isClaimed ? colors.green + "44" : colors.border}`,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: colors.text }}>
          Tranche {t.index + 1} . {satsToBtc(t.amount_sats)} BTC
        </div>
        <div style={{ fontSize: 15, color: colors.muted, fontFamily: fonts.mono, wordBreak: "break-all" }}>
          {t.address}
        </div>
      </div>
      <div style={{ textAlign: "right", fontSize: 15, color: colors.sub }}>
        <div>Unlock block {t.unlock_block.toLocaleString()}</div>
        {blocksLeft != null && blocksLeft > 0 && (
          <div style={{ color: colors.muted }}>{blocksLeft.toLocaleString()} blocks left</div>
        )}
        {isClaimed && (
          <div style={{ color: colors.green }}>
            claimed
            {t.claimed_txid && (
              <>
                {" "}
                <a
                  href={explorerTxUrl(wallet.network, t.claimed_txid)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: colors.gold }}
                >
                  view
                </a>
              </>
            )}
          </div>
        )}
        {!isClaimed && !isFunded && (
          <Button size="sm" style={{ fontSize: 14, padding: "2px 6px", marginTop: 3 }} onClick={onFund}>
            Fund
          </Button>
        )}
        {!isClaimed && isFunded && (
          <div style={{ display: "flex", gap: 4, marginTop: 3, justifyContent: "flex-end" }}>
            {unlocked && (
              <Button size="sm" style={{ fontSize: 14, padding: "2px 6px" }} onClick={() => setClaimPath("beneficiary")}>
                Claim
              </Button>
            )}
            {isOwner && (
              <Button
                variant="ghost"
                size="sm"
                style={{ fontSize: 14, padding: "2px 6px" }}
                onClick={() => setClaimPath("trustee")}
              >
                Trustee escape
              </Button>
            )}
          </div>
        )}
      </div>
      {claimPath && (
        <TrancheClaimModal
          wallet={wallet}
          tranche={t}
          path={claimPath}
          onClose={() => setClaimPath(null)}
          onClaimed={() => { setClaimPath(null); onClaimed(); }}
        />
      )}
    </div>
  );
}
