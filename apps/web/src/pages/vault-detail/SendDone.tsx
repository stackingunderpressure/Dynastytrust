// The Send screen after Broadcast: "sent", the txid, and -- if recording
// it failed -- "Record it in history". Markup only; the record step is
// SendTab's recordAgain.
import type { Vault } from "../../lib/api";
import { explorerTxUrl } from "../../config";
import { colors, fonts } from "../../theme";
import { Button } from "../../components/ui";

export function SendDone({ vault, signing, recordErr, busy, recordAgain }: {
  vault: Vault;
  signing: { txid: string };
  recordErr: string | null;
  busy: boolean;
  recordAgain: () => Promise<void>;
}) {
  return (
      <div
        style={{
          background: colors.successBg,
          border: `1px solid ${colors.green}44`,
          borderRadius: 16,
          padding: 32,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 52, marginBottom: 12 }}>sent</div>
        <div style={{ fontSize: 20, fontWeight: 600, color: colors.green, marginBottom: 8 }}>
          Transaction broadcast
        </div>
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 15,
            color: colors.muted,
            marginBottom: 20,
            wordBreak: "break-all",
          }}
        >
          {signing.txid}
        </div>
        <a
          href={explorerTxUrl(vault.network, signing.txid)}
          target="_blank"
          rel="noreferrer"
          style={{ color: colors.gold, fontSize: 17 }}
        >
          View on mempool.space
        </a>
        {recordErr ? (
          <div style={{ marginTop: 20, textAlign: "left", fontSize: 16, color: colors.sub, lineHeight: 1.5 }}>
            The money is sent. It isn't in this vault's history yet: {recordErr}
            <Button style={{ width: "100%", marginTop: 12, minHeight: 44 }} disabled={busy} onClick={() => void recordAgain()}>
              {busy ? "Recording..." : "Record it in history"}
            </Button>
          </div>
        ) : null}
      </div>
  );
}
