/**
 * _compiler.js -- the ONE way a server function reaches the vault compiler.
 *
 * Until 2026-11-24 this POSTed to the Fly.io compiler service
 * (dynastytrust-compiler.fly.dev) with a timeout and a cold-start retry.
 * Operator: "Retire Fly first" (docs/retire-fly-build-note.md). Fly was a
 * thin wrapper whose every route called protocol::service; the compiler
 * WebAssembly committed in this repo runs that same service.rs, and
 * scripts/test-compiler-wasm.mjs replays every recorded Fly answer through
 * it, identical. So the call now runs in-process and answers with a real
 * Response carrying the exact status and text Fly would have sent -- each
 * caller keeps its own parsing and error wording unchanged. No network, no
 * shared secret, no cold start.
 *
 * The .wasm is read from disk and checked against its manifest's sha256
 * (_ranged-wasm.js); every function that imports this file must ship both in
 * netlify.toml included_files (scripts/test-wasm-bundling.mjs).
 */

import { callWasmText } from "./_ranged-wasm.js";

const ENDPOINTS = new Set([
  "/compile", "/compile-bloc", "/compile-tranche", "/compile-leaves",
  "/psbt-binary", "/psbt-binary-bloc", "/psbt-binary-tranche",
  "/psbt-finalize", "/psbt-merge",
  "/governance/status", "/governance/audit", "/validate-address",
]);

/**
 * Ask the compiler. `path` is the endpoint Fly served ("/compile", ...).
 * Returns a Response (status + JSON text, as Fly sent it). A compiler that
 * cannot load (missing or altered .wasm) throws, like an unreachable server
 * used to -- callers already turn that into their own 502.
 * The first argument (the old Fly URL) and the options are ignored; kept so
 * every caller changes only where it gets its answer from.
 */
export async function fetchCompiler(_unusedUrl, path, body, _unusedOptions) {
  if (!ENDPOINTS.has(path)) throw new Error(`unknown compiler endpoint ${path}`);
  const { status, text } = callWasmText(path, body);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

/** The same, without the legacy first argument. */
export function compilerPost(path, body) {
  return fetchCompiler(null, path, body);
}

/** Human-readable reason for a compiler failure. */
export function compilerFailureReason(err) {
  return err?.message || "Unknown error";
}

/** For callers written against fetch(url, init): the same answer, taking the
 *  JSON body from `init.body`. */
export function compilerFetch(path, init) {
  return fetchCompiler(null, path, JSON.parse(init.body));
}
