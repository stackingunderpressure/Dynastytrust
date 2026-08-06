import type {
  PublishResult,
  RelayStatus,
  RelayStatusHandler,
  Subscription,
  Transport,
  TransportEventHandler,
} from './transport.js';
import type { TransportEvent, TransportFilter } from './nostrEvent.js';

// Minimal Nostr WebSocket client behind the Transport interface. Speaks
// NIP-01 — the client sends JSON arrays, the relay sends them back:
//   ['EVENT', <event>]                    — client publishes
//   ['REQ', <sub_id>, <filter>, ...]      — client subscribes
//   ['CLOSE', <sub_id>]                   — client unsubscribes
//   ['EVENT', <sub_id>, <event>]          — relay delivers an event
//   ['EOSE', <sub_id>]                    — relay says end-of-stored
//   ['OK', <event_id>, <ok>, <reason>]    — relay ack on publish
//   ['NOTICE', <msg>]                     — relay tells us something
//
// Reliability scope for this cut: best-effort. The transport opens one
// WebSocket per relay, auto-reconnects with backoff on drop, and
// dedupes incoming events by id across relays. Persistent queueing of
// publishes for offline relays is a later concern (5c-iii).

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const PUBLISH_ACK_TIMEOUT_MS = 5_000;

interface SubRecord {
  id: string;
  filter: TransportFilter;
  onEvent: TransportEventHandler;
}

