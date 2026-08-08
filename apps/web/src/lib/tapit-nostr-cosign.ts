/**
 * tapit-nostr-cosign.ts -- Cut B stage B3 (the DynastyTrust half of
 * docs/integration-phase2-vault-key-bridge.md and
 * docs/integration-phase1-signin-and-bridge.md's B3). Publishes a
 * psbt-cosign request directly into a Tapit member's encrypted Nostr
 * inbox, so a circle member on their own phone gets the request without a
 * deep link being handed to them by hand (the existing lib/tapit-cosign.ts
 * bridge only works when the signer shares a browser tab with the
 * requester).
 *
 * Slice 2 (2026-08-08) closes the loop slice 1 left open: the request now
 * carries a `response_channel` naming this call's own ephemeral pubkey as
 * the reply address, and returns that keypair's private half to the
 * caller. Tapit's approveSignRequest (Cut B3 slice 2, tapit-wallet repo)
 * publishes the signed PSBT back to that pubkey instead of trying to
 * redirect a browser tab nobody opened. The caller is responsible for
 * keeping the returned private key alive in memory for exactly as long as
 * this one signing session is open (see psbt-cosign-response-channel.ts
 * and VaultDetail.tsx's NotifyCircleViaNostr) and subscribing with it --
 * never persisted, never reused across requests, same one-request-only
 * identity discipline the send side already used for the request itself.
 *
 * Uses an EPHEMERAL per-request keypair as the Nostr sender identity, not
 * any persistent DynastyTrust key -- this app has no long-lived Tapit
 * identity of its own, and an ephemeral sender means a relay operator
 * watching the wire learns nothing about which DynastyTrust account or
 * vault issued the request. The recipient's decision to sign never
 * depends on trusting who published the event; that trust lives entirely
 * in the attested vault-membership trail Tapit checks against the PSBT's
 * own leaf scripts (Cut C3).
 */

import { schnorr } from '@noble/curves/secp256k1';
import { buildEvent, NostrTransport } from '@dynastytrust/nostr-transport';
import { encryptTo } from '@dynastytrust/nip44';
import { nostrOutbox } from './nostrOutbox';

// Same event kind Tapit's psbtCosignChannel.ts subscribes on -- see that
// file's header comment for why this isn't TAPIT_ENVELOPE_KIND (9573):
// a psbt-cosign request isn't an Attestation.
const PSBT_COSIGN_REQUEST_KIND = 9576;

// Same default relay set Tapit Wallet ships with
// (tapit-wallet/src/features/transport/defaultRelays.ts) -- a fresh Tapit
// install listens here without any relay configuration. A circle member
// who has customized their own relay list in Settings still receives
// requests through whichever of these overlaps with their set, or
// through any relay both sides share.
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.primal.net',
  'wss://nostr.wine',
];

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh, one-request-only Schnorr keypair. Never persisted, never reused. */
function generateEphemeralKeypair(): { privateKey: string; publicKey: string } {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const privateKey = toHex(priv);
  const publicKey = toHex(schnorr.getPublicKey(priv));
  return { privateKey, publicKey };
}

export interface VaultContext {
  vault_descriptor: string;
  vault_name?: string;
}

export interface SendPsbtCosignOverNostrResult {
  eventId: string;
  /** True when a relay confirmed receipt before this call returned. False
   *  means the event is safely queued in the durable outbox and the
   *  background worker (nostrOutboxWorker.ts) will keep retrying with
   *  backoff until a relay accepts it -- NOT lost, just not confirmed yet. */
  delivered: boolean;
  /** This request's ephemeral reply keypair. The caller keeps
   *  `replyPrivateKey` in memory (never persisted) for as long as it wants
   *  to listen for this specific signer's response --
   *  subscribePsbtCosignResponses (psbt-cosign-response-channel.ts) needs
   *  it to decrypt what comes back. `replyPublicKey` is the same value
   *  embedded in the request's `response_channel.requester_pubkey`. */
  replyPrivateKey: string;
  replyPublicKey: string;
}

