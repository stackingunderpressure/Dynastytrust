/**
 * tapit-nostr-cosign.ts -- Cut B stage B3, slice 1 (the DynastyTrust half
 * of docs/integration-phase2-vault-key-bridge.md and
 * docs/integration-phase1-signin-and-bridge.md's B3). Publishes a
 * psbt-cosign request directly into a Tapit member's encrypted Nostr
 * inbox, so a circle member on their own phone gets the request without a
 * deep link being handed to them by hand (the existing lib/tapit-cosign.ts
 * bridge only works when the signer shares a browser tab with the
 * requester).
 *
 * "Prove the pipe" scope only: this SENDS a request. It does not (yet)
 * subscribe for the signed response -- Tapit's own psbtCosignChannel.ts
 * receive side is built and wired to a visible inbox banner, but
 * approveRequest.ts's psbt-cosign branch still hardcodes a
 * window.location.href redirect to the request's `callback` URL, which
 * has nothing to redirect TO over this transport. Absorbing a
 * Nostr-delivered signature back into a proposal is the next slice.
 *
 * Uses an EPHEMERAL per-request keypair as the Nostr sender identity, not
 * any persistent DynastyTrust key -- this app has no long-lived Tapit
 * identity of its own, and an ephemeral sender means a relay operator
 * watching the wire learns nothing about which DynastyTrust account or
 * vault issued the request. The recipient's decision to sign never
 * depends on trusting who published the event; that trust lives entirely
 * in the attested vault-membership trail Tapit checks against the PSBT's
 * own leaf scripts (Cut C3, not yet built).
 */

import { schnorr } from '@noble/curves/secp256k1';
import { buildEvent, NostrTransport, type PublishResult } from '@dynastytrust/nostr-transport';
import { encryptTo } from '@dynastytrust/nip44';

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
  publish: PublishResult;
  eventId: string;
}

/**
 * Encrypt and publish a psbt-cosign request to one Tapit member's real
 * public key (the same value shown on Tapit's own "Your public key"
 * Settings panel, or captured as a Tapit-sourced key's tapitXOnlyPubkey
 * in keystore.ts). Opens a short-lived transport connection, publishes,
 * and closes it -- this is a fire-and-forget notification, not a
 * long-lived subscription; nothing here waits for a response.
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
    // comes back over the same Nostr channel once that's wired up
    // (next slice). Kept as the app's own origin, not a dead placeholder,
    // since the type requires a non-empty string and this is at least a
    // truthful one.
    callback: `${window.location.origin}/vaults`,
    psbt_hex: opts.psbtHex,
    vault_context: opts.vaultContext,
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

  const transport = new NostrTransport({ relays: opts.relays ?? DEFAULT_RELAYS });
  try {
    const publish = await transport.publish(event);
    return { publish, eventId: event.id };
  } finally {
    transport.close();
  }
}
