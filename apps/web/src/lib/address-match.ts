/**
 * address-match.ts -- case-insensitive comparison for bech32/bech32m
 * addresses, mirroring netlify/functions/proposals.js's own
 * addressesMatch(). Two independent implementations, not a shared
 * import, since this one runs in the browser and that one runs in a
 * Netlify function with its own separate dependency tree -- same
 * reasoning as _vault-shape.js's mirrored-not-imported pattern.
 *
 * Bech32/bech32m addresses (every bc1.../tb1... address, which is every
 * Taproot destination this app compiles to) are case-insensitive by
 * spec (BIP173/BIP350). Legacy base58 (1.../3...) addresses are
 * genuinely case-sensitive -- lowercasing those would corrupt them --
 * so normalization only applies when both sides look like bech32.
 */

const BECH32_LIKE = /^(bc1|tb1|bcrt1)[a-z0-9]+$/i;

export function addressesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (BECH32_LIKE.test(a) && BECH32_LIKE.test(b)) return a.toLowerCase() === b.toLowerCase();
  return false;
}
