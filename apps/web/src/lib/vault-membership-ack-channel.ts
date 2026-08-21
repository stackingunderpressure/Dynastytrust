/**
 * vault-membership-ack-channel.ts -- the receive half of the "return
 * roster" the operator asked for (2026-08-11, "Circle membership" tab):
 * "we need to have a return roster of it or something that tells it
 * they've accepted... we have a verified member that's signed it."
 *
 * A circle member's Tapit wallet publishes an accept/decline
 * acknowledgment back to the ephemeral reply pubkey
 * circle-membership-delivery.ts minted for the original request
 * (response_channel.requester_pubkey); this subscribes for it and hands
 * the decision to the caller (VaultMembershipSetup.tsx), which PATCHes
 * the persisted grant's status via api.vaultMembershipGrants.updateStatus.
 *
 * Same event kind Tapit's vaultMembershipAckChannel.ts (tapit-wallet
 * repo) publishes to -- 9580, the next free sibling after the
 * psbt-cosign response channel's 9579. Unlike that short-lived response
 * channel, a membership grant can sit unanswered for hours or days, so
 * this subscribes with NO `since` cutoff on every mount (mirroring
 * vaultMembershipChannel.ts's own relay-backlog-replay resilience on
 * the Tapit side) -- a relay re-serving its whole matching backlog is
 * exactly how an ack that arrived while the tab was closed still gets
 * picked up.
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

export const VAULT_MEMBERSHIP_ACK_KIND = 9580;

export interface VaultMembershipAck {
  /** Which grant this ack answers -- the reply pubkey it was addressed to. */
  replyPubkey: string;
  decision: 'accepted' | 'declined' | 'left';
  eventId: string;
  receivedAt: number;
  /** The Nostr event's real author (event.pubkey) -- the caller MUST
   *  check this equals the specific grant's recipient_pubkey before
   *  acting on the ack. reply_pubkey is published in the clear inside
   *  the original request event, so anyone who can read that event off
   *  a relay learns it and can address a forged, validly-decryptable
   *  ack to it from a throwaway keypair (Kimi K3 scan #145 / Family C)
   *  -- NIP-44 decryption succeeding only proves SOME key produced this
   *  ciphertext for this reply pubkey, never that the sender is the
   *  real invited circle member. Binding to recipient_pubkey is the
   *  only thing that actually proves that. */
  signerPubkey: string;
}

export type VaultMembershipAckHandler = (ack: VaultMembershipAck) => void;

function isAckPayload(v: unknown): v is { v: 1; decision: 'accepted' | 'declined' | 'left' } {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.v === 1 && (r.decision === 'accepted' || r.decision === 'declined' || r.decision === 'left');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Subscribe for accept/decline acks addressed to any of `replyPrivateKeys`'
 * public halves -- one entry per still-'sent' grant this account holds
 * (across one vault or several; the caller decides scope). Keyed by
 * public key so an incoming event's `p` tags can be matched back to the
 * private key that decrypts it without re-deriving on every event.
 */
export function subscribeVaultMembershipAcks(
  transport: Transport,
  replyPrivateKeys: readonly string[],
  onAck: VaultMembershipAckHandler,
): Subscription {
  const byPubkey = new Map<string, string>();
  for (const priv of replyPrivateKeys) {
    byPubkey.set(toHex(schnorr.getPublicKey(priv)), priv);
  }
  const pubkeys = [...byPubkey.keys()];
  const handler: TransportEventHandler = (event) => {
    void handleIncoming(event, byPubkey, onAck);
  };
  return transport.subscribe({ kinds: [VAULT_MEMBERSHIP_ACK_KIND], '#p': pubkeys }, handler);
}

async function handleIncoming(
  event: TransportEvent,
  byPubkey: Map<string, string>,
  onAck: VaultMembershipAckHandler,
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
  onAck({
    replyPubkey: pTag,
    decision: parsed.decision,
    eventId: event.id,
    receivedAt: event.created_at,
    signerPubkey: event.pubkey,
  });
}
