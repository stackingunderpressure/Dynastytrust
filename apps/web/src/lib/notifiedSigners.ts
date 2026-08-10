import { idb } from './idb';

/**
 * notifiedSigners.ts -- durable "have I already asked this signer" record.
 *
 * NotifyCircleViaNostr's status Map lives in React state, which resets on
 * every remount -- reload the proposal page, or navigate away and back, and
 * a signer who was already notified shows the plain "Notify via Nostr"
 * button again, identical to a signer who's never been asked, with no way
 * to tell the two apart (operator, 2026-08-08: "it acts like it's the first
 * time you've been there instead of acknowledging you sent but offering to
 * resend"). Note this deliberately does NOT let a reload resume LISTENING
 * for that old request's response -- the reply keypair is ephemeral and
 * never persisted (tapit-nostr-cosign.ts's own stated discipline), so an
 * old in-flight request's response subscription is genuinely gone once the
 * page reloads. What this restores is only the acknowledgment that a
 * request already went out, so the UI can offer "notify again" instead of
 * silently pretending nothing happened.
 *
 * Tracks a running sentCount, not just a binary flag -- operator, 2026-08-08,
 * on why a single "notified earlier" label wasn't enough: "the app knows
 * the state the button is in. You've already sent seven messages and
 * you've got no received." A count the owner can actually read (sent 7,
 * received 0) is the honest signal that something downstream of DynastyTrust
 * is broken, versus a plain label that looks identical whether this is
 * attempt #1 or #7.
 */

interface NotifiedRecord {
  sentCount: number;
  firstSentAt: string;
  lastSentAt: string;
  delivered: boolean;
}

const KEY = (subjectId: string, recipientPubkey: string) =>
  `notified-signer:${subjectId}:${recipientPubkey.toLowerCase()}`;

export const notifiedSigners = {
  async get(subjectId: string, recipientPubkey: string): Promise<NotifiedRecord | null> {
    return (await idb.get<NotifiedRecord>(KEY(subjectId, recipientPubkey))) ?? null;
  },

  async mark(subjectId: string, recipientPubkey: string, delivered: boolean): Promise<NotifiedRecord> {
    const key = KEY(subjectId, recipientPubkey);
    const prior = await idb.get<NotifiedRecord>(key);
    const now = new Date().toISOString();
    const next: NotifiedRecord = {
      sentCount: (prior?.sentCount ?? 0) + 1,
      firstSentAt: prior?.firstSentAt ?? now,
      lastSentAt: now,
      delivered,
    };
    await idb.put(key, next);
    return next;
  },
};
