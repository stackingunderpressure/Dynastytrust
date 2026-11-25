// Which vault key made a signature, in a vault with a new address every
// time (operator, 2026-11-25, a phone screenshot: "I signed it with
// browser. It showed signed but right above it wasn't recognizing it as
// signed").
//
// In such a vault a key with an xpub signs each coin with its CHILD key for
// that coin's address, not with the key the vault's paths list (its /0/0
// child). "Who signed" compared the signature's key against the path's keys
// directly, so those signatures were never counted -- only a bare Tapit
// key, the same at every address, was. This maps a child key back to its
// vault key: the PSBT's BIP 371 derivation names the address (fingerprint,
// path), and the child is DERIVED here from the xpub in the vault's own
// stored descriptor and must equal the signing key -- the PSBT's claim is
// only a hint. Pure; shared by the proposal page and the server
// (netlify/functions/_psbt-verify.js), so both apply one rule.

import { HDKey } from "@scure/bip32";

const TEST_VERSIONS = { private: 0x04358394, public: 0x043587cf };
const KEY = /\[([0-9a-fA-F]{8})((?:\/\d+['h]?)*)\]([tx]pub[1-9A-HJ-NP-Za-km-z]{100,112})\/<0;1>\/\*/g;
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

/** The xpub keys of a multipath descriptor: fingerprint (number), account
 *  path (numbers, hardened marked), and the HD key. */
export function multipathKeys(multipath) {
  if (!multipath) return [];
  const out = [];
  for (const m of multipath.matchAll(KEY)) {
    const path = m[2].split("/").filter(Boolean).map((s) => {
      const hard = /['h]$/.test(s);
      return (parseInt(s, 10) + (hard ? 0x80000000 : 0)) >>> 0;
    });
    const xpub = m[3];
    let hd;
    try {
      hd = xpub.startsWith("tpub") ? HDKey.fromExtendedKey(xpub, TEST_VERSIONS) : HDKey.fromExtendedKey(xpub);
    } catch {
      continue;
    }
    out.push({ fingerprint: parseInt(m[1], 16) >>> 0, path, hd, key00: hex(hd.deriveChild(0).deriveChild(0).publicKey.slice(1)) });
  }
  return out;
}

/**
 * The vault key (x-only hex of its /0/0 child) behind a signature by
 * `sigPubkey` (x-only hex) on an input with these BIP 371 derivations --
 * or `sigPubkey` itself when it is not a ranged child (a bare key, or a
 * one-address vault). Never maps without deriving and matching.
 */
export function canonicalSigner(sigPubkey, derivations, keys) {
  const want = sigPubkey.toLowerCase();
  for (const d of derivations ?? []) {
    if (hex(d.pubkey).toLowerCase() !== want || d.path.length < 2) continue;
    const branch = d.path[d.path.length - 2];
    const index = d.path[d.path.length - 1];
    if ((branch !== 0 && branch !== 1) || index >= 0x80000000) continue;
    const account = d.path.slice(0, -2);
    for (const k of keys) {
      if (k.fingerprint !== (d.fingerprint >>> 0)) continue;
      if (k.path.length !== account.length || k.path.some((v, i) => v !== account[i])) continue;
      let child;
      try {
        child = hex(k.hd.deriveChild(branch).deriveChild(index).publicKey.slice(1));
      } catch {
        continue;
      }
      if (child === want) return k.key00;
    }
  }
  return want;
}
