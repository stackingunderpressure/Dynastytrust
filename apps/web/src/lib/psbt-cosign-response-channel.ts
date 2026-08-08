/**
 * psbt-cosign-response-channel.ts -- Cut B3 slice 2, the receive half of
 * the round trip tapit-nostr-cosign.ts's send side started. A circle
 * member's Tapit wallet publishes the signed PSBT back to the ephemeral
 * reply pubkey this app minted for the original request
 * (response_channel.requester_pubkey); this subscribes for it and hands
 * the signed hex to the caller (VaultDetail.tsx's NotifyCircleViaNostr),
 * which merges it into the open signing session the same way a hardware
 * wallet import or the B2 deeplink handoff already does.
 *
 * Same event kind Tapit's psbtCosignResponseChannel.ts (tapit-wallet
 * repo) publishes to -- 9579, the next free sibling after the
 * vault-membership channel's 9578. Same verify-then-decrypt-then-shape-
 * check discipline as every other channel in this app.
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
import { fromHex, toHex } from '@dynastytrust/bip341-psbt-signer';

export const PSBT_COSIGN_RESPONSE_KIND = 9579;

export interface PsbtCosignResponse {
  psbtHex: string;
  eventId: string;
  receivedAt: number;
}

export type PsbtCosignResponseHandler = (item: PsbtCosignResponse) => void;

function isPsbtCosignResponsePayload(v: unknown): v is { v: 1; psbt_hex: string } {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.v === 1 && typeof r.psbt_hex === 'string' && r.psbt_hex.length > 0;
}

/**
 * Subscribe for a signed-PSBT response addressed to `replyPrivateKey`'s
 * public half -- the same ephemeral keypair sendPsbtCosignRequestOverNostr
 * returned for this specific request. Keep the subscription (and the
 * private key) alive only for as long as this one signing session is
 * open; close it when the session ends or the vault detail page unmounts.
 */
export function subscribePsbtCosignResponses(
  transport: Transport,
  replyPrivateKey: string,
  onResponse: PsbtCosignResponseHandler,
): Subscription {
  const replyPublicKey = toHex(schnorr.getPublicKey(fromHex(replyPrivateKey)));
  const handler: TransportEventHandler = (event) => {
    void handleIncoming(event, replyPrivateKey, onResponse);
  };
  return transport.subscribe({ kinds: [PSBT_COSIGN_RESPONSE_KIND], '#p': [replyPublicKey] }, handler);
}

async function handleIncoming(
  event: TransportEvent,
  replyPrivateKey: string,
  onResponse: PsbtCosignResponseHandler,
): Promise<void> {
  if (!(await verifyEvent(event))) return;
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
  if (!isPsbtCosignResponsePayload(parsed)) return;
  onResponse({ psbtHex: parsed.psbt_hex, eventId: event.id, receivedAt: event.created_at });
}
