import { useEffect, useState, useCallback, useMemo } from "react";
import { api, type Vault, type VaultMember } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useToast } from "../../components/toast";
import { useConfirm } from "../../components/dialog";
import { colors, fonts, radii, } from "../../theme";
import { Button, Textarea } from "../../components/ui";
import { useRealtimeRefresh } from "../../lib/realtime";
import {
  encryptMessage,
  decryptMessage,
  getMessagingPubkey,
  messagingKeyLocked,
  messagingKeyUsesFaceId,
  unlockMessagingKey,
  lockMessagingKey,
  unlockMessagingKeyForGood,
  regenerateMessagingKey,
} from "../../lib/messaging";
import { passkeysAvailable } from "../../lib/passkey";
import { MessagingSafetyPanel, type PeerKey } from "../../components/MessagingSafetyPanel";
import { peerKeyStatus, senderKeyMatches } from "../../lib/messaging-safety";
import { MessagingKeyBackupPanel } from "../../components/MessagingKeyBackupPanel";


// // -- MessagesTab
// E2E encrypted thread per vault. Messages are encrypted client-
// side with X25519 + ChaCha20-Poly1305 (see lib/messaging.ts).
// Server only stores ciphertext + per-recipient wrapped keys.
// Each member publishes their X25519 pubkey via the self-heal in
// VaultDetailInner on first visit; members without a pubkey
// published yet are listed so the sender knows who won't be
// able to read the message until they come online.

