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

/**
 * "Keys never leave the browser unencrypted" (see CLAUDE.md) applies
 * just as much to a private extended key arriving HERE as to a raw
 * seed -- xprv/tprv/uprv/vprv let an attacker derive every key in
 * the whole account, not just the one a given field asked for.
 * Exported standalone (2026-08-15 security audit: this check was
 * only ever called from inside parseAnyXpub, so only the two
 * endpoints that derive a pubkey from an xpub -- psbt-binary.js and
 * vaults-compile.js -- ever ran it; every other endpoint that
 * accepts a key-shaped string [vaults.js's key_label, vaults-rotate.js,
 * compile.js, compile-tranche.js, vaults-compile-bloc.js,
 * psbt-binary-bloc.js, psbt-binary-tranche.js, distribution-wallets.js]
 * stored whatever it was given with no check at all). Call this at
 * every point a caller-supplied key-shaped string is accepted, even
 * when nothing is derived from it -- the goal is refusing to let a
 * private key touch this process/the database/logs/generated PDFs
 * AT ALL, not just refusing to derive from one.
 */
export function assertNotPrivateExtendedKey(s) {
  if (typeof s !== "string") return;
  const head = s.trim().slice(0, 4);
  if (PRIVATE_PREFIXES.has(head)) {
    throw new Error("Refusing to accept a private extended key (xprv/tprv/uprv/vprv) -- only public xpubs may be sent to the server");
  }
}

function parseAnyXpub(xpub) {
  assertNotPrivateExtendedKey(xpub);
  const head = xpub.slice(0, 4);
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
