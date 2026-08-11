import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  getMessagingPubkey,
  hasLocalMessagingKey,
  installMessagingKey,
  wrapMessagingKeyForBackup,
  unwrapMessagingKeyFromBackup,
} from "../lib/messaging";
import { colors, radii } from "../theme";
import { Button, Input } from "./ui";
import { useToast } from "./toast";

// Operator, 2026-08-11, reading the Messages tab's own warning ("clearing
// site data wipes your ability to read past messages"): "Need to fix the
// messaging to be Encrypted and all saved to supa base. Not browser."
// The private key itself still never leaves the browser in the clear --
// that would defeat end-to-end encryption -- but it no longer has to live
// ONLY in localStorage with no way back. The operator sets a recovery
// passphrase once; the browser wraps the private key with it (AES-256-GCM
// + PBKDF2, same posture keystore.ts already uses for "secure mode"
// Bitcoin keys) and stores only that ciphertext in Supabase
// (messaging-key-backup.js / db/migrations/030_messaging_key_backup.sql).
// Opening the vault from a new browser or after clearing storage: enter
// the same passphrase, and the exact same key comes back -- every past
// message becomes readable again instead of permanently lost.
type State =
  | { kind: "checking" }
  | { kind: "in-sync" }
  | { kind: "no-backup" }
  | { kind: "mismatch" }
  | { kind: "error"; detail: string };

export function MessagingKeyBackupPanel({
  refreshToken,
  onRestored,
}: {
  /** Bump this to force a re-check (e.g. right after "Regenerate key"). */
  refreshToken?: number;
  onRestored?: () => void;
}) {
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "checking" });
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const { backup } = await api.messagingKeyBackup.get();
      if (!backup) {
        setState({ kind: "no-backup" });
        return;
      }
      const localPub = hasLocalMessagingKey() ? getMessagingPubkey() : null;
      setState(localPub === backup.pubkey ? { kind: "in-sync" } : { kind: "mismatch" });
    } catch (e) {
      setState({ kind: "error", detail: e instanceof Error ? e.message : "Could not check backup status" });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check, refreshToken]);

  async function backUp() {
    if (passphrase.length < 8) {
      toast.error("Use at least 8 characters for your recovery passphrase.");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      toast.error("Passphrases don't match.");
      return;
    }
    setBusy(true);
    try {
      const { pubkey, blob } = await wrapMessagingKeyForBackup(passphrase);
      await api.messagingKeyBackup.save({
        pubkey,
        wrapped_priv_b64: blob.ciphertextB64,
        salt_b64: blob.saltB64,
        nonce_b64: blob.nonceB64,
      });
      setPassphrase("");
      setConfirmPassphrase("");
      toast.success("Messaging key backed up. Use this passphrase to restore it on any other browser.");
      await check();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backup failed");
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!passphrase) {
      toast.error("Enter your recovery passphrase.");
      return;
    }
    setBusy(true);
    try {
      const { backup } = await api.messagingKeyBackup.get();
      if (!backup) {
        toast.error("No backup found on this account.");
        return;
      }
      const { priv, pub } = await unwrapMessagingKeyFromBackup(
        {
          version: 1,
          saltB64: backup.salt_b64,
          nonceB64: backup.nonce_b64,
          ciphertextB64: backup.wrapped_priv_b64,
        },
        passphrase,
      );
      installMessagingKey(priv, pub);
      setPassphrase("");
      toast.success("Messaging key restored -- your past messages should decrypt now.");
      onRestored?.();
      await check();
    } catch {
      toast.error("Wrong passphrase, or the backup is corrupted.");
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "checking") return null;

  if (state.kind === "in-sync") {
    return (
      <div style={{ fontSize: 11, color: colors.muted }}>
        Messaging key backed up -- readable from any browser with your recovery passphrase.
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={{ fontSize: 11, color: colors.muted }}>
        Could not check messaging-key backup status ({state.detail}).
      </div>
    );
  }

  const isMismatch = state.kind === "mismatch";

  return (
    <div
      style={{
        padding: "10px 12px",
        background: colors.orange + "0C",
        border: `1px solid ${colors.orange}33`,
        borderRadius: radii.sm,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, color: colors.sub, lineHeight: 1.5 }}>
        {isMismatch ? (
          <>
            <strong style={{ color: colors.orange }}>This browser doesn't have your saved messaging key.</strong>{" "}
            You have a backup on your account from another browser or device -- enter its recovery passphrase to
            restore it, or your past messages there will stay unreadable here.
          </>
        ) : (
          <>
            <strong style={{ color: colors.orange }}>Your messaging key isn't backed up.</strong> Clearing this
            browser's storage or switching devices will permanently lose access to past messages. Set a recovery
            passphrase to save an encrypted backup -- the server only ever sees ciphertext, never the passphrase
            or the key itself.
          </>
        )}
      </div>
      <Input
        type="password"
        placeholder="Recovery passphrase"
        value={passphrase}
        onChange={e => setPassphrase(e.target.value)}
        style={{ fontSize: 12 }}
      />
      {!isMismatch && (
        <Input
          type="password"
          placeholder="Confirm passphrase"
          value={confirmPassphrase}
          onChange={e => setConfirmPassphrase(e.target.value)}
          style={{ fontSize: 12 }}
        />
      )}
      <Button
        variant="primary"
        size="sm"
        type="button"
        disabled={busy}
        onClick={() => void (isMismatch ? restore() : backUp())}
        style={{ alignSelf: "flex-start", fontSize: 12 }}
      >
        {busy ? "Working..." : isMismatch ? "Restore my key" : "Back up now"}
      </Button>
    </div>
  );
}
