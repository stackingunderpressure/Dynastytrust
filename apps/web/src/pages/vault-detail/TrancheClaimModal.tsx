import { useState } from "react";
import { PANEL_FIT } from "../../components/ui/panelFit";
import { useNavigate } from "react-router-dom";
import { api, type DistributionWallet, type DistributionTranche } from "../../lib/api";
import { keyNeedsPassword, listKeys, revealMnemonic, type LocalKey } from "../../lib/keystore";
import { keyNetworkMatches } from "../../lib/network";
import { signPsbtWithMnemonic, countSignatures, mergePsbts, verifyPsbtMatchesRequest } from "../../lib/psbt-signer";
import { broadcastTxUrl, explorerTxUrl } from "../../config";
import { useToast } from "../../components/toast";
import { usePrompt } from "../../components/dialog";
import { colors, fonts, space } from "../../theme";
import { Button, Input, Label } from "../../components/ui";
import { PsbtQrDisplay } from "../../components/PsbtQrDisplay";
import { PsbtQrScanner } from "../../components/PsbtQrScanner";
import { NotifyCircleViaNostr } from "../../components/NotifyCircleViaNostr";
import { ExternalPsbtInput } from "./ExternalPsbtInput";
import { satsToBtc } from "./shared";


// Claims a single tranche -- either the beneficiary after its
// timelock, or a trustee via the escape hatch. Deliberately mirrors
// SendTab's own build -> sign -> broadcast shape (same PSBT helpers,
// same hardware-wallet QR/paste block) rather than inventing a new
// pattern, since a tranche's PSBT is signed exactly the same way a
// main-vault PSBT is -- only the source script differs. Tapit signing
// (both the B2 cross-tab handoff and the B3 Nostr round trip) is wired
// in below, same as SendTab's -- this used to be out of scope, but
// nothing about a tranche claim's PSBT makes it any different to sign.
export function TrancheClaimModal({
  wallet,
  tranche,
  path,
  onClose,
  onClaimed,
}: {
  wallet: DistributionWallet;
  tranche: DistributionTranche;
  path: "beneficiary" | "trustee";
  onClose: () => void;
  onClaimed: () => void;
}) {
  const toast = useToast();
  const askPassword = usePrompt();
  const navigate = useNavigate();
  const [step, setStep] = useState<"form" | "signing" | "done">("form");
  const [dest, setDest] = useState("");
  const [sweepAll, setSweepAll] = useState(true);
  const [amountBtc, setAmountBtc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [psbtHex, setPsbtHex] = useState("");
  const [summary, setSummary] = useState<{ amount_sats: number; fee_sats: number; change_sats: number } | null>(null);
  const [signers, setSigners] = useState<Array<{ key: LocalKey; status: "pending" | "signing" | "signed" | "error"; error?: string }>>([]);
  const [signaturesCollected, setSignaturesCollected] = useState(0);
  const [txid, setTxid] = useState<string | null>(null);
  const [showQrDisplay, setShowQrDisplay] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  // 2026-08-12 (operator: "every PSBT has some kind of request tied to it
  // ... especially in the bigger vaults"): a Tranche claim used to
  // broadcast with zero request/vote/history trail at all -- no
  // proposals row, so this claim could never show up in the vault's
  // History tab or ProposalDetail's votes/discussion/audit view the way
  // every standard and Bloc spend already does. Filed as a real proposal
  // (path='tranche_claim') the moment the PSBT is built.
  const [proposalId, setProposalId] = useState<string | null>(null);

  const requiredSignatures = path === "beneficiary" ? 1 : wallet.trustee_quorum;
  const eligiblePubkeys = path === "beneficiary" ? [wallet.beneficiary_pubkey] : wallet.trustee_keys;

  async function build(e: React.FormEvent) {
    e.preventDefault();
    if (!dest.trim()) { setErr("Destination address required"); return; }
    const amount_sats = sweepAll ? undefined : Math.round(parseFloat(amountBtc || "0") * 1e8);
    if (!sweepAll && (!amount_sats || amount_sats < 546)) {
      setErr("Minimum 546 sats");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.distributionWallets.buildClaim({
        distribution_wallet_id: wallet.id,
        tranche_index: tranche.index,
        destination: dest.trim(),
        amount_sats,
        path,
      });
      if (res.status === "no_utxos") {
        setErr(res.message || "No confirmed funds at this tranche address yet.");
        setBusy(false);
        return;
      }
      // Same no-rogue-signing gate as the main Send flow: the claim must
      // spend only this tranche's own coins, pay exactly what was shown,
      // and return any change to the tranche address.
      const claimCheck = verifyPsbtMatchesRequest(res.psbt_hex, {
        destination: dest.trim(),
        amountSats: res.summary.amount_sats,
        network: wallet.network,
        ownAddress: tranche.address,
        feeSats: res.summary.fee_sats,
        changeSats: res.summary.change_sats,
      });
      if (!claimCheck.ok) {
        setErr(`Refusing to sign: ${claimCheck.reason}. This PSBT does not match what you requested -- try again, and contact support if this persists.`);
        setBusy(false);
        return;
      }
      setPsbtHex(res.psbt_hex);
      setSummary(res.summary);

      try {
        const { proposal } = await api.proposals.create({
          vault_id: wallet.vault_id,
          destination: dest.trim(),
          amount_sats: res.summary.amount_sats,
          fee_sats: res.summary.fee_sats,
          path: "tranche_claim",
          memo: `${wallet.name} tranche #${tranche.index + 1} claim (${path})`,
          psbt_hex: res.psbt_hex,
          distribution_wallet_id: wallet.id,
          tranche_index: tranche.index,
        });
        setProposalId(proposal.id);
      } catch {
        // Non-fatal: the claim can still be signed and broadcast without a
        // proposal row (matches the pre-2026-08-12 behavior) -- it just
        // won't show up in the vault's request history afterward.
      }

      // Tapit-origin keys hold no local key material and can never sign
      // in-browser, but they DO need to appear here so NotifyCircleViaNostr
      // below can find them and deliver the request to the right person's
      // Tapit inbox -- excluding them left that component with nothing to
      // ever show, and the standalone "Sign via Tapit" window.open button
      // that used to fill the gap forced a fresh browser tab to
      // re-establish its own Tapit session, which read as "trying to log
      // me in" (operator, 2026-08-08 on the main Send flow; 2026-08-15,
      // same bug, reported here). Matches the identical fix already
      // shipped for the main proposal signing flow above.
      const localKeys = listKeys().filter(
        k => k.status === "active" && (k.origin === "software" || k.origin === "tapit") && keyNetworkMatches(k.network, wallet.network),
      );
      const matching = localKeys.filter(k => eligiblePubkeys.includes(k.pubkey));
      setSigners(matching.map(key => ({ key, status: "pending" })));
      setSignaturesCollected(0);
      setStep("signing");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to build transaction");
    } finally {
      setBusy(false);
    }
  }

  async function signWithKey(index: number) {
    const entry = signers[index];
    setSigners(prev => prev.map((s, i) => (i === index ? { ...s, status: "signing" } : s)));
    try {
      let pw: string | undefined;
      if (keyNeedsPassword(entry.key)) {
        const result = await askPassword({
          title: "Unlock key",
          message: `Enter the password for "${entry.key.label}" to sign.`,
          password: true,
          confirmLabel: "Sign",
        });
        if (result === null) {
          setSigners(prev => prev.map((s, i) => (i === index ? { ...s, status: "pending" } : s)));
          return;
        }
        pw = result;
      }
      const mnemonic = await revealMnemonic(entry.key.keyId, pw);
      const result = await signPsbtWithMnemonic(psbtHex, mnemonic, entry.key.derivationPath, wallet.network);
      const merged = mergePsbts([psbtHex, result.psbt_hex]);
      setPsbtHex(merged);
      setSignaturesCollected(countSignatures(merged));
      setSigners(prev => prev.map((s, i) => (i === index ? { ...s, status: "signed" } : s)));
    } catch (e) {
      setSigners(prev =>
        prev.map((s, i) => (i === index ? { ...s, status: "error", error: e instanceof Error ? e.message : "Failed" } : s)),
      );
    }
  }

  function externalImport(importedHex: string) {
    const merged = mergePsbts([psbtHex, importedHex]);
    setPsbtHex(merged);
    setSignaturesCollected(countSignatures(merged));
  }

  async function broadcast() {
    setBusy(true);
    setErr(null);
    try {
      const finalized = await api.psbt.finalize(psbtHex);
      const res = await fetch(broadcastTxUrl(wallet.network), {
        method: "POST",
        body: finalized.raw_tx_hex,
        headers: { "Content-Type": "text/plain" },
      });
      const newTxid = (await res.text()).trim();
      if (!res.ok || newTxid.length !== 64) {
        throw new Error("Broadcast failed: " + newTxid.slice(0, 100));
      }

      try {
        const { wallets } = await api.distributionWallets.list(wallet.vault_id);
        const dw = wallets.find(w => w.id === wallet.id);
        if (dw) {
          const tranches = dw.tranches.map(t =>
            t.index === tranche.index ? { ...t, claimed_txid: newTxid } : t,
          );
          await api.distributionWallets.update(dw.id, { tranches });
        }
      } catch {
        /* non-fatal: the claim already broadcast; the row just won't
           show "claimed" until a manual refresh picks up the txid
           from chain state elsewhere. */
      }

      if (proposalId) {
        try {
          await api.proposals.update(proposalId, {
            status: "broadcast",
            psbt_hex: psbtHex,
            txid: newTxid,
          });
        } catch {
          /* non-fatal: the on-chain spend already succeeded; the request
             history just won't reflect the final signed PSBT/txid until a
             manual retry. */
        }
      }

      setTxid(newTxid);
      setStep("done");
      toast.success("Tranche claimed");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Broadcast failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        padding: space[4],
      }}
      onClick={e => {
        if (e.target === e.currentTarget && step !== "signing") onClose();
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: "28px 32px",
          width: "100%",
          maxWidth: 480,
          ...PANEL_FIT,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: colors.text }}>
          {path === "beneficiary" ? "Claim tranche" : "Trustee escape hatch"} -- {wallet.name} #{tranche.index + 1}
        </div>

        {step === "form" && (
          <form onSubmit={e => void build(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <Label>Send to</Label>
              <Input mono value={dest} onChange={e => setDest(e.target.value)} placeholder="Destination address" />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 17, color: colors.text }}>
              <input type="checkbox" checked={sweepAll} onChange={e => setSweepAll(e.target.checked)} />
              Sweep the full tranche balance
            </label>
            {!sweepAll && (
              <div>
                <Label>Amount (BTC)</Label>
                <Input mono value={amountBtc} onChange={e => setAmountBtc(e.target.value)} placeholder="0.00" />
              </div>
            )}
            {err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <Button type="submit" disabled={busy} style={{ flex: 1 }}>
                {busy ? "Building..." : "Build transaction"}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        )}

        {step === "signing" && summary && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 17, color: colors.muted }}>
              {satsToBtc(summary.amount_sats)} BTC + {summary.fee_sats} sats fee
              {summary.change_sats > 0 && <> . {satsToBtc(summary.change_sats)} BTC change</>}
            </div>
            <div style={{ fontSize: 16, color: colors.muted }}>
              {signaturesCollected} of {requiredSignatures} signature{requiredSignatures !== 1 ? "s" : ""} collected
            </div>

            {signers.some(s => s.key.origin !== "tapit") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {signers.map((signer, i) => {
                  if (signer.key.origin === "tapit") return null;
                  return (
                    <div
                      key={signer.key.keyId}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 12px",
                        border: `1px solid ${colors.border}`,
                        borderRadius: 8,
                        cursor: signer.status === "pending" || signer.status === "error" ? "pointer" : "default",
                        opacity: signer.status === "signing" ? 0.7 : 1,
                      }}
                      onClick={() => (signer.status === "pending" || signer.status === "error") && void signWithKey(i)}
                    >
                      <div>
                        <div style={{ fontSize: 17, color: colors.text }}>{signer.key.label}</div>
                        {signer.error && <div style={{ fontSize: 15, color: colors.red }}>{signer.error}</div>}
                      </div>
                      <div style={{ fontSize: 16, color: colors.muted }}>
                        {signer.status === "signed" ? "signed" : signer.status === "signing" ? "signing..." : "tap to sign"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* "Sign via Tapit" (window.open a new tab to Tapit's /sign
                route) is retired from this flow for the same reason it was
                already retired from the main Send flow above: it forced a
                fresh browser tab to re-establish its own Tapit session,
                which read as "trying to log me in." NotifyCircleViaNostr
                below does the same job silently over Nostr with no
                navigation and no second tab -- now that tapit-origin keys
                are included in `signers` above, it has something to show. */}
            <NotifyCircleViaNostr
              subjectId={`${wallet.id}-tranche-${tranche.index}`}
              psbtHex={psbtHex}
              vaultDescriptor={tranche.descriptor}
              vaultName={`${wallet.name} tranche ${tranche.index + 1}`}
              signers={signers}
              onSigned={hex => externalImport(hex)}
            />

            <div
              style={{
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
                Sign with hardware wallet
              </div>
              <div style={{ fontSize: 15, color: colors.muted, marginBottom: 10 }}>
                Export this transaction to your signing device, then paste or scan the signed result back here.
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <Button variant="ghost" size="sm" style={{ fontSize: 15 }} onClick={() => setShowQrDisplay(s => !s)}>
                  {showQrDisplay ? "Hide QR" : "Show QR"}
                </Button>
                <Button variant="ghost" size="sm" style={{ fontSize: 15 }} onClick={() => setShowQrScanner(s => !s)}>
                  {showQrScanner ? "Hide scanner" : "Scan signed QR"}
                </Button>
              </div>
              {showQrDisplay && (
                <div style={{ marginBottom: 10 }}>
                  <PsbtQrDisplay psbtHex={psbtHex} />
                </div>
              )}
              {showQrScanner && (
                <div style={{ marginBottom: 10 }}>
                  <PsbtQrScanner
                    onResult={hex => { setShowQrScanner(false); externalImport(hex); }}
                    onCancel={() => setShowQrScanner(false)}
                  />
                </div>
              )}
              <ExternalPsbtInput onImport={externalImport} />
            </div>

            {err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}

            {signaturesCollected >= requiredSignatures ? (
              <Button disabled={busy} style={{ background: colors.green }} onClick={() => void broadcast()}>
                {busy ? "Broadcasting..." : "Broadcast claim"}
              </Button>
            ) : (
              <div style={{ fontSize: 17, color: colors.muted, textAlign: "center" }}>
                {requiredSignatures - signaturesCollected} more signature{requiredSignatures - signaturesCollected !== 1 ? "s" : ""} needed
              </div>
            )}
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        )}

        {step === "done" && txid && (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.green, marginBottom: 8 }}>
              Tranche claimed
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.muted, wordBreak: "break-all", marginBottom: 14 }}>
              {txid}
            </div>
            <a href={explorerTxUrl(wallet.network, txid)} target="_blank" rel="noreferrer" style={{ color: colors.gold, fontSize: 17 }}>
              View on mempool.space
            </a>
            {proposalId && (
              <div style={{ marginTop: 10 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  style={{ fontSize: 16 }}
                  onClick={() => navigate(`/vaults/${wallet.vault_id}/proposals/${proposalId}`)}
                >
                  View votes & history
                </Button>
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <Button onClick={onClaimed}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
