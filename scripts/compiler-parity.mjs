/**
 * compiler-parity.mjs -- sovereign slice 1 (docs/super-sovereign-build-note.md).
 *
 * Replays a recorded set of compiler requests (one JSON line each:
 * { endpoint, body, status, response }) and requires the SAME answer, byte
 * for byte, from a target:
 *
 *   --target http   a running compiler at COMPILER_URL (the reshaped Fly
 *                   server must answer exactly as the old one did)
 *   --target wasm   the browser module, protocol-wasm (same answers, no
 *                   server at all)
 *
 * Success answers must be identical JSON (key order aside); refusals must be
 * refusals with the identical message. A recording is made by the offline
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

let wasm = null;
async function viaWasm(endpoint, body) {
  if (!wasm) {
    const mod = await import(new URL('../protocol-wasm/pkg-node/protocol_wasm.js', import.meta.url).href);
    wasm = mod;
  }
  // One entry point for every endpoint: the same request JSON in, the same
  // { status, body } out that the server would send.
  const out = JSON.parse(wasm.handle(endpoint, JSON.stringify(body)));
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
const diffs = [];
const byEndpoint = {};
for (const rec of lines) {
  const got = await call(rec.endpoint, rec.body);
  const okBefore = rec.status === 200, okNow = got.status === 200;
  const match = okBefore === okNow && (target === 'http' ? got.status === rec.status : true) && canon(got.response) === canon(rec.response);
  byEndpoint[rec.endpoint] = byEndpoint[rec.endpoint] || [0, 0];
  byEndpoint[rec.endpoint][1]++;
  if (match) { same++; byEndpoint[rec.endpoint][0]++; } else diffs.push({ endpoint: rec.endpoint, before: [rec.status, rec.response.slice(0, 200)], now: [got.status, got.response.slice(0, 200)] });
}
for (const [ep, [s, n]] of Object.entries(byEndpoint).sort()) console.log(`  ${ep.padEnd(22)} ${s}/${n} identical`);
console.log(`compiler parity (${target}): ${same}/${lines.length} identical`);
if (diffs.length) { console.log(JSON.stringify(diffs.slice(0, 5), null, 1)); process.exit(1); }
