// The Send screen's signing step: the summary, the ways to sign, Broadcast
// and Cancel. Markup only: every step that signs, sends or records is a
// SendTab function passed in. Its own state is only visual (the QR
// show/hide and the "copied" flash).
import { useState } from "react";
import type { Vault } from "../../lib/api";
import { colors, fonts } from "../../theme";
import { Button } from "../../components/ui";
import { PsbtQrDisplay } from "../../components/PsbtQrDisplay";
import { PsbtQrScanner } from "../../components/PsbtQrScanner";
import { NotifyCircleViaNostr } from "../../components/NotifyCircleViaNostr";
import { SeedSignerNetworkHint } from "../../components/SeedSignerNetworkHint";
import { ExternalPsbtInput } from "./ExternalPsbtInput";
import { satsToBtc } from "./shared";
import type { SigningState } from "./send-types";

export function SendSigning({ vault, signing, busy, err, signWithKey, broadcast, externalImport, cancelSpend, leaveOpen }: {
  vault: Vault;
  signing: SigningState;
  busy: boolean;
  err: string | null;
  signWithKey: (keyIndex: number) => Promise<void>;
  broadcast: () => Promise<void>;
  externalImport: (importedHex: string, label?: string) => void;
  cancelSpend: () => Promise<void>;
  leaveOpen: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [showQrDisplay, setShowQrDisplay] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
    const quorumMet = signing.signaturesCollected >= signing.requiredSignatures;
    const needed = signing.requiredSignatures - signing.signaturesCollected;

    function copyPsbt(text: string, id: string) {
      navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1600);
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Summary card */}
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 14 }}>
            Transaction
          </div>
          {[
            ["To", signing.summary.destination],
            ["Amount", `${satsToBtc(signing.summary.amount_sats)} BTC`],
            ["Fee", `${satsToBtc(signing.summary.fee_sats)} BTC (~${signing.summary.fee_rate} sat/vb)`],
            ["Change back", `${satsToBtc(signing.summary.change_sats)} BTC`],
          ].map(([k, v]) => (
            <div
              key={k}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: `1px solid ${colors.border}`,
              }}
            >
              <span style={{ fontSize: 17, color: colors.muted }}>{k}</span>
              <span
                style={{
                  fontSize: 17,
                  color: colors.text,
                  fontFamily: k === "To" ? fonts.mono : "inherit",
                  wordBreak: "break-all",
                  textAlign: "right",
                  maxWidth: "60%",
                }}
              >
                {v}
              </span>
            </div>
          ))}

          {/* Signature progress */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 16, color: colors.muted }}>Signatures</span>
              <span style={{ fontSize: 16, color: quorumMet ? colors.green : colors.orange }}>
                {signing.signaturesCollected} / {signing.requiredSignatures} required
              </span>
            </div>
            <div style={{ height: 4, background: colors.border, borderRadius: 2 }}>
              <div
                style={{
                  height: "100%",
                  borderRadius: 2,
                  background: quorumMet ? colors.green : colors.gold,
                  width: `${Math.min(100, (signing.signaturesCollected / signing.requiredSignatures) * 100)}%`,
                  transition: "width 0.3s",
                }}
              />
            </div>
          </div>
        </div>

        {/* Browser keys signing -- Tapit-origin keys hold no local private
            material (importTapitPubkey stores pubkey only, see keystore.ts)
            so they can never actually unlock here; they're excluded from
            this list and only ever offered via "Notify circle via Nostr"
            below, which is what they were always meant for. Filtering by
            index (not a plain .filter()) keeps each row's signWithKey(i)
            call pointed at the right entry in the full signing.signers
            array, which NotifyCircleViaNostr and the quorum progress bar
            above both still read unfiltered. */}
        {signing.signers.some(s => s.key.origin !== "tapit") && (
          <div
            style={{
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 20,
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
              Sign with browser keys
            </div>
            <div style={{ fontSize: 16, color: colors.muted, marginBottom: 14 }}>
              Tap a key to sign.{" "}
              {signing.requiredSignatures > 1
                ? `Need ${signing.requiredSignatures} signatures.`
                : "Only 1 signature needed."}
            </div>
            {signing.signers.map((signer, i) => {
              if (signer.key.origin === "tapit") return null;
              const statusIcon =
                signer.status === "signed"
                  ? "Signed"
                  : signer.status === "signing"
                    ? "Signing..."
                    : signer.status === "error"
                      ? "Error"
                      : "Tap to sign";
              const accent =
                signer.status === "signed"
                  ? colors.green
                  : signer.status === "error"
                    ? colors.red
                    : signer.status === "signing"
                      ? colors.gold
                      : colors.muted;
              return (
                <div
                  key={signer.key.keyId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 14px",
                    borderRadius: 10,
                    marginBottom: 8,
                    background: signer.status === "signed" ? `${colors.green}0D` : colors.inset,
                    border: `1px solid ${signer.status === "signed" ? `${colors.green}44` : colors.border}`,
                    cursor:
                      signer.status === "pending" || signer.status === "error"
                        ? "pointer"
                        : "default",
                    opacity: signer.status === "signing" ? 0.7 : 1,
                  }}
                  onClick={() =>
                    (signer.status === "pending" || signer.status === "error") &&
                    void signWithKey(i)
                  }
                >
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 500, color: colors.text }}>
                      {signer.key.label}
                    </div>
                    <div style={{ fontSize: 15, color: colors.muted }}>
                      {signer.key.persona} / {signer.key.fingerprint}
                      {signer.key.testMnemonic ? " / test key" : ""}
                    </div>
                    {signer.error && (
                      <div style={{ fontSize: 15, color: colors.red, marginTop: 4 }}>
                        {signer.error} -- tap to retry
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: accent }}>
                    {statusIcon}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* "Sign via Tapit" (Cut B stage B2 -- window.open a new tab to
            Tapit's /sign route) is retired from this vault flow: it forced
            a fresh browser tab to re-establish its own Tapit session,
            which read as "trying to log me in" (operator, 2026-08-08).
            NotifyCircleViaNostr below does the same job silently over
            Nostr with no navigation and no second tab. 2026-08-15: the
            Tranche distribution-wallet claim flow (TrancheClaimModal,
            below in this file) hit the identical bug and got the same
            fix -- startTapitCosign/lib/tapit-cosign.ts's window.open
            cross-tab bridge has no remaining caller anywhere in this
            repo as of that fix. */}
        {/* Enough signatures: Broadcast is the next thing, right here
            (operator, 2026-11-25: "No buried ... buttons"). The other ways
            to sign are no longer needed. */}
        {quorumMet && err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}
        {quorumMet && (
          <Button
            disabled={busy}
            style={{ background: colors.green, width: "100%", padding: "14px", fontSize: 18, minHeight: 52 }}
            onClick={() => void broadcast()}
          >
            {busy ? "Broadcasting..." : err ? "Retry broadcast" : "Broadcast transaction"}
          </Button>
        )}

        {!quorumMet && (
        <NotifyCircleViaNostr
          subjectId={signing.proposal_id ?? ""}
          psbtHex={signing.psbt_hex}
          vaultDescriptor={vault.descriptor}
          vaultName={vault.name}
          signers={signing.signers}
          onSigned={(hex, label) => externalImport(hex, label)}
        />
        )}

        {/* Hardware wallet / external PSBT */}
        {!quorumMet && (
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
            Sign with hardware wallet
          </div>
          <div style={{ fontSize: 16, color: colors.muted, marginBottom: 14 }}>
            Export this transaction to your signing device, then paste or scan the signed result back here.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 16 }}
              onClick={() => copyPsbt(signing.psbt_hex, "hex")}
            >
              {copied === "hex" ? "Copied!" : "Copy PSBT hex"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 16 }}
              onClick={() => copyPsbt(signing.psbt_b64, "b64")}
            >
              {copied === "b64" ? "Copied!" : "Copy base64"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 16 }}
              onClick={() => setShowQrDisplay(s => !s)}
            >
              {showQrDisplay ? "Hide QR" : "Show QR"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 16 }}
              onClick={() => setShowQrScanner(s => !s)}
            >
              {showQrScanner ? "Hide scanner" : "Scan signed QR"}
            </Button>
          </div>
          {showQrDisplay && (
            <div style={{ marginBottom: 14 }}>
              <PsbtQrDisplay psbtHex={signing.psbt_hex} />
              <div style={{ fontSize: 15, color: colors.muted, marginTop: 6, textAlign: "center" }}>
                UR `crypto-psbt` animated. Stateless -- no pairing needed. Point your air-gapped signer at the screen.
              </div>
              <SeedSignerNetworkHint network={vault.network} />
            </div>
          )}
          {showQrScanner && (
            <div style={{ marginBottom: 14 }}>
              <PsbtQrScanner
                onResult={hex => {
                  setShowQrScanner(false);
                  // Reuse the existing import path so signer-sessions
                  // logging + state-set logic stays in one place.
                  externalImport(hex);
                }}
                onCancel={() => setShowQrScanner(false)}
              />
            </div>
          )}
          <ExternalPsbtInput onImport={externalImport} />
        </div>
        )}

        {/* Still short: how many more, under the ways to sign. */}
        {err && !quorumMet && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}
        {!quorumMet && (
          <div style={{ fontSize: 17, color: colors.muted, textAlign: "center", padding: "10px 0" }}>
            {needed} more signature{needed !== 1 ? "s" : ""} needed
          </div>
        )}

        <Button
          variant="ghost"
          style={{ width: "100%", marginTop: 20, minHeight: 44, color: colors.red }}
          onClick={() => void cancelSpend()}
        >
          Cancel this spend
        </Button>
        {signing?.proposal_id && !signing.txid && (
          <Button
            variant="ghost"
            style={{ width: "100%" }}
            onClick={leaveOpen}
          >
            Leave it open for the others to sign
          </Button>
        )}
      </div>
    );
}