interface PendingPublish {
  eventId: string;
  dispatched: number;
  accepted: string[];
  rejected: { url: string; reason: string }[];
  pending: Set<string>;
  resolve: (result: PublishResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RelayConn {
  url: string;
  ws: WebSocket | null;
  open: boolean;
  closed: boolean;
  reconnectMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  outbox: string[];
}

export interface NostrTransportOptions {
  relays: readonly string[];
  /** Override WebSocket — tests inject a fake. */
  webSocketImpl?: typeof WebSocket;
}

export class NostrTransport implements Transport {
  private readonly relays: RelayConn[] = [];
  private readonly subs = new Map<string, SubRecord>();
  private readonly seen = new Set<string>();
  private readonly pendingPublishes = new Map<string, PendingPublish>();
  private readonly statusHandlers = new Set<RelayStatusHandler>();
  private readonly WS: typeof WebSocket;
  private nextSubId = 1;
  private closed = false;

  constructor(options: NostrTransportOptions) {
    this.WS = options.webSocketImpl ?? WebSocket;
    for (const url of options.relays) {
      const conn: RelayConn = {
        url,
        ws: null,
        open: false,
        closed: false,
        reconnectMs: INITIAL_RECONNECT_MS,
        reconnectTimer: null,
        outbox: [],
      };
      this.relays.push(conn);
      this.connect(conn);
    }
  }

  async publish(event: TransportEvent): Promise<PublishResult> {
    if (this.closed) throw new Error('transport is closed');
    const frame = JSON.stringify(['EVENT', event]);
    const dispatchedUrls: string[] = [];
    for (const conn of this.relays) {
      this.send(conn, frame);
      dispatchedUrls.push(conn.url);
    }
    return new Promise<PublishResult>((resolve) => {
      const pending: PendingPublish = {
        eventId: event.id,
        dispatched: dispatchedUrls.length,
        accepted: [],
        rejected: [],
        pending: new Set(dispatchedUrls),
        resolve,
        timer: setTimeout(() => this.settlePublish(event.id, 'timeout'), PUBLISH_ACK_TIMEOUT_MS),
      };
      this.pendingPublishes.set(event.id, pending);
      // Edge case: zero relays configured — settle immediately.
      if (dispatchedUrls.length === 0) this.settlePublish(event.id, 'all-responded');
    });
  }

  private settlePublish(eventId: string, _reason: 'all-responded' | 'timeout'): void {
    const pending = this.pendingPublishes.get(eventId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPublishes.delete(eventId);
    pending.resolve({
      eventId,
      dispatched: pending.dispatched,
      accepted: pending.accepted,
      rejected: pending.rejected,
      pending: [...pending.pending],
    });
  }

  subscribe(filter: TransportFilter, onEvent: TransportEventHandler): Subscription {
    if (this.closed) throw new Error('transport is closed');
    const id = `tap-${this.nextSubId++}`;
    const record: SubRecord = { id, filter, onEvent };
    this.subs.set(id, record);
    const frame = JSON.stringify(['REQ', id, filter]);
    for (const conn of this.relays) this.send(conn, frame);
    return {
      close: () => {
        if (!this.subs.delete(id)) return;
        const closeFrame = JSON.stringify(['CLOSE', id]);
        for (const conn of this.relays) this.send(conn, closeFrame);
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subs.clear();
    // Drain any in-flight publishes — settle each with whatever
    // acks landed so far rather than leaving promises hanging.
    for (const eventId of [...this.pendingPublishes.keys()]) {
      this.settlePublish(eventId, 'timeout');
    }
    for (const conn of this.relays) {
      conn.closed = true;
      conn.open = false;
      if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
      conn.outbox.length = 0;
      if (conn.ws) {
        try {
          conn.ws.close();
        } catch {
          // best-effort close
        }
      }
    }
    this.notifyStatus();
    this.statusHandlers.clear();
  }

  relayStatus(): readonly RelayStatus[] {
    return this.relays.map((c) => ({ url: c.url, open: c.open }));
  }

  subscribeStatus(handler: RelayStatusHandler): () => void {
    this.statusHandlers.add(handler);
    // Fire once with the current snapshot so the caller can render
    // initial state without an extra round-trip.
    try {
      handler(this.relayStatus());
    } catch {
      // best-effort — a handler that throws does not break others
    }
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private notifyStatus(): void {
    if (this.statusHandlers.size === 0) return;
    const snapshot = this.relayStatus();
    for (const handler of this.statusHandlers) {
      try {
        handler(snapshot);
      } catch {
        // ignore handler errors
      }
    }
  }

  private connect(conn: RelayConn): void {
    if (this.closed || conn.closed) return;
    let ws: WebSocket;
    try {
      ws = new this.WS(conn.url);
    } catch {
      this.scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;
    // Initial open=false on (re)connect is a no-op transition unless
    // the relay had previously been open — in either case a single
    // notifyStatus at the end of this function covers it.
    const wasOpen = conn.open;
    conn.open = false;
    if (wasOpen) this.notifyStatus();
    ws.onopen = () => {
      conn.open = true;
      conn.reconnectMs = INITIAL_RECONNECT_MS;
      this.notifyStatus();
      // Re-issue every active subscription and flush queued publishes
      // so a reconnect picks up where the prior session left off.
      for (const sub of this.subs.values()) {
        try {
          ws.send(JSON.stringify(['REQ', sub.id, sub.filter]));
        } catch {
          // socket may have torn down mid-loop; onclose will reconnect
        }
      }
      const queued = conn.outbox.splice(0);
      for (const frame of queued) {
        try {
          ws.send(frame);
        } catch {
          // socket failure mid-flush; remaining items lost this round
        }
      }
    };
    ws.onmessage = (msg: MessageEvent) => {
      if (typeof msg.data !== 'string') return;
      this.handleFrame(msg.data, conn.url);
    };
    ws.onclose = () => {
      const wasOpenAtClose = conn.open;
      conn.open = false;
      conn.ws = null;
      if (wasOpenAtClose) this.notifyStatus();
      this.scheduleReconnect(conn);
    };
    ws.onerror = () => {
      // The browser will fire onclose after onerror; let that path handle reconnect.
    };
  }

  private scheduleReconnect(conn: RelayConn): void {
    if (this.closed || conn.closed) return;
    const delay = conn.reconnectMs;
    conn.reconnectMs = Math.min(conn.reconnectMs * 2, MAX_RECONNECT_MS);
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.connect(conn);
    }, delay);
  }

  private send(conn: RelayConn, frame: string): void {
    if (conn.open && conn.ws) {
      try {
        conn.ws.send(frame);
        return;
      } catch {
        // fall through to outbox
      }
    }
    conn.outbox.push(frame);
  }

  private handleFrame(raw: string, relayUrl: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length < 2) return;
    const [type] = frame;
    if (type === 'OK') {
      this.handleOkFrame(frame, relayUrl);
      return;
    }
    if (type !== 'EVENT') return;
    const subId = frame[1];
    const event = frame[2];
    if (typeof subId !== 'string' || typeof event !== 'object' || event === null) {
      return;
    }
    const sub = this.subs.get(subId);
    if (!sub) return;
    const ev = event as TransportEvent;
    if (typeof ev.id !== 'string') return;
    if (this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    sub.onEvent(ev);
  }

  // NIP-01: ['OK', <event_id>, <ok>, <reason>] — the relay's
  // verdict on a publish. Route to the matching pending publish;
  // if all dispatched relays have responded, settle the promise
  // immediately rather than waiting for the timeout.
  private handleOkFrame(frame: unknown[], relayUrl: string): void {
    const eventId = frame[1];
    const okFlag = frame[2];
    const reason = typeof frame[3] === 'string' ? frame[3] : '';
    if (typeof eventId !== 'string' || typeof okFlag !== 'boolean') return;
    const pending = this.pendingPublishes.get(eventId);
    if (!pending) return;
    if (!pending.pending.has(relayUrl)) return;
    pending.pending.delete(relayUrl);
    if (okFlag) pending.accepted.push(relayUrl);
    else pending.rejected.push({ url: relayUrl, reason });
    if (pending.pending.size === 0) this.settlePublish(eventId, 'all-responded');
  }
}
