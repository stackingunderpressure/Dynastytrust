// The compiler WebAssembly, run on the server: derives a v2 (ranged) vault's
// addresses with the SAME Rust that the browser and the vectors use
// (protocol/src/ranged.rs via service.rs "/ranged-address"; checked against
// Bitcoin Core in protocol/tests/vectors/ranged.json). No JavaScript
// derivation exists for v2 on purpose (ranged-addresses build note, section 6).
//
// The module ships with the function (netlify.toml included_files) and is
// checked against its manifest's sha256 before it is ever run. Missing or
// different -> every call refuses; an address is never derived another way.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REL = "apps/web/src/lib/wasm";

function findWasmDir() {
  const here = (() => {
    try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return null; }
  })();
  const candidates = [
    process.env.LAMBDA_TASK_ROOT && path.join(process.env.LAMBDA_TASK_ROOT, REL),
    path.join(process.cwd(), REL),
    here && path.join(here, "..", "..", REL),
  ].filter(Boolean);
  return candidates.find((d) => existsSync(path.join(d, "dynastytrust_compiler_wasm.wasm")));
}

let loaded = null;

function load() {
  if (loaded) return loaded;
  const dir = findWasmDir();
  if (!dir) throw new Error("the address derivation module is not deployed with this function");
  const bytes = readFileSync(path.join(dir, "dynastytrust_compiler_wasm.wasm"));
  const manifest = JSON.parse(readFileSync(path.join(dir, "compiler-wasm.manifest.json"), "utf8"));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== manifest.wasmSha256) throw new Error("the address derivation module does not match its manifest");
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  loaded = instance.exports;
  return loaded;
}

/** Calls one service.rs route; returns { status, body } (body parsed). */
export function callWasm(endpoint, request) {
  const x = load();
  const enc = new TextEncoder();
  const e = enc.encode(endpoint), b = enc.encode(JSON.stringify(request));
  const ep = x.dt_alloc(e.length), bp = x.dt_alloc(b.length);
  new Uint8Array(x.memory.buffer, ep, e.length).set(e);
  new Uint8Array(x.memory.buffer, bp, b.length).set(b);
  const rp = x.dt_handle(ep, e.length, bp, b.length);
  x.dt_dealloc(ep, e.length);
  x.dt_dealloc(bp, b.length);
  const len = new DataView(x.memory.buffer).getUint32(rp, true);
  const json = new TextDecoder().decode(new Uint8Array(x.memory.buffer, rp + 4, len));
  x.dt_dealloc(rp, 4 + len);
  const v = JSON.parse(json);
  return { status: v.status, body: JSON.parse(v.body) };
}

/** One address of a v2 vault, from its stored descriptors. Throws on refusal. */
export function rangedAddress(vault, branch, index) {
  const r = callWasm("/ranged-address", {
    multipath: vault.descriptor_multipath,
    receive: vault.descriptor_receive,
    change: vault.descriptor_change,
    network: vault.network,
    branch,
    index,
  });
  if (r.status !== 200 || !r.body?.ok) throw new Error(r.body?.error || `address derivation refused (${r.status})`);
  return r.body; // { address, script_pubkey, descriptor_checksum }
}
