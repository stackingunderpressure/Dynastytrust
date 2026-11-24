/**
 * reply-key-seal.ts -- keep the Nostr ack reply private key off the server in
 * readable form (zero-knowledge plan Z0). The key is wrapped to this browser's
 * own X25519 messaging key with the same scheme messages use
 * (lib/messaging.ts), under a fixed "self" recipient label. A messaging-key
 * backup restores it on a new device, like everything else sealed to it.
 *
 * Rows saved before this change still carry the readable `reply_privkey`;
 * openReplyKey accepts either.
 */
import { decryptMessage, encryptMessage, getMessagingPubkey, type EncryptedMessage } from './messaging';

const SELF = 'self';

export function sealReplyKey(replyPrivateKey: string): EncryptedMessage {
  return encryptMessage(JSON.stringify({ v: 1, reply_privkey: replyPrivateKey }), [
    { user_id: SELF, pubkey: getMessagingPubkey() },
  ]);
}

export function openReplyKey(row: { reply_privkey?: string | null; reply_privkey_sealed?: EncryptedMessage | null }): string | null {
  if (row.reply_privkey_sealed) {
    const plain = decryptMessage(row.reply_privkey_sealed, SELF);
    if (!plain) return null;
    try {
      const v = JSON.parse(plain) as { v?: number; reply_privkey?: string };
      return v.v === 1 && typeof v.reply_privkey === 'string' && /^[0-9a-f]{64}$/.test(v.reply_privkey) ? v.reply_privkey : null;
    } catch {
      return null;
    }
  }
  return row.reply_privkey ?? null;
}
