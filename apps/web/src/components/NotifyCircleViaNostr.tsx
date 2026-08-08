import { useEffect, useRef, useState } from "react";
import { NostrTransport, type Subscription } from "@dynastytrust/nostr-transport";
import { sendPsbtCosignRequestOverNostr, DEFAULT_RELAYS } from "../lib/tapit-nostr-cosign";
import { subscribePsbtCosignResponses } from "../lib/psbt-cosign-response-channel";
import type { LocalKey } from "../lib/keystore";
import { colors } from "../theme";
import { Button } from "./ui";
import { useToast } from "./toast";

// Cut B3 slice 2 -- delivers the current proposal straight into each Tapit
// circle member's encrypted Nostr inbox (no link to hand them by hand),
// then keeps a long-lived Nostr subscription open per notified signer,
// listening for that specific signer's signed-PSBT response
// (psbtCosignResponseChannel.ts, tapit-wallet repo) and handing it to the
// caller via `onSigned` -- VaultDetail's SendTab merges it into the live
// signing session; ProposalDetail persists it via signerSessions.submit so
// it's visible to every member viewing that proposal, not just this tab.
// The subscription is addressed to the ephemeral reply keypair minted for
// THAT specific request (sendPsbtCosignRequestOverNostr's return value), so
// a response can only ever match the request it actually answers.
export function NotifyCircleViaNostr({
  psbtHex, vaultDescriptor, vaultName, signers, onSigned,
}: {
  psbtHex: string;
  vaultDescriptor: string | null;
  vaultName: string;
  signers: Array<{ key: LocalKey; status: "pending" | "signing" | "signed" | "error"; error?: string }>;
  onSigned: (psbtHex: string, label: string) => void;
}) {
  const toast = useToast();
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [status, setStatus] = useState<Map<string, "sent" | "queued" | "signed">>(new Map());
  const transportRef = useRef<NostrTransport | null>(null);
  const subsRef = useRef<Subscription[]>([]);

  useEffect(() => {
    return () => {
      for (const sub of subsRef.current) sub.close();
      subsRef.current = [];
      transportRef.current?.close();
      transportRef.current = null;
    };
  }, []);

  const pending = signers.filter(
    s => s.key.origin === "tapit" && s.key.tapitXOnlyPubkey && s.status !== "signed",
  );
  if (pending.length === 0) return null;

  async function notify(key: LocalKey) {
    setBusyKeyId(key.keyId);
    try {
      const result = await sendPsbtCosignRequestOverNostr({
        psbtHex,
        vaultContext: { vault_descriptor: vaultDescriptor ?? "", vault_name: vaultName },
        recipientXOnlyPubkey: key.tapitXOnlyPubkey!,
      });
      setStatus(prev => new Map(prev).set(key.keyId, result.delivered ? "sent" : "queued"));
      toast.success(
        result.delivered
          ? `Notified ${key.label} via Nostr`
          : `Queued for ${key.label} -- no relay confirmed yet, will keep retrying`,
      );

      if (!transportRef.current) {
        transportRef.current = new NostrTransport({ relays: DEFAULT_RELAYS });
      }
      const sub = subscribePsbtCosignResponses(transportRef.current, result.replyPrivateKey, item => {
        setStatus(prev => new Map(prev).set(key.keyId, "signed"));
        toast.success(`${key.label} signed -- merged in`);
        onSigned(item.psbtHex, key.label);
      });
      subsRef.current.push(sub);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to notify");
    } finally {
      setBusyKeyId(null);
    }
  }

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 20,
        marginBottom: 16,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
        Notify circle via Nostr
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 14 }}>
        Delivers the spend request straight into each signer's Tapit inbox -- no link to hand
        them by hand. They still verify with you by phone before signing; once they do, their
        signature merges in here automatically.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {pending.map(s => (
          <div key={s.key.keyId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 13, color: colors.text, minWidth: 0 }}>
              {s.key.label} <span style={{ color: colors.muted }}>({s.key.persona})</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 12, flexShrink: 0 }}
              disabled={busyKeyId === s.key.keyId || status.get(s.key.keyId) === "signed"}
              onClick={() => void notify(s.key)}
            >
              {status.get(s.key.keyId) === "signed"
                ? "Signed"
                : status.get(s.key.keyId) === "sent"
                  ? "Waiting for signature..."
                  : status.get(s.key.keyId) === "queued"
                    ? "Queued -- retrying"
                    : busyKeyId === s.key.keyId
                      ? "Sending..."
                      : "Notify via Nostr"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
