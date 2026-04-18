/**
 * _xpub.js -- server-side xpub helpers.
 *
 * Mirrors apps/web/src/lib/xpub.ts so the same /0/0 derivation and
 * pubkey hex rendering happens in the Netlify runtime. Critical for
 * PSBT building: vault.founder_keys stores xpubs, but the Fly.io
 * compiler's leaf-script rebuilder expects 33-byte compressed pubkey
 * hex so tap_scripts match what the browser signs against.
 */

import { HDKey } from "@scure/bip32";

/**
 * Derive the compressed pubkey hex at xpub/0/0 (first receive-chain
 * child). This matches Nunchuk/Sparrow's default receive derivation
 * and is what the leaf script embeds.
 */
export function pubkeyFromXpub(xpub) {
  const account = HDKey.fromExtendedKey(xpub);
  const child = account.deriveChild(0).deriveChild(0);
  if (!child.publicKey) throw new Error("Could not derive /0/0 pubkey");
  return Buffer.from(child.publicKey).toString("hex");
}