/**
 * Encrypt and durably queue a psbt-cosign request for a Tapit member's real
 * public key (the same value shown on Tapit's own "Your public key"
 * Settings panel, or captured as a Tapit-sourced key's tapitXOnlyPubkey in
 * keystore.ts).
 *
 * The signed event is enqueued in nostrOutbox BEFORE any network attempt --
 * durability does not depend on this call's own publish succeeding. An
 * immediate best-effort publish is still attempted for fast feedback in the
 * common case (network fine, at least one relay up); if none of the
 * configured relays accept within the attempt, the row stays 'pending' and
 * nostrOutboxWorker's background retry loop (started once at app boot)
 * keeps trying with exponential backoff until one does. Publishing the same
 * signed event twice (this call's own attempt, then the worker's) is
 * harmless -- Nostr events are content-addressed and idempotent.
 */
export async function sendPsbtCosignRequestOverNostr(opts: {
  psbtHex: string;
  vaultContext: VaultContext;
  recipientXOnlyPubkey: string;
  relays?: readonly string[];
}): Promise<SendPsbtCosignOverNostrResult> {
  const ephemeral = generateEphemeralKeypair();
  const request = {
    v: 1 as const,
    intent: 'psbt-cosign' as const,
    origin: 'DynastyTrust',
    // No page to redirect back to over this transport -- the response
    // comes back over Nostr instead, addressed to response_channel below.
    // callback is still required by the wallet's SignRequest shape; kept
    // as the app's own origin (a truthful value, not a dead placeholder)
    // in case a future intent variant ever needs it as a fallback.
    callback: `${window.location.origin}/vaults`,
    psbt_hex: opts.psbtHex,
    vault_context: opts.vaultContext,
    // Reuses this same request's ephemeral keypair as the reply address --
    // no privacy cost to that (a relay already correlates this pubkey to
    // this request as its sender) and it means the caller only has to keep
    // one throwaway private key alive to hear back, not two.
    response_channel: { kind: 'nostr' as const, requester_pubkey: ephemeral.publicKey },
  };
  const ciphertext = encryptTo(
    JSON.stringify(request),
    opts.recipientXOnlyPubkey,
    ephemeral.privateKey,
  );
  const event = await buildEvent({
    pubkey: ephemeral.publicKey,
    sign: digest => toHex(schnorr.sign(digest, ephemeral.privateKey)),
    kind: PSBT_COSIGN_REQUEST_KIND,
    content: ciphertext,
    tags: [['p', opts.recipientXOnlyPubkey]],
  });

  const relays = opts.relays ?? DEFAULT_RELAYS;
  await nostrOutbox.enqueue({
    event,
    relays,
    label: `Spend request${opts.vaultContext.vault_name ? ` -- ${opts.vaultContext.vault_name}` : ''}`,
  });

  const transport = new NostrTransport({ relays });
  try {
    const publish = await transport.publish(event);
    if (publish.accepted.length > 0) {
      await nostrOutbox.markSent(event.id);
      return {
        eventId: event.id,
        delivered: true,
        replyPrivateKey: ephemeral.privateKey,
        replyPublicKey: ephemeral.publicKey,
      };
    }
    await nostrOutbox.markAttempt(event.id, 'no relay accepted on first attempt');
    return {
      eventId: event.id,
      delivered: false,
      replyPrivateKey: ephemeral.privateKey,
      replyPublicKey: ephemeral.publicKey,
    };
  } catch (e) {
    await nostrOutbox.markAttempt(event.id, e instanceof Error ? e.message : 'publish failed');
    return {
      eventId: event.id,
      delivered: false,
      replyPrivateKey: ephemeral.privateKey,
      replyPublicKey: ephemeral.publicKey,
    };
  } finally {
    transport.close();
  }
}
