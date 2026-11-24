// Fresh addresses at compile (ranged addresses slice 3,
// docs/ranged-addresses-slice3-build-note.md; operator's chip 2026-11-24:
// fresh addresses by default).
//
// After a vault compiles exactly as before (its v1 address and descriptor),
// this asks the compiler wasm (/ranged-compile, protocol/src/ranged.rs
// RangedVault::from_template) for the same vault in `<0;1>/*` form. The Rust
// refuses unless every given xpub's /0/0 child is a key the vault was compiled
// with and receive/0 equals the compiled address -- so an xpub sent by the
// browser can never change WHICH vault this is, only make its addresses fresh.
// The returned fields go into the SAME update that marks the vault compiled:
// after that the database's freeze trigger never lets them change.

import { callWasm } from "./_ranged-wasm.js";

/** Rule that made these descriptors (ranged.rs RangedVault, 2026-11-19). */
export const RANGED_FORMAT = 1;

const HEX8 = /^[0-9a-fA-F]{8}$/;
const ACCOUNT_PATH = /^m(\/\d+['h]?)+$/;
const XPUB = /^[xt]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/;

/** The xpub origins the browser sent, cleaned: anything malformed is dropped
 *  (a dropped key simply stays fixed at every address). A full key path that
 *  ends in /0/0 is cut back to its account path. */
export function rangedOrigins(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const o of raw.slice(0, 64)) {
    if (!o || typeof o !== "object") continue;
    const fingerprint = typeof o.fingerprint === "string" ? o.fingerprint.toLowerCase() : "";
    let account_path = typeof o.account_path === "string" ? o.account_path.replace(/h/g, "'") : "";
    if (account_path.endsWith("/0/0")) account_path = account_path.slice(0, -4);
    const xpub = typeof o.xpub === "string" ? o.xpub.trim() : "";
    if (!HEX8.test(fingerprint) || !ACCOUNT_PATH.test(account_path) || !XPUB.test(xpub) || seen.has(xpub)) continue;
    seen.add(xpub);
    out.push({ fingerprint, account_path, xpub });
  }
  return out;
}

/**
 * What to store for this vault's addresses.
 *   { fields: {}, addresses: "fixed", reason }     -- one fixed address
 *   { fields: {...v2 columns}, addresses: "fresh" } -- fresh addresses
 *   { error, status }                               -- refuse the compile
 * `choice` is the caller's "fresh" | "fixed" (default fresh).
 */
export function rangedFields(compiled, network, choice, rawOrigins, call = callWasm) {
  if (choice === "fixed") return { fields: {}, addresses: "fixed", reason: "chosen" };
  const origins = rangedOrigins(rawOrigins);
  if (origins.length === 0) {
    return { fields: {}, addresses: "fixed", reason: "This vault's keys cannot make new addresses (no extended public keys, e.g. Tapit keys only), so it keeps one fixed address." };
  }
  let r;
  try {
    r = call("/ranged-compile", { template: compiled.descriptor, network, origins });
  } catch (e) {
    return { status: 500, error: `Fresh addresses could not be set up, so nothing was saved: ${e.message}` };
  }
  if (r.status !== 200 || !r.body?.ok) {
    return { status: 422, error: `These keys do not match the vault, so nothing was saved: ${r.body?.error || r.status}. Choose a single fixed address, or check the keys.` };
  }
  if (r.body.receive0 !== compiled.address) {
    return { status: 500, error: "The fresh-address form did not start at this vault's own address, so nothing was saved." };
  }
  return {
    addresses: "fresh",
    fields: {
      descriptor_version: 2,
      descriptor_multipath: r.body.multipath,
      descriptor_receive: r.body.receive,
      descriptor_change: r.body.change,
      ranged_format: RANGED_FORMAT,
    },
  };
}
