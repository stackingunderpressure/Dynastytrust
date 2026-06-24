#!/usr/bin/env node
// tapit-attest integrity guard.
//
// tapit-attest is the ONE signed-attestation envelope standard. It is
// vendored byte-identically into more than one repo (canonical source:
// the tapit-wallet repo). Two copies that silently drift produce
// signatures that cannot verify across apps -- the exact failure mode
// documented in STANDARDIZATION.md. This guard hashes every file under
// src/ and test/ and compares the result against INTEGRITY.sha256.
//
//   node scripts/check-integrity.mjs           verify (exit 1 on drift)
//   node scripts/check-integrity.mjs --write    regenerate the manifest
//
// Regenerate ONLY as part of a deliberate change that is synced to every
// repo that vendors tapit-attest. Pure node, zero dependencies, so it can
// run in CI before `npm install`.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // tapit-attest/
const MANIFEST = join(ROOT, 'INTEGRITY.sha256');
const HASHED_DIRS = ['src', 'test'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function compute() {
  const lines = [];
  for (const d of HASHED_DIRS) {
    let files;
    try {
      files = walk(join(ROOT, d));
    } catch {
      continue; // a vendoring repo may omit test/, that is fine
    }
    for (const f of files) {
      const rel = relative(ROOT, f).split('\\').join('/');
      const hash = createHash('sha256').update(readFileSync(f)).digest('hex');
      lines.push(`${hash}  ${rel}`);
    }
  }
  // Stable order by path so the manifest is deterministic across machines.
  lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  return lines.join('\n') + '\n';
}

const current = compute();

if (process.argv.includes('--write')) {
  writeFileSync(MANIFEST, current);
  console.log(`[tapit-attest] wrote INTEGRITY.sha256 (${current.trim().split('\n').length} files).`);
  process.exit(0);
}

let expected;
try {
  expected = readFileSync(MANIFEST, 'utf8');
} catch {
  console.error('[tapit-attest] INTEGRITY.sha256 is missing. Generate it with:');
  console.error('   node scripts/check-integrity.mjs --write');
  process.exit(1);
}

if (current === expected) {
  console.log(`[tapit-attest] integrity OK -- ${current.trim().split('\n').length} files match INTEGRITY.sha256.`);
  process.exit(0);
}

// Drift: report exactly what differs so the reviewer sees the breach.
const toMap = (s) =>
  new Map(
    s
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const sp = l.indexOf('  ');
        return [l.slice(sp + 2), l.slice(0, sp)];
      }),
  );
const cur = toMap(current);
const exp = toMap(expected);
const problems = [];
for (const [path, h] of cur) {
  if (!exp.has(path)) problems.push(`+ unexpected file: ${path}`);
  else if (exp.get(path) !== h) problems.push(`~ content changed: ${path}`);
}
for (const path of exp.keys()) if (!cur.has(path)) problems.push(`- missing file:    ${path}`);

console.error('[tapit-attest] INTEGRITY DRIFT -- this copy no longer matches the canonical');
console.error('tapit-attest envelope standard. A drifted copy signs attestations that other');
console.error('apps cannot verify. See tapit-attest/STANDARDIZATION.md.');
console.error('');
for (const p of problems.sort()) console.error('   ' + p);
console.error('');
console.error('If this change is intentional AND has been synced to every repo that vendors');
console.error('tapit-attest (canonical source: tapit-wallet), regenerate the manifest with:');
console.error('   node scripts/check-integrity.mjs --write');
process.exit(1);
