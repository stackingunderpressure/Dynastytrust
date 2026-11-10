/**
 * audit-rust.mjs -- the supply-chain gate for the Rust compiler
 * (protocol/ + compiler/), the Rust twin of scripts/audit-prod.mjs.
 *
 * Reads Cargo.lock and asks the OSV database (which mirrors RustSec)
 * whether any locked crate version has a published advisory. No
 * cargo-audit install needed, so it runs in any sandbox with Node.
 *
 * FAILS on any advisory that is a real vulnerability. Advisories that
 * RustSec files as purely informational ("unmaintained", "notice") are
 * printed but do not fail the gate -- they are a maintenance signal,
 * not a way in. "unsound" counts as a vulnerability.
 *
 * Offline it does NOT pass silently: it says UNVERIFIED and exits
 * non-zero, because a gate that did not run is not green.
 *
 * Run:  node scripts/audit-rust.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');

const crates = [];
for (const block of lock.split('[[package]]').slice(1)) {
  const name = block.match(/^name = "(.+)"$/m)?.[1];
  const version = block.match(/^version = "(.+)"$/m)?.[1];
  const fromRegistry = /^source = "registry\+/m.test(block);
  if (name && version && fromRegistry) crates.push({ name, version });
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

let batch;
try {
  batch = await post('https://api.osv.dev/v1/querybatch', {
    queries: crates.map(c => ({ package: { name: c.name, ecosystem: 'crates.io' }, version: c.version })),
  });
} catch (e) {
  console.error(`[audit-rust] UNVERIFIED: could not reach the OSV advisory database (${e.message})`);
  process.exit(1);
}
if (!Array.isArray(batch.results) || batch.results.length !== crates.length) {
  console.error('[audit-rust] UNVERIFIED: unexpected response from the OSV advisory database');
  process.exit(1);
}

const hits = [];
batch.results.forEach((r, i) => { for (const v of r.vulns ?? []) hits.push({ ...crates[i], id: v.id }); });

const real = [], informational = [];
for (const h of hits) {
  let detail = {};
  try {
    const res = await fetch(`https://api.osv.dev/v1/vulns/${h.id}`);
    if (!res.ok) throw new Error(String(res.status));
    detail = await res.json();
  } catch (e) {
    console.error(`[audit-rust] UNVERIFIED: could not read advisory ${h.id} (${e.message})`);
    process.exit(1);
  }
  // RustSec's marker lives on each `affected` entry: 'unmaintained' | 'unsound' | 'notice' | absent
  const info = (detail.affected ?? []).map(a => a.database_specific?.informational).find(Boolean) ?? null;
  const line = `  ${h.name} ${h.version}: ${h.id}${info ? ` [${info}]` : ''} -- ${detail.summary ?? '(no summary)'}`;
  if (info === 'unmaintained' || info === 'notice') informational.push(line); else real.push(line);
}

console.log(`[audit-rust] ${crates.length} locked crates checked: ${real.length} vulnerabilities, ${informational.length} informational`);
for (const l of informational) console.log(l);
if (real.length > 0) {
  console.error('[audit-rust] FAIL: published vulnerabilities in the Rust compiler\'s dependencies:');
  for (const l of real) console.error(l);
  process.exit(1);
}
console.log('[audit-rust] PASS: no published vulnerability in any locked crate');
