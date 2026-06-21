#!/usr/bin/env node
/*
 * Test-baseline tripwire — fleet guardrail standard.
 *
 * A loop (or a tired session) must never be able to delete or gut tests to
 * make the gates go green. This counts test FILES and test CASES (it(/test()
 * across the repo and compares them against the committed baseline in
 * .test-baseline.json. If either count drops below baseline, it FAILS — that's
 * a test being removed or hollowed out, and it's caught here and in CI before
 * it can hide a regression.
 *
 * Increases are fine; the script reminds you to re-baseline so the floor only
 * ever ratchets up.
 *
 *   node scripts/test-baseline.mjs           # check against baseline (CI + Stop hook)
 *   node scripts/test-baseline.mjs --write   # set/raise the baseline to current
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASELINE = join(ROOT, '.test-baseline.json');
const TEST_RE = /\.test\.(ts|tsx|js|jsx|mts|cts)$/;
const CASE_RE = /\b(it|test)\s*\(/g;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, acc);
    else if (TEST_RE.test(name)) acc.push(p);
  }
  return acc;
}

const files = walk(ROOT, []);
let cases = 0;
for (const f of files) {
  const m = readFileSync(f, 'utf8').match(CASE_RE);
  cases += m ? m.length : 0;
}
const current = { files: files.length, cases };

if (process.argv.includes('--write')) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`[test-baseline] baseline set: ${current.files} files, ${current.cases} cases`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('[test-baseline] FAIL: no .test-baseline.json. Create it with: node scripts/test-baseline.mjs --write');
  process.exit(1);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const dropFiles = current.files < base.files;
const dropCases = current.cases < base.cases;

if (dropFiles || dropCases) {
  console.error('[test-baseline] FAIL: tests were removed or gutted since baseline.');
  console.error(`  files: ${current.files} (baseline ${base.files})${dropFiles ? '  <-- DROP' : ''}`);
  console.error(`  cases: ${current.cases} (baseline ${base.cases})${dropCases ? '  <-- DROP' : ''}`);
  console.error('  If a test was intentionally removed, re-baseline on purpose: node scripts/test-baseline.mjs --write');
  process.exit(1);
}

if (current.files > base.files || current.cases > base.cases) {
  console.log(`[test-baseline] PASS (grew). ${current.files} files / ${current.cases} cases. Re-baseline to lock the new floor: node scripts/test-baseline.mjs --write`);
} else {
  console.log(`[test-baseline] PASS. ${current.files} files / ${current.cases} cases.`);
}
process.exit(0);
