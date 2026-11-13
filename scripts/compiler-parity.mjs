/**
 * compiler-parity.mjs -- sovereign slice 1 (docs/super-sovereign-build-note.md).
 *
 * Replays a recorded set of compiler requests (one JSON line each:
 * { endpoint, body, status, response }) and requires the SAME answer, byte
 * for byte, from a target:
 *
 *   --target http   a running compiler at COMPILER_URL (the reshaped Fly
 *                   server must answer exactly as the old one did)
 *   --target wasm   the browser module, compiler-wasm, through the app's
 *                   own loader (same answers, no server at all; run with
 *                   --experimental-strip-types --import ./scripts/register-ts-resolver.mjs)
 *
 * Byte for byte -- status and response text -- except the compile answers'
 * `leaf_scripts` HashMap, whose field order the server itself varies from
 * run to run: there the JSON must be identical, order aside. Refusals must
 * be refusals with the identical message. A recording is made by the offline
 * harness (RECORD_COMPILER=<file>) or, for hand-made cases, by
 * `--record <cases.json>` against a running compiler.
 *
 * Run: node scripts/compiler-parity.mjs <recording.jsonl> --target http|wasm
 *      node scripts/compiler-parity.mjs <out.jsonl> --record <cases.json>
 */
import { readFileSync, appendFileSync } from 'node:fs';

const [file, flag, arg] = process.argv.slice(2);
const COMPILER = process.env.COMPILER_URL || 'http://127.0.0.1:8899';
const SECRET = process.env.COMPILER_SECRET || 'testsecret';

async function viaHttp(endpoint, body) {
  const res = await fetch(`${COMPILER}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, response: await res.text() };
}

let loaded = false;
async function viaWasm(endpoint, body) {
  // Through the app's own loader (apps/web/src/lib/browser-compiler.ts),
  // with the committed .wasm -- exactly what a browser would run.
  const bc = await import(new URL('../apps/web/src/lib/browser-compiler.ts', import.meta.url).href);
  if (!loaded) {
    const { readFileSync: rf } = await import('node:fs');
    bc.useCompilerWasmBytes(new Uint8Array(rf(new URL('../apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm', import.meta.url))));
    loaded = true;
  }
  const out = await bc.compileOnDevice(endpoint, body);
  return { status: out.status, response: out.body };
}

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
const canon = (text) => { try { return JSON.stringify(sortKeys(JSON.parse(text))); } catch { return text; } };

if (flag === '--record') {
  const cases = JSON.parse(readFileSync(arg, 'utf8'));
  for (const c of cases) {
    const got = await viaHttp(c.endpoint, c.body);
    appendFileSync(file, JSON.stringify({ endpoint: c.endpoint, body: c.body, ...got }) + '\n');
  }
  console.log(`recorded ${cases.length} cases into ${file}`);
  process.exit(0);
}

const target = flag === '--target' ? arg : 'http';
const call = target === 'wasm' ? viaWasm : viaHttp;
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
let same = 0;
let orderOnly = 0;
const diffs = [];
const byEndpoint = {};
for (const rec of lines) {
  const got = await call(rec.endpoint, rec.body);
  const okBefore = rec.status === 200, okNow = got.status === 200;
  // Byte for byte: same status, same response text. The ONE allowed
  // exception: the compile answers' `leaf_scripts` is a Rust HashMap, whose
  // field order the server itself changes from run to run (measured
  // 2026-11-13: the same server, replayed twice, gave 54 then 51 such
  // answers in a different order). There, identical JSON is the bar --
  // every key and value the same, order aside -- and nowhere else.
  const sameMeaning = canon(got.response) === canon(rec.response);
  const orderOnlyAllowed = sameMeaning && rec.response.includes('"leaf_scripts"');
  const exact = got.response === rec.response;
  const match = okBefore === okNow && got.status === rec.status && (exact || orderOnlyAllowed);
  if (match && !exact) orderOnly++;
  byEndpoint[rec.endpoint] = byEndpoint[rec.endpoint] || [0, 0];
  byEndpoint[rec.endpoint][1]++;
  if (match) { same++; byEndpoint[rec.endpoint][0]++; } else diffs.push({ endpoint: rec.endpoint, sameMeaning, before: [rec.status, rec.response.slice(0, 200)], now: [got.status, got.response.slice(0, 200)] });
}
for (const [ep, [s, n]] of Object.entries(byEndpoint).sort()) console.log(`  ${ep.padEnd(22)} ${s}/${n} identical`);
console.log(`compiler parity (${target}): ${same}/${lines.length} identical`);
console.log(`  of which byte-identical: ${same - orderOnly}; identical JSON with the HashMap field in another order: ${orderOnly}`);
if (process.env.PARITY_DEBUG) console.log(JSON.stringify(diffs.slice(0, 3), null, 1));
if (diffs.length) process.exit(1);
