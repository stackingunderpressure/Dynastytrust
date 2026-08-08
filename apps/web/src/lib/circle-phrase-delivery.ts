/**
 * circle-phrase-delivery.ts -- the DynastyTrust half of the phone-callback
 * phrase pair (2026-08-08 follow-up to docs/2026-08-callback-verification-
 * and-amount-tiers.md). A Tapit Circle vault owner picks ONE shared normal
 * phrase and ONE shared duress phrase for the whole circle and sends both,
 * once, NIP-44 encrypted, to each circle member's real Tapit pubkey.
 *
 * Mirrors tapit-nostr-cosign.ts's send pattern exactly: an EPHEMERAL
 * per-delivery keypair as the Nostr sender identity (this app has no
 * persistent Tapit identity of its own, and an ephemeral sender means a
 * relay operator watching the wire learns nothing about which DynastyTrust
 * account sent it), NIP-44 encrypt, publish, close.
 *
 * The phrase pair is NEVER persisted server-side -- it exists in this
 * module's arguments and the encrypted event body only, both transient.
 * Tapit's own circlePhrase.ts stores only a salted PBKDF2 hash on receipt;
 * this side stores nothing at all once the publish resolves.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { buildEvent, NostrTransport, type PublishResult } from '@dynastytrust/nostr-transport';
import { encryptTo } from '@dynastytrust/nip44';
import { DEFAULT_RELAYS } from './tapit-nostr-cosign';

// Next free sibling after the psbt-cosign channel's 9576 -- see that
// channel's own header for why each of these gets its own kind rather than
// riding the Attestation envelope kind.
const CIRCLE_PHRASE_DELIVERY_KIND = 9577;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateEphemeralKeypair(): { privateKey: string; publicKey: string } {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const privateKey = toHex(priv);
  const publicKey = toHex(schnorr.getPublicKey(priv));
  return { privateKey, publicKey };
}

export interface SendCirclePhraseResult {
  publish: PublishResult;
  eventId: string;
}

/**
 * Encrypt and publish a phrase pair to one circle member's real Tapit
 * pubkey. Opens a short-lived transport connection, publishes, closes it --
 * a fire-and-forget send, not a subscription. Call once per circle member
 * (fan-out is the caller's job, same as sendPsbtCosignRequestOverNostr).
 */
export async function sendCirclePhrasePairOverNostr(opts: {
  vaultDescriptor: string;
  vaultName: string;
  normalPhrase: string;
  duressPhrase: string;
  recipientXOnlyPubkey: string;
  relays?: readonly string[];
}): Promise<SendCirclePhraseResult> {
  const ephemeral = generateEphemeralKeypair();
  const delivery = {
    v: 1 as const,
    vault_descriptor: opts.vaultDescriptor,
    vault_name: opts.vaultName,
    normal_phrase: opts.normalPhrase,
    duress_phrase: opts.duressPhrase,
  };
  const ciphertext = encryptTo(
    JSON.stringify(delivery),
    opts.recipientXOnlyPubkey,
    ephemeral.privateKey,
  );
  const event = await buildEvent({
    pubkey: ephemeral.publicKey,
    sign: digest => toHex(schnorr.sign(digest, ephemeral.privateKey)),
    kind: CIRCLE_PHRASE_DELIVERY_KIND,
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
