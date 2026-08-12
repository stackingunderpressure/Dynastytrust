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

const PRIVATE_PREFIXES = new Set(["xprv", "tprv", "uprv", "vprv"]);

function parseAnyXpub(xpub) {
  const head = xpub.slice(0, 4);
  // "Keys never leave the browser unencrypted" (see CLAUDE.md) applies
  // just as much to a private extended key arriving HERE as to a raw
  // seed -- xprv/tprv/uprv/vprv let an attacker derive every key in
  // the whole account, not just the one this endpoint asked for. This
  // server-side helper must refuse to touch private key material at
  // all rather than silently parsing it and computing a public child
  // from it, which would put the private key in this process's memory
  // (and any logs/traces around this call) for material that should
  // never have reached the server in the first place.
  if (PRIVATE_PREFIXES.has(head)) {
    throw new Error("Refusing to accept a private extended key (xprv/tprv/uprv/vprv) -- only public xpubs may be sent to the server");
  }
  const isTestnet = head === "tpub" || head === "upub" || head === "vpub";
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