export function MessagesTab({ vault }: { vault: Vault }) {
  const toast = useToast();
  const askConfirm = useConfirm();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [messages, setMessages] = useState<VaultMessage[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [showKeyReset, setShowKeyReset] = useState(false);
  const [keyBackupRefresh, setKeyBackupRefresh] = useState(0);
  // Face ID for messages (operator, 2026-11-13: "Make browser keys Face
  // ID for everything important"). A locked key opens once per visit,
  // on a tap -- Safari only shows Face ID in answer to one.
  // Read live each render; faceTick forces a redraw after a change.
  const [, setFaceTick] = useState(0);
  const keyLocked = messagingKeyLocked();
  const usesFaceId = messagingKeyUsesFaceId();
  const [faceBusy, setFaceBusy] = useState(false);

  useEffect(() => {
    // Ensure local keypair exists before rendering (public half only:
    // never needs Face ID).
    getMessagingPubkey();
    supabase.auth.getSession().then(({ data }) =>
      setMyUserId(data.session?.user.id ?? null),
    );
  }, []);

  const load = useCallback(async () => {
    try {
      const [m, msg] = await Promise.all([
        api.members.list(vault.id),
        api.messages.list(vault.id),
      ]);
      setMembers(m.members);
      setMessages(msg.messages);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load messages");
    }
  }, [vault.id, toast]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeRefresh({ table: "vault_messages", filter: `vault_id=eq.${vault.id}` }, () => void load());

  const keyedMembers = members.filter(
    m => m.status === "active" && m.user_id && m.messaging_pubkey,
  );
  const pendingMembers = members.filter(
    m => m.status === "active" && m.user_id && !m.messaging_pubkey,
  );
  // Threat model E: every OTHER member's messaging key against the one this
  // phone first saw (lib/messaging-safety.ts). A changed key pauses sending
  // to them until the safety code is compared by voice.
  const [safetyTick, setSafetyTick] = useState(0);
  const peers = useMemo<PeerKey[]>(() => {
    void safetyTick;
    if (!myUserId) return [];
    const seen = new Set<string>();
    return members
      .filter(m => m.status === "active" && m.user_id && m.messaging_pubkey)
      .filter(m => m.user_id !== myUserId && !seen.has(m.user_id) && seen.add(m.user_id))
      .map(m => ({ member: m, pubkey: m.messaging_pubkey!, status: peerKeyStatus(vault.id, m.user_id, m.messaging_pubkey!) }));
  }, [members, myUserId, vault.id, safetyTick]);
  const pausedIds = new Set(peers.filter(p => p.status === "changed").map(p => p.member.user_id));
  const sendable = keyedMembers.filter(m => !pausedIds.has(m.user_id));

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !myUserId) return;
    setBusy(true);
    try {
      // Never to a member whose key changed and has not been checked again.
      const recipients = sendable
        .filter(m => m.messaging_pubkey)
        .map(m => ({ user_id: m.user_id, pubkey: m.messaging_pubkey! }));
      if (recipients.length === 0) {
        toast.error("No members have published a messaging key yet.");
        return;
      }
      if (messagingKeyLocked()) { await unlockMessagingKey(); setFaceTick(n => n + 1); }
      const enc = encryptMessage(draft.trim(), recipients);
      await api.messages.send({
        vault_id: vault.id,
        sender_pubkey: enc.sender_pubkey,
        nonce: enc.nonce,
        ciphertext: enc.ciphertext,
        recipients: enc.recipients,
      });
      setDraft("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  async function rekey() {
    if (!(await askConfirm({ title: "Regenerate messaging key", message: "Regenerate your messaging key? You will lose access to messages sent with your current key unless you back up the new one too.", confirmLabel: "Regenerate", danger: true }))) return;
    regenerateMessagingKey();
    setFaceTick(n => n + 1);
    setShowKeyReset(false);
    setKeyBackupRefresh(n => n + 1);
    void load();
  }

  async function faceId(action: "unlock" | "lock" | "off") {
    setFaceBusy(true);
    try {
      if (action === "unlock") await unlockMessagingKey();
      if (action === "lock") {
        await lockMessagingKey();
        toast.success("Your messages are now locked with Face ID.");
      }
      if (action === "off") {
        if (!(await askConfirm({ title: "Stop using Face ID for messages", message: "Your messaging key will be kept in this browser without Face ID again. Anyone who can open this browser could read your messages.", confirmLabel: "Stop using Face ID" }))) return;
        await unlockMessagingKeyForGood();
        toast.success("Messages no longer need Face ID.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Face ID did not work");
    } finally {
      setFaceTick(n => n + 1);
      setFaceBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {keyLocked && (
        <div style={{ padding: "12px 14px", background: colors.surface, border: `1px solid ${colors.gold}55`, borderRadius: radii.md, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 17, color: colors.text, lineHeight: 1.5 }}>
            Your messages are locked with Face ID. Unlock them to read and send on this visit.
          </div>
          <Button style={{ minHeight: 44 }} disabled={faceBusy} onClick={() => void faceId("unlock")}>
            {faceBusy ? "Waiting for Face ID..." : "Unlock messages with Face ID"}
          </Button>
        </div>
      )}
      <div
        style={{
          padding: "10px 12px",
          background: colors.gold + "0C",
          border: `1px solid ${colors.gold}33`,
          borderRadius: radii.sm,
          fontSize: 16,
          color: colors.sub,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: colors.gold }}>End-to-end encrypted.</strong> Messages are sealed to each recipient's X25519 key before they leave your browser. The server stores ciphertext only and cannot read them.
      </div>

      <MessagingSafetyPanel vaultId={vault.id} peers={peers} onChanged={() => setSafetyTick(n => n + 1)} />

      <MessagingKeyBackupPanel refreshToken={keyBackupRefresh} onRestored={() => { setFaceTick(n => n + 1); void load(); }} />

      {pendingMembers.length > 0 && (
        <div
          style={{
            padding: "8px 12px",
            background: colors.orange + "0C",
            border: `1px solid ${colors.orange}33`,
            borderRadius: radii.sm,
            fontSize: 16,
            color: colors.sub,
          }}
        >
          Waiting for a messaging key from: {pendingMembers.map(m => m.label || "(unlabeled)").join(", ")}. They will be able to read your messages once they open the vault.
        </div>
      )}

      <form
        onSubmit={send}
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <Textarea
          rows={3}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={`Message to ${sendable.length} member${sendable.length === 1 ? "" : "s"}...`}
        />
        {keyedMembers.length === 0 && (
          <div style={{ fontSize: 16, color: colors.orange, lineHeight: 1.5 }}>
            {pendingMembers.length > 0
              ? `Can't send yet -- ${pendingMembers.length} member${pendingMembers.length === 1 ? " hasn't" : "s haven't"} opened this vault to publish a messaging key. Messages are end-to-end encrypted to each recipient, so everyone must visit the vault once first.`
              : "No other members can receive messages yet. Invite co-signers from the Members tab; each publishes a messaging key the first time they open the vault."}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 15, color: colors.muted }}>
            {sendable.length} recipient{sendable.length === 1 ? "" : "s"}
            {pausedIds.size > 0 ? ` (${pausedIds.size} paused: key changed)` : ""}
            {pendingMembers.length > 0 && keyedMembers.length > 0
              ? ` (${pendingMembers.length} not ready)`
              : ""}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              style={{ fontSize: 15 }}
              onClick={() => setShowKeyReset(s => !s)}
            >
              {showKeyReset ? "Cancel" : "Key settings"}
            </Button>
            <Button type="submit" disabled={busy || !draft.trim() || sendable.length === 0}>
              {busy ? "Sending..." : "Send"}
            </Button>
          </div>
        </div>
        {showKeyReset && (
          <div
            style={{
              fontSize: 15,
              color: colors.muted,
              padding: "8px 10px",
              background: colors.bg,
              borderRadius: radii.sm,
            }}
          >
            Your messaging pubkey: <span style={{ fontFamily: fonts.mono }}>{getMessagingPubkey().slice(0, 16)}...{getMessagingPubkey().slice(-8)}</span>
            <div style={{ marginTop: 6 }}>
              <Button
                variant="danger"
                size="sm"
                type="button"
                style={{ fontSize: 15 }}
                onClick={rekey}
              >
                Regenerate key
              </Button>
              <span style={{ marginLeft: 8 }}>Deletes your local private key. Past messages become unreadable.</span>
            </div>
            {usesFaceId ? (
              <div style={{ marginTop: 10 }}>
                <span style={{ display: "block", marginBottom: 6 }}>Locked with Face ID: reading messages on this phone needs your face once per visit.</span>
                <Button variant="ghost" size="sm" type="button" style={{ fontSize: 15, minHeight: 44 }} disabled={faceBusy} onClick={() => void faceId("off")}>
                  Stop using Face ID for messages
                </Button>
              </div>
            ) : passkeysAvailable() ? (
              <div style={{ marginTop: 10 }}>
                <span style={{ display: "block", marginBottom: 6 }}>Lock your messaging key with Face ID, so this phone needs your face before it can read your messages. Keep your passphrase backup above too: Face ID stays with this phone and your iCloud passkeys.</span>
                <Button size="sm" type="button" style={{ fontSize: 15, minHeight: 44 }} disabled={faceBusy} onClick={() => void faceId("lock")}>
                  {faceBusy ? "Waiting for Face ID..." : "Lock messages with Face ID"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </form>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 17, color: colors.muted, textAlign: "center", padding: "24px 0" }}>
            No messages yet. Trustees + beneficiaries use this thread for off-chain coordination -- visible only to vault members.
          </div>
        )}
        {messages.map(m => {
          const plaintext = myUserId ? decryptMessage(m, myUserId) : null;
          const sender = members.find(mem => mem.user_id === m.sender_user_id);
          const senderLabel = sender?.label || "(unknown)";
          const mine = m.sender_user_id === myUserId;
          // Threat model E: a message sealed with a key other than the one
          // this phone remembers for its sender is labelled, not hidden.
          const keyMismatch = !mine && senderKeyMatches(vault.id, m.sender_user_id, m.sender_pubkey) === false;
          return (
            <div
              key={m.id}
              style={{
                padding: "10px 12px",
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderLeft: mine ? `3px solid ${colors.gold}` : `3px solid ${colors.blue}`,
                borderRadius: radii.md,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: colors.muted, marginBottom: 4 }}>
                <span>
                  <strong style={{ color: mine ? colors.gold : colors.text }}>{senderLabel}</strong>
                  {sender?.role ? ` . ${sender.role}` : ""}
                </span>
                <span>{new Date(m.created_at).toLocaleString()}</span>
              </div>
              {keyMismatch && (
                <div style={{ fontSize: 15, color: colors.red, lineHeight: 1.5, marginBottom: 4 }}>
                  Sent with a different key than the one this phone knows for {senderLabel}. Do not act on it until you have
                  compared your safety code with them by voice.
                </div>
              )}
              <div style={{ fontSize: 17, color: colors.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {plaintext !== null ? plaintext : (
                  <span style={{ color: colors.muted, fontStyle: "italic" }}>
                    {keyLocked && m.recipients.some((r: { user_id: string }) => r.user_id === myUserId)
                      ? "(locked -- unlock your messages with Face ID above)"
                      : m.recipients.some(r => r.user_id === myUserId)
                      ? "(cannot decrypt -- your messaging key may have changed)"
                      : "(not encrypted to this browser)"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
