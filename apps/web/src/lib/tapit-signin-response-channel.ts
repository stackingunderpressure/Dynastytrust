/**
 * tapit-signin-response-channel.ts -- receive half of the QR/Nostr sign-in
 * connect flow (wallet-signin.ts's startTapitConnectRequest). A Tapit
 * wallet that approved a sign-in/link request carrying a response_channel
 * publishes the signed grant back to this request's ephemeral reply
 * pubkey (tapit-wallet's signInResponseChannel.ts); this subscribes for
 * it and hands the grant to the caller, which feeds it straight into the
 * existing completeTapitCallback -- same verify + redeem path the
 * URL-redirect callback already uses, just sourced from a Nostr event
 * instead of a query string.
 *
 * Same event kind tapit-wallet's signInResponseChannel.ts publishes to --
 * 9582, the next free sibling after the circle-phrase ack channel's 9581.
 * Same verify-then-decrypt-then-shape-check discipline as every other
 * channel in this app (see psbt-cosign-response-channel.ts).
 */

import {
  verifyEvent,
  NostrTransport,
  type Subscription,
  type TransportEvent,
  type TransportEventHandler,
} from '@dynastytrust/nostr-transport';
import { decryptFrom } from '@dynastytrust/nip44';
import { DEFAULT_RELAYS } from './tapit-nostr-cosign';

export const SIGN_IN_RESPONSE_KIND = 9582;

export interface SignInResponse {
  /** The grant object -- pass straight to completeTapitCallback({mode, grant}). */
  grant: unknown;
  eventId: string;
  receivedAt: number;
  /** The Nostr event's real author (event.pubkey). The QR/broadcast connect
   *  path (subscribeSignInResponses with no known target identity) has
   *  nothing to check this against -- whichever real Tapit wallet answers
   *  the single-use server challenge is legitimately the one connecting,
   *  same as scanning the QR in person. The paste-a-pubkey connect path
   *  (startTapitPubkeyConnectRequest) DOES have a known target -- the
   *  caller MUST check this equals that pasted pubkey before finishing the
   *  link, since the reply pubkey is published in the clear in the request
   *  event and NIP-44 decryption succeeding only proves SOME real Tapit
   *  wallet answered, never that it was the specific one pasted (Kimi K3
   *  scan #146). Without that check a forged response from any other real
   *  Tapit wallet would silently link the wrong identity. */
  signerPubkey: string;
}

export type SignInResponseHandler = (item: SignInResponse) => void;

function isSignInResponsePayload(v: unknown): v is { v: 1; grant: unknown } {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.v === 1 && 'grant' in r;
}

/**
 * Subscribe for a signed sign-in grant addressed to `replyPublicKey` --
 * the public half of the ephemeral keypair startTapitConnectRequest
 * returned for this specific request. Keep the subscription (and the
 * private key) alive only for as long as the connect modal is open;
 * close it on unmount or once a response arrives.
 */
export function subscribeSignInResponses(
  replyPrivateKey: string,
  replyPublicKey: string,
  onResponse: SignInResponseHandler,
  relays: readonly string[] = DEFAULT_RELAYS,
): { subscription: Subscription; transport: NostrTransport } {
  const transport = new NostrTransport({ relays });
  const handler: TransportEventHandler = event => {
    void handleIncoming(event, replyPrivateKey, onResponse);
  };
  const subscription = transport.subscribe({ kinds: [SIGN_IN_RESPONSE_KIND], '#p': [replyPublicKey] }, handler);
  return { subscription, transport };
}

async function handleIncoming(
  event: TransportEvent,
  replyPrivateKey: string,
  onResponse: SignInResponseHandler,
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
  if (!isSignInResponsePayload(parsed)) return;
  onResponse({ grant: parsed.grant, eventId: event.id, receivedAt: event.created_at, signerPubkey: event.pubkey });
}
