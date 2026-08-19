/**
 * tapit-signin-request-delivery.ts -- deliver a Tapit sign-in/link
 * REQUEST directly over Nostr to a keyholder's own pubkey, instead of
 * only encoding it into a URL/QR that requires opening tapit-wallet's
 * site in a fresh browser navigation.
 *
 * Operator, 2026-08-19: "every time it sends me to the tap wallet it's a
 * completely new login screen even though the browser is logged in just
 * fine... they're not PWAs on a home screen, they're just regular in the
 * web browser... I wanted a different way for DynastyTrust to join...
 * a place to put the 64 digit public key from Tapit into there and then
 * it can do all of the Nostr messaging back and forth after that."
 *
 * Root cause: wallet-signin.ts's existing flows (startTapitFlow, and the
 * "open Tapit directly" fallback inside startTapitConnectRequest) both
 * navigate this tab to tapit-wallet's own site as a fresh, top-level page
 * load -- which re-initializes that SPA from scratch and, on an
 * already-installed wallet, re-triggers its local passphrase/unlock gate,
 * indistinguishable from onboarding to someone who did not expect it.
 * The QR path avoids that by opening on a DIFFERENT, already-unlocked
 * device, but is useless when there is no second device or camera handy.
 *
 * This module sidesteps the problem entirely by delivering the SAME
 * sign-in challenge tapit-wallet already knows how to answer
 * (approveRequest.ts's intent 'sign-in' branch, which has supported a
 * response_channel-carried Nostr reply since the QR flow shipped) as an
 * addressed Nostr event instead of a URL. Tapit's own signInChannel.ts
 * picks it up in its already-open, already-unlocked Inbox and routes to
 * the SAME in-app /sign review screen via client-side navigation (no
 * page reload, so no re-unlock) -- mirroring exactly how psbt-cosign and
 * vault-membership requests already arrive without a redirect.
 *
 * Mirrors circle-membership-delivery.ts's send pattern exactly: an
 * EPHEMERAL per-delivery keypair as the Nostr sender identity, NIP-44
 * encrypted to the recipient's real Tapit x-only pubkey, durable outbox
 * enqueue before any network attempt, best-effort immediate publish.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { buildEvent, NostrTransport } from '@dynastytrust/nostr-transport';
import { encryptTo } from '@dynastytrust/nip44';
import { DEFAULT_RELAYS } from './tapit-nostr-cosign';
import { nostrOutbox } from './nostrOutbox';
import type { TapitMode } from './wallet-signin';

// Same kind tapit-wallet's signInChannel.ts subscribes on -- 9583, the
// next free sibling after this app's own sign-in RESPONSE channel's 9582.
export const SIGN_IN_REQUEST_KIND = 9583;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateEphemeralKeypair(): { privateKey: string; publicKey: string } {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const privateKey = toHex(priv);
  const publicKey = toHex(schnorr.getPublicKey(priv));
  return { privateKey, publicKey };
}

export interface SendSignInRequestResult {
  eventId: string;
  /** True when a relay confirmed receipt before this call returned. False
   *  means the event is safely queued in the durable outbox -- see
   *  nostrOutbox.ts's header for exactly what "durable" means here. */
  delivered: boolean;
}

/**
 * Encrypt and durably queue a sign-in/link request addressed to one
 * Tapit keyholder's real pubkey. `challenge` is the exact same
 * SignInChallenge shape wallet-signin.ts already mints via
 * /api/wallet-signin-challenge; `replyPublicKey` is the caller's
 * ephemeral response_channel keypair (subscribeSignInResponses listens
 * for the grant on this same pubkey, unchanged from the QR flow).
 */
export async function sendSignInRequestOverNostr(opts: {
  mode: TapitMode;
  challenge: unknown;
  callback: string;
  replyPublicKey: string;
  recipientXOnlyPubkey: string;
  relays?: readonly string[];
}): Promise<SendSignInRequestResult> {
  const ephemeral = generateEphemeralKeypair();
  const payload = {
    v: 1 as const,
    intent: 'sign-in' as const,
    origin: 'DynastyTrust',
    callback: opts.callback,
    challenge: opts.challenge,
    response_channel: { kind: 'nostr' as const, requester_pubkey: opts.replyPublicKey },
  };
  const ciphertext = encryptTo(
    JSON.stringify(payload),
    opts.recipientXOnlyPubkey,
    ephemeral.privateKey,
  );
  const event = await buildEvent({
    pubkey: ephemeral.publicKey,
    sign: digest => toHex(schnorr.sign(digest, ephemeral.privateKey)),
    kind: SIGN_IN_REQUEST_KIND,
    content: ciphertext,
    tags: [['p', opts.recipientXOnlyPubkey]],
  });

  const relays = opts.relays ?? DEFAULT_RELAYS;
  await nostrOutbox.enqueue({
    event,
    relays,
    label: `Tapit ${opts.mode === 'link' ? 'wallet link' : 'sign-in'} request`,
  });

  const transport = new NostrTransport({ relays });
  try {
    const publish = await transport.publish(event);
    if (publish.accepted.length > 0) {
      await nostrOutbox.markSent(event.id);
      return { eventId: event.id, delivered: true };
    }
    await nostrOutbox.markAttempt(event.id, 'no relay accepted on first attempt');
    return { eventId: event.id, delivered: false };
  } catch (e) {
    await nostrOutbox.markAttempt(event.id, e instanceof Error ? e.message : 'publish failed');
    return { eventId: event.id, delivered: false };
  } finally {
    transport.close();
  }
}
