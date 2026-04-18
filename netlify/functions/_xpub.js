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

// Bitcoin extended-key version bytes. @scure/bip32 defaults to
// mainnet (xpub/xprv); testnet extended keys use different bytes
// and need to be parsed with the matching versions or
// HDKey.fromExtendedKey throws "Version mismatch".
const MAINNET = { private: 0x0488ade4, public: 0x0488b21e };
const TESTNET = { private: 0x04358394, public: 0x043587cf };

function parseAnyXpub(xpub) {
  const head = xpub.slice(0, 4);
  const isTestnet = head === "tpub" || head === "tprv" ||
                    head === "upub" || head === "uprv" ||
                    head === "vpub" || head === "vprv";
  const versions = isTestnet ? TESTNET : MAINNET;
  return HDKey.fromExtendedKey(xpub, versions);
}

/**
 * Derive the compressed pubkey hex at xpub/0/0 (first receive-chain
 * child). Matches Nunchuk/Sparrow's default receive derivation and
 * is what the compiled leaf script embeds.
 */
export function pubkeyFromXpub(xpub) {
  const account = parseAnyXpub(xpub);
  const child = account.deriveChild(0).deriveChild(0);
  if (!child.publicKey) throw new Error("Could not derive /0/0 pubkey");
  return Buffer.from(child.publicKey).toString("hex");
}
