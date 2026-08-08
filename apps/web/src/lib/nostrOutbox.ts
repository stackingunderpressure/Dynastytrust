import type { TransportEvent } from '@dynastytrust/nostr-transport';
import { idb } from './idb';

/**
 * nostrOutbox.ts -- durable send queue for Nostr events DynastyTrust
 * publishes to a circle member's Tapit wallet (psbt-cosign requests,
 * circle-phrase-pair deliveries). Operator, 2026-08-08: "I wanna make sure
 * that any of the Nostr messages we're using are durable messages that
 * aren't lost... the wallet needs to be constantly aware of a message...
 * always looking for that message."
 *
 * BEFORE THIS: every send (tapit-nostr-cosign.ts, circle-phrase-delivery.ts)
 * opened a short-lived NostrTransport, published once, and closed it. If
 * every configured relay happened to be briefly unreachable (or the publish
 * simply timed out) the event was gone -- nothing retried it, and nothing
 * ever told the operator it hadn't actually gone out.
 *
 * WHAT "DELIVERED" MEANS HERE: DynastyTrust has no receive-side listener of
 * its own yet (it only ever sends over Nostr, never subscribes), so there is
 * no application-level "Tapit actually read this" acknowledgment to wait
 * for. What this queue retries until is the protocol-level guarantee that
 * actually matters: at least one configured relay accepted the event
 * (`PublishResult.accepted.length > 0`). Kind 9575-9577 all sit in NIP-01's
 * "regular events" range (1000-9999), which relays are expected to persist
 * and serve to any future subscriber matching the filter -- so once one
 * relay has accepted the event, Tapit will find it on its next subscribe
 * (which omits `since`, i.e. asks for full history) even if the wallet was
 * closed the entire time the event sat on that relay. That is the actual
 * durability property: not "delivered to a live listener," but "landed
 * somewhere a future listener will find it."
 *
 * The event is built and signed ONCE by the caller and stored here
 * verbatim; every retry republishes the identical signed event (Nostr
 * events are content-addressed and idempotent, so relays simply dedupe a
 * resend) rather than re-signing with a fresh ephemeral identity each time.
 */

export type OutboxState = 'pending' | 'sent';

export interface OutboxRow {
  /** = event.id. Also the idb key, so upserts are naturally keyed by event. */
  id: string;
  event: TransportEvent;
  relays: readonly string[];
  /** Human label for a status UI -- never security-relevant. */
  label: string;
  state: OutboxState;
  attempts: number;
  last_attempt: string | null;
  last_error: string | null;
  created_at: string;
}

const INDEX_KEY = 'nostr-outbox-index';
const ROW_KEY = (id: string) => `nostr-outbox:${id}`;

async function readIndex(): Promise<string[]> {
  return (await idb.get<string[]>(INDEX_KEY)) ?? [];
}

async function writeIndex(ids: string[]): Promise<void> {
  await idb.put(INDEX_KEY, ids);
}

export const nostrOutbox = {
  async enqueue(input: {
    event: TransportEvent;
    relays: readonly string[];
    label: string;
  }): Promise<OutboxRow> {
    const row: OutboxRow = {
      id: input.event.id,
      event: input.event,
      relays: input.relays,
      label: input.label,
      state: 'pending',
      attempts: 0,
      last_attempt: null,
      last_error: null,
      created_at: new Date().toISOString(),
    };
    await idb.put(ROW_KEY(row.id), row);
    const index = await readIndex();
    if (!index.includes(row.id)) {
      index.push(row.id);
      await writeIndex(index);
    }
    return row;
  },

  async all(): Promise<OutboxRow[]> {
    const index = await readIndex();
    const rows: OutboxRow[] = [];
    for (const id of index) {
      const row = await idb.get<OutboxRow>(ROW_KEY(id));
      if (row) rows.push(row);
    }
    return rows;
  },

  async pending(): Promise<OutboxRow[]> {
    return (await nostrOutbox.all()).filter(r => r.state === 'pending');
  },

  async markAttempt(id: string, error: string | null): Promise<void> {
    const row = await idb.get<OutboxRow>(ROW_KEY(id));
    if (!row || row.state === 'sent') return;
    await idb.put(ROW_KEY(id), {
      ...row,
      attempts: row.attempts + 1,
      last_attempt: new Date().toISOString(),
      last_error: error,
    });
  },

  async markSent(id: string): Promise<void> {
    const row = await idb.get<OutboxRow>(ROW_KEY(id));
    if (!row || row.state === 'sent') return;
    await idb.put(ROW_KEY(id), { ...row, state: 'sent', last_error: null });
  },
};
