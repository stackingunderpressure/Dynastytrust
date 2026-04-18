/**
 * xpub.ts -- derive the compressed pubkey hex at the xpub's first
 * receive-chain child (xpub/0/0). This is the pubkey that appears
 * in the compiled miniscript leaf at address index 0, matching the
 * address our app displays + funds.
 *
 * Why /0/0 and not the xpub's own pubkey: a descriptor like
 *   [fp/48'/coin'/0'/2']xpub/0/*
 * derives the pubkey at index i as xpub/0/i. Our vault is a single
 * address, always index 0, so we compile with xpub/0/0 so the raw
 * and wildcard forms agree on the first (and only) address.
 */

import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function pubkeyFromXpub(xpub: string): string {
  const hd = HDKey.fromExtendedKey(xpub.trim());
  const child00 = hd.derive('0/0');
  if (!child00.publicKey) throw new Error('Could not derive pubkey from xpub');
  return toHex(child00.publicKey);
}

/**
 * BIP32 fingerprint of the xpub: HASH160(xpub_pubkey)[0..4].
 * This is what Nunchuk and every hardware wallet use inside
 * `[fingerprint/path]xpub/0/*` key-origin expressions. Our older
 * keys stored first-4-bytes-of-raw-pubkey instead, which didn't
 * match anything.
 */
export function fingerprintFromXpub(xpub: string): string {
  const hd = HDKey.fromExtendedKey(xpub.trim());
  if (!hd.publicKey) throw new Error('Could not read xpub pubkey');
  return toHex(ripemd160(sha256(hd.publicKey)).subarray(0, 4));
}
