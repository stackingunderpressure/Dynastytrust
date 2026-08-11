/**
 * circle-phrase-ack-channel.ts -- real receipt confirmation for the
 * circle safety phrase pair (operator: "message couldn't drop in that
 * situation" -- a relay accepting the publish never proved the
 * recipient's wallet actually got it).
 *
 * A circle member's Tapit wallet publishes a receipt ack back to the
 * ephemeral reply pubkey circle-phrase-delivery.ts minted for the
 * original delivery (response_channel.requester_pubkey) ONLY after it
 * has successfully stored the phrase pair (storeCirclePhrasePair,
 * tapit-wallet repo) -- so a confirmed_at on our side means the pair is
 * genuinely on that device now, not merely that a relay accepted an
 * event addressed to it. This subscribes for that ack and hands the
 * decision to the caller (CirclePhraseSetup.tsx), which PATCHes the
 * persisted delivery's confirmed_at via
 * api.circlePhraseDeliveries.confirm.
 *
 * Same event kind Tapit's circlePhraseAckChannel.ts (tapit-wallet repo)
 * publishes to -- 9581, the next free sibling after the vault-membership
 * ack channel's 9580. Same no-`since`-cutoff resilience as
 * vault-membership-ack-channel.ts: a phrase pair can sit unconfirmed for
 * hours or days, so a relay re-serving its backlog on every fresh
 * subscribe is exactly how an ack that arrived while the tab was closed
 * still gets caught.
 */

import { schnorr } from '@noble/curves/secp256k1';
import {
  verifyEvent,
  type Subscription,
  type Transport,
  type TransportEvent,
  type TransportEventHandler,
} from '@dynastytrust/nostr-transport';
import { decryptFrom } from '@dynastytrust/nip44';

export const CIRCLE_PHRASE_ACK_KIND = 9581;

export interface CirclePhraseAck {
  /** Which delivery this ack confirms -- the reply pubkey it was addressed to. */
  replyPubkey: string;
  eventId: string;
  receivedAt: number;
}

export type CirclePhraseAckHandler = (ack: CirclePhraseAck) => void;

function isAckPayload(v: unknown): v is { v: 1; kind: 'circle-phrase-received' } {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.v === 1 && r.kind === 'circle-phrase-received';
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Subscribe for receipt acks addressed to any of `replyPrivateKeys`'
 * public halves -- one entry per still-unconfirmed delivery this account
 * holds. Keyed by public key so an incoming event's `p` tags can be
 * matched back to the private key that decrypts it without re-deriving
 * on every event.
 */
export function subscribeCirclePhraseAcks(
  transport: Transport,
  replyPrivateKeys: readonly string[],
  onAck: CirclePhraseAckHandler,
): Subscription {
  const byPubkey = new Map<string, string>();
  for (const priv of replyPrivateKeys) {
    byPubkey.set(toHex(schnorr.getPublicKey(priv)), priv);
  }
  const pubkeys = [...byPubkey.keys()];
  const handler: TransportEventHandler = (event) => {
    void handleIncoming(event, byPubkey, onAck);
  };
  return transport.subscribe({ kinds: [CIRCLE_PHRASE_ACK_KIND], '#p': pubkeys }, handler);
}

async function handleIncoming(
  event: TransportEvent,
  byPubkey: Map<string, string>,
  onAck: CirclePhraseAckHandler,
): Promise<void> {
  if (!(await verifyEvent(event))) return;
  const pTag = event.tags.find(t => t[0] === 'p')?.[1];
  const replyPrivateKey = pTag ? byPubkey.get(pTag.toLowerCase()) ?? byPubkey.get(pTag) : undefined;
  if (!replyPrivateKey || !pTag) return;
  let plaintext: string;
  try {
    plaintext = decryptFrom(event.content, event.pubkey, replyPrivateKey);
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return;
  }
  if (!isAckPayload(parsed)) return;
  onAck({ replyPubkey: pTag, eventId: event.id, receivedAt: event.created_at });
}
