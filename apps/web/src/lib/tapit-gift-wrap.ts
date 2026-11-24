/**
 * tapit-gift-wrap.ts -- open a Tapit answer that arrives gift-wrapped
 * (tapit-wallet docs/NOSTR_METADATA_PLAN.md, Phase 1, 2026-11-23).
 *
 * Tapit's answers to DynastyTrust (spend 9579, invite ack 9580, phrase ack
 * 9581, sign-in 9582) used to be signed by the wallet's real key in the
 * clear, so a relay could see which family member answered which request
 * and when. Tapit now sends the SAME signed answer event inside the NIP-17
 * layering chat already uses:
 *
 *   wrap  (kind 1059)  signed by a throwaway key, p-tag = our reply key,
 *                      content = NIP-44(throwaway -> reply key) of the seal
 *   seal  (kind 13)    signed by the wallet, content = NIP-44(wallet ->
 *                      reply key) of the answer event
 *   inner (9579..9582) the exact event Tapit sent before, still signed by
 *                      the wallet and still encrypted to the reply key
 *
 * This returns the verified inner event so every channel keeps its existing,
 * unchanged checks (verify, decrypt, shape, and the caller's signerPubkey
 * comparison). A plain, unwrapped answer is passed through untouched.
 *
 * Every failure returns null: bad wrap signature, wrong reply key, broken
 * seal, seal not signed, inner not signed, inner signed by someone other
 * than the seal's signer (someone re-sealing a stolen answer), wrong kind,
 * or an inner p-tag that does not name the same reply key.
 */
import { verifyEvent, type TransportEvent } from '@dynastytrust/nostr-transport';
import { decryptFrom } from '@dynastytrust/nip44';

export const GIFT_WRAP_KIND = 1059;
export const SEAL_KIND = 13;

function asEvent(v: unknown): TransportEvent | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (
    typeof e.id !== 'string' || typeof e.pubkey !== 'string' || typeof e.sig !== 'string' ||
    typeof e.kind !== 'number' || typeof e.created_at !== 'number' || typeof e.content !== 'string' ||
    !Array.isArray(e.tags)
  ) return null;
  return e as unknown as TransportEvent;
}

function parseEvent(json: string): TransportEvent | null {
  try {
    return asEvent(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Return the answer event to hand to a channel's existing handler, or null
 * to drop it. `privateKeyFor(pTag)` returns the reply private key for that
 * reply public key, or undefined if it is not one of ours.
 */
export async function openTapitAnswer(
  event: TransportEvent,
  expectedKind: number,
  privateKeyFor: (replyPubkey: string) => string | undefined,
): Promise<TransportEvent | null> {
  if (event.kind === expectedKind) return event; // plain answer, unchanged path
  if (event.kind !== GIFT_WRAP_KIND) return null;
  if (!(await verifyEvent(event))) return null;
  const pTag = event.tags.find(t => t[0] === 'p')?.[1];
  const priv = pTag ? privateKeyFor(pTag.toLowerCase()) ?? privateKeyFor(pTag) : undefined;
  if (!pTag || !priv) return null;
  let sealJson: string;
  try {
    sealJson = decryptFrom(event.content, event.pubkey, priv);
  } catch {
    return null;
  }
  const seal = parseEvent(sealJson);
  if (!seal || seal.kind !== SEAL_KIND || !(await verifyEvent(seal))) return null;
  let innerJson: string;
  try {
    innerJson = decryptFrom(seal.content, seal.pubkey, priv);
  } catch {
    return null;
  }
  const inner = parseEvent(innerJson);
  if (!inner || inner.kind !== expectedKind || !(await verifyEvent(inner))) return null;
  if (inner.pubkey !== seal.pubkey) return null;
  const innerP = inner.tags.find(t => t[0] === 'p')?.[1];
  if (!innerP || innerP.toLowerCase() !== pTag.toLowerCase()) return null;
  return inner;
}
