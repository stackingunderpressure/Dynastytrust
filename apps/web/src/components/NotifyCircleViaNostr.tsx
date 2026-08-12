import { useEffect, useRef, useState } from "react";
import { NostrTransport, type Subscription } from "@dynastytrust/nostr-transport";
import { sendPsbtCosignRequestOverNostr, DEFAULT_RELAYS } from "../lib/tapit-nostr-cosign";
import { subscribePsbtCosignResponses } from "../lib/psbt-cosign-response-channel";
import { notifiedSigners } from "../lib/notifiedSigners";
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
//
// `subjectId` (the proposal id) + notifiedSigners.ts give this a durable,
// per-signer "already asked" memory that survives a reload -- without it,
// every remount showed a blank "Notify via Nostr" button regardless of
// history, indistinguishable from never having sent anything (operator,
// 2026-08-08). A reload can't resume the OLD listening subscription (the
// reply key is ephemeral and never persisted, by design), so a previously-
// notified signer gets an honest "sent Nx, no response yet" rather than a
// fake "still listening" state or a plain relabeled button (operator:
// "not just another label on the button ... the app knows the state the
// button is in. You've already sent seven messages and you've got no
// received").
interface SignerStatus {
  phase: "sent" | "queued" | "signed" | "known";
  sentCount: number;
}

// 2026-08-11 fix (operator: "Notify circle is lacking a lot also. No
// confirmed message or signature received... Green check mark or
// something confirming it's signed"): the status line used to collapse
// every non-signed state into the same "no response yet" text --
// "queued, no relay has even accepted the request" and "delivered,
// waiting on a human to pick up the phone" read identically, and
// "signed" was only a color change on plain text, easy to miss at a
// glance. Four honestly distinct states now get their own icon, label,
// and color.
function statusMeta(st: SignerStatus | undefined): { icon: string; label: string; color: string } | null {
  if (!st) return null;
  switch (st.phase) {
    case "signed":
      return { icon: "✓", label: "Signed -- merged in", color: colors.green };
    case "sent":
      return { icon: "●", label: "Delivered -- awaiting signature", color: colors.blue };
    case "queued":
      return { icon: "⏳", label: "Queued -- no relay has confirmed yet, retrying", color: colors.orange };
    case "known":
      return {
        icon: "•",
        label: `Sent ${st.sentCount}x previously -- delivery status unknown from before this page loaded, no response yet`,
        color: colors.muted,
      };
  }
}

export function NotifyCircleViaNostr({
  subjectId, psbtHex, vaultDescriptor, vaultName, signers, onSigned,
}: {
  /** Stable id this notification is about (the proposal id) -- keys the
   *  durable "already notified" record so it survives a reload. */
  subjectId: string;
  psbtHex: string;
  vaultDescriptor: string | null;
  vaultName: string;
  signers: Array<{ key: LocalKey; status: "pending" | "signing" | "signed" | "error"; error?: string }>;
  onSigned: (psbtHex: string, label: string) => void;
}) {
  const toast = useToast();
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [status, setStatus] = useState<Map<string, SignerStatus>>(new Map());
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

  // Load prior-notification state once per subjectId. Never overwrites a
  // status this session already set (a fresh send/response takes priority
  // over history read from before this mount).
  useEffect(() => {
    if (!subjectId) return;
    let cancelled = false;
    void Promise.all(
      pending.map(async s => {
        const record = await notifiedSigners.get(subjectId, s.key.tapitXOnlyPubkey!);
        return { keyId: s.key.keyId, record };
      }),
    ).then(results => {
      if (cancelled) return;
      setStatus(prev => {
        const next = new Map(prev);
        for (const { keyId, record } of results) {
          if (record && !next.has(keyId)) {
            next.set(keyId, { phase: "known", sentCount: record.sentCount });
          }
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId]);

  if (pending.length === 0) return null;

  async function notify(key: LocalKey) {
    setBusyKeyId(key.keyId);
    try {
      const result = await sendPsbtCosignRequestOverNostr({
        psbtHex,
        vaultContext: { vault_descriptor: vaultDescriptor ?? "", vault_name: vaultName },
        recipientXOnlyPubkey: key.tapitXOnlyPubkey!,
      });
      const record = await notifiedSigners.mark(subjectId, key.tapitXOnlyPubkey!, result.delivered);
      setStatus(prev =>
        new Map(prev).set(key.keyId, {
          phase: result.delivered ? "sent" : "queued",
          sentCount: record.sentCount,
        }),
      );
      toast.success(
        result.delivered
          ? `Notified ${key.label} via Nostr (sent ${record.sentCount}x)`
          : `Queued for ${key.label} -- no relay confirmed yet, will keep retrying`,
      );

      if (!transportRef.current) {
        transportRef.current = new NostrTransport({ relays: DEFAULT_RELAYS });
      }
      const sub = subscribePsbtCosignResponses(transportRef.current, result.replyPrivateKey, item => {
        setStatus(prev => {
          const priorCount = prev.get(key.keyId)?.sentCount ?? record.sentCount;
          return new Map(prev).set(key.keyId, { phase: "signed", sentCount: priorCount });
        });
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
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {pending.map(s => {
          const st = status.get(s.key.keyId);
          const received = st?.phase === "signed";
          const meta = statusMeta(st);
          return (
            <div
              key={s.key.keyId}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
            >
              <div style={{ fontSize: 13, color: colors.text, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {received && (
                    <span
                      aria-label="Signed"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 16,
                        height: 16,
                        borderRadius: "50%",
                        background: colors.green,
                        color: "#fff",
                        fontSize: 10,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      ✓
                    </span>
                  )}
                  <span>
                    {s.key.label} <span style={{ color: colors.muted }}>({s.key.persona})</span>
                  </span>
                </div>
                {meta && (
                  <div style={{ fontSize: 11, marginTop: 2, color: meta.color, display: "flex", alignItems: "center", gap: 4 }}>
                    <span aria-hidden>{meta.icon}</span>
                    <span>{meta.label}</span>
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                style={{ fontSize: 12, flexShrink: 0 }}
                disabled={busyKeyId === s.key.keyId || received}
                onClick={() => void notify(s.key)}
              >
                {received
                  ? "Signed"
                  : busyKeyId === s.key.keyId
                    ? "Sending..."
                    : st?.phase === "sent"
                      ? "Waiting for signature..."
                      : st?.phase === "queued"
                        ? "Queued -- retrying"
                        : (st?.sentCount ?? 0) > 0
                          ? "Notify again"
                          : "Notify via Nostr"}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
