// Transport-agnostic peer transport. The wallet talks to other
// wallets through this interface — never directly to a Nostr relay
// or any other substrate. The Nostr WebSocket implementation is one
// concrete Transport; a future libp2p, gossipsub, or other substrate
// would be another. Per D-06 the substrate is swappable and never a
// hard dependency; per D-11a Nostr is the default.
//
// One Transport instance represents a connection to a set of relays.
// publish broadcasts an event to all of them; subscribe asks all of
// them for matching events and merges the streams. Implementations
// must dedupe by event id so the same event arriving on multiple
// relays delivers once.

import type { TransportEvent, TransportFilter } from './nostrEvent.js';

export type TransportEventHandler = (event: TransportEvent) => void;

export interface Subscription {
  /** Stop receiving events for this subscription. Idempotent. */
  close(): void;
}

/**
 * Outcome of a publish call after waiting for relay acknowledgements
 * (NIP-01 OK frames). Settled when either every relay has responded
 * or the publish timeout has elapsed, whichever first.
 */
export interface PublishResult {
  /** Event id we tried to publish. */
  eventId: string;
  /** Number of relays the frame was dispatched to. */
  dispatched: number;
  /** Relay URLs that returned OK with success=true. */
  accepted: string[];
  /** Relay URLs that returned OK with success=false plus the reason string. */
  rejected: { url: string; reason: string }[];
  /** Relay URLs we never heard back from before the publish timeout. */
  pending: string[];
}

/**
 * Per-relay connection status. `open` is true while the WebSocket is
 * connected and ready to send/receive; false otherwise (connecting,
 * disconnected, or reconnecting via backoff).
 */
export interface RelayStatus {
  url: string;
  open: boolean;
}

export type RelayStatusHandler = (statuses: readonly RelayStatus[]) => void;

export interface Transport {
  /**
   * Broadcast one signed event to every relay and wait for OK acks
   * with a timeout. Resolves once every relay has responded or the
   * timeout elapses, whichever first — the result records per-relay
   * outcomes (accepted, rejected, pending). The promise does not
   * reject on relay failure; the caller inspects PublishResult and
   * decides what to surface. It DOES reject if the transport is
   * closed.
   */
  publish(event: TransportEvent): Promise<PublishResult>;

  /**
   * Subscribe to events matching the filter. The handler is called
   * for each matching event, deduped across relays. The returned
   * Subscription's close() stops the flow.
   */
  subscribe(filter: TransportFilter, onEvent: TransportEventHandler): Subscription;

  /**
   * Close every relay connection and release resources. The Transport
   * is unusable after this. Idempotent.
   */
  close(): void;

  /**
   * Snapshot of every configured relay's current open state. Cheap to
   * call — implementations return a fresh array without doing I/O. The
   * caller treats the array as immutable.
   */
  relayStatus(): readonly RelayStatus[];

  /**
   * Subscribe to relay-status changes. The handler fires every time
   * any relay transitions between open and closed, with a fresh
   * snapshot of all relays. Returns an unsubscribe function.
   * Implementations call the handler on subscribe with the current
   * snapshot so UI initializes correctly.
   */
  subscribeStatus(handler: RelayStatusHandler): () => void;
}
