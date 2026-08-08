import { NostrTransport } from '@dynastytrust/nostr-transport';
import { nostrOutbox, type OutboxRow } from './nostrOutbox';

/**
 * Background retry loop for the durable Nostr outbox. Mirrors tapit-
 * wallet's announcementOutboxWorker.ts almost exactly (same poll + backoff
 * + online-resume shape, same "no attempt cap, no expiry" philosophy --
 * "the app would need to work until it actually goes out, not give up
 * after a few tries").
 *
 * A row is retried with exponential backoff (capped at one hour, so a
 * multi-hour relay outage still recovers within an hour of the next
 * check) until at least one configured relay accepts it -- see
 * nostrOutbox.ts's header for why "one relay accepted" is the right
 * durability target here rather than an application-level read receipt.
 */

const POLL_MS = 2 * 60 * 1000;
const MAX_PARALLEL = 4;
const BACKOFF_MIN_MS = 30 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

function nextAttemptDue(row: OutboxRow): number {
  if (row.attempts === 0 || !row.last_attempt) return 0;
  const last = Date.parse(row.last_attempt);
  if (!Number.isFinite(last)) return 0;
  const delay = Math.min(BACKOFF_MIN_MS * 2 ** Math.max(0, row.attempts - 1), BACKOFF_MAX_MS);
  return last + delay;
}

async function attemptSend(row: OutboxRow): Promise<void> {
  if (nextAttemptDue(row) > Date.now()) return;
  const transport = new NostrTransport({ relays: row.relays });
  try {
    const publish = await transport.publish(row.event);
    if (publish.accepted.length > 0) {
      await nostrOutbox.markSent(row.id);
    } else {
      const reason =
        publish.rejected[0]?.reason ||
        (publish.pending.length > 0 ? 'no relay responded in time' : 'every relay rejected the event');
      await nostrOutbox.markAttempt(row.id, reason);
    }
  } catch (e) {
    await nostrOutbox.markAttempt(row.id, e instanceof Error ? e.message : 'publish failed');
  } finally {
    transport.close();
  }
}

export interface NostrOutboxWorkerHandle {
  stop(): void;
  /** Force an immediate scan; resolves when the scan completes. */
  kick(): Promise<void>;
}

export function startNostrOutboxWorker(): NostrOutboxWorkerHandle {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let scanInFlight: Promise<void> | null = null;

  async function scan(): Promise<void> {
    if (stopped) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const rows = await nostrOutbox.pending();
    for (let i = 0; i < rows.length; i += MAX_PARALLEL) {
      if (stopped) return;
      await Promise.all(rows.slice(i, i + MAX_PARALLEL).map(attemptSend));
    }
  }

  function tick(): Promise<void> {
    if (scanInFlight) return scanInFlight;
    scanInFlight = scan().finally(() => {
      scanInFlight = null;
    });
    return scanInFlight;
  }

  function onOnline() {
    void tick();
  }

  window.addEventListener('online', onOnline);
  void tick();
  timer = setInterval(() => void tick(), POLL_MS);

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      window.removeEventListener('online', onOnline);
    },
    kick: () => tick(),
  };
}
