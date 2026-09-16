#!/usr/bin/env node
/*
 * Doctrine drift-check — fleet guardrail standard.
 *
 * A CLAUDE.md that promises a hook or script that isn't on disk is worse than
 * an honest blank one: it tells the next session it's protected when it isn't.
 * Three checks, in order of how badly each failure bites.
 *
 *   1. MECHANISM (fails)  — every .claude/hooks/*.sh and scripts/* the
 *      doctrine names must exist. The map must match the territory.
 *   2. SIZE (fails over the hard cap) — a doctrine file nobody finishes
 *      reading is a doctrine file nobody follows. On 2026-09-16 the fleet's
 *      largest CLAUDE.md was 3,113 lines and its "do not break the projection
 *      engine's math" rule sat at line 3,099. The thresholds match the
 *      fleet's own code rule: warn over 400 lines, fail over 800. History
 *      belongs in HISTORY.md, specs in docs/ — move it, never delete it.
 *   3. FLEET-RULES (warns only) — names the standard rules this doctrine file
 *      does not appear to carry. These are the rules that proved themselves in
 *      one repo and were made standard across the fleet on 2026-09-16, each one
 *      a real incident: sync before you build, no speculative fix, report the
 *      number you measured, trust witnessed evidence over code-reading, three
 *      patches in rewrite it clean, and the rest. Matching is loose on purpose —
 *      a repo that states a rule in its own words counts as covered — which is
 *      also why this warns rather than fails.
 *   4. WRITE-TARGET (warns only) — names paths the doctrine appears to tell a
 *      session to WRITE that do not exist. This one only warns, on purpose:
 *      a regex cannot tell an instruction ("write appcommander/comms/
 *      current.json") from a negation ("there is no .carpenter/session.json
 *      here"), and a gate that cries wolf gets disabled. A human reads the
 *      line and decides. It exists because this exact defect was found twice
 *      independently on 2026-09-16 — aria-appointments and Build-Forward-
 *      both ordered every session to write five comms files into an
 *      appcommander/comms/ directory that does not exist in either repo.
 *      An instruction that cannot be followed teaches an agent that the
 *      instructions here are optional, which is worse than none at all.
 *
 *   node scripts/doctrine-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DOCS = ['CLAUDE.md', 'GUARDRAILS.md', 'AGENTS.md'];

// Match repo-relative mechanism paths the doctrine might claim exist.
const REF_RE = /(?:\.claude\/hooks\/[\w.-]+\.sh|scripts\/[\w.-]+\.(?:mjs|cjs|js|ts|sh))/g;
// The fleet standard rules, by loose detection pattern. Reported, never fatal.
const FLEET_RULES = [
  ['grounding before editing', /[Rr]ead the (relevant )?file|Ground in the code|[Gg]rounding|read before edit/],
  ['trust witnessed operator evidence', /witnessed|trust (the )?evidence over/],
  ['sync before you build', /fetch origin main|behind .origin\/main|NEVER build on a stale|Sync before you build|git fetch origin/],
  ['no speculative fix, one change at a time', /evidence from a real run|one change at a time|from a hunch|without measuring/],
  ['report the number you measured', /number you measured|metric you did not measure|never report a metric/],
  ['never claim a surface works without walking it', /claim a UI feature works|browser-test|browser tested|without testing the path|without walking it/],
  ['three patches in, rewrite it clean', /patched three|patched 3|patch-on-patch|patches on top of patches|Three patches in/],
  ['never git checkout main in a sandbox', /PFOR-016|checkout main in|provisioning snapshot/],
  ['one-block replies, chip-form questions', /ONE continuous prose|one continuous prose/],
];
// Paths a session is commonly ORDERED to write. Reported, never fatal.
const WRITE_TARGET_RE = /(?:appcommander\/comms\/[\w.-]+|appcommander\/foreman-context\/[\w.-]+|\.carpenter\/session\.json)/g;

const WARN_LINES = 400;
const FAIL_LINES = 800;

const present = DOCS.map((d) => [d, join(ROOT, d)]).filter(([, p]) => existsSync(p));

// --- 1. mechanism -----------------------------------------------------------
const referenced = new Set();
for (const [, p] of present) {
  for (const m of readFileSync(p, 'utf8').matchAll(REF_RE)) referenced.add(m[0]);
}
const missing = [...referenced].filter((rel) => !existsSync(join(ROOT, rel))).sort();

// --- 2. size ----------------------------------------------------------------
const sizes = present.map(([doc, p]) => [doc, readFileSync(p, 'utf8').split('\n').length]);
const oversize = sizes.filter(([, n]) => n > FAIL_LINES);
const bulky = sizes.filter(([, n]) => n > WARN_LINES && n <= FAIL_LINES);

// --- 3. fleet rules (report only) -------------------------------------------
const claudeMd = present.find(([d]) => d === 'CLAUDE.md');
const missingRules = claudeMd
  ? FLEET_RULES.filter(([, rx]) => !rx.test(readFileSync(claudeMd[1], 'utf8'))).map(([name]) => name)
  : [];

// --- 4. write targets (report only) ----------------------------------------
const suspectWrites = [];
for (const [doc, p] of present) {
  readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(WRITE_TARGET_RE)) {
      if (!existsSync(join(ROOT, m[0]))) suspectWrites.push({ doc, line: i + 1, path: m[0] });
    }
  });
}

let failed = false;

if (missing.length) {
  failed = true;
  console.error('[doctrine-check] FAIL: doctrine references mechanisms that do not exist on disk:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('  Either build the mechanism or remove the claim. The map must match the territory.');
}

if (oversize.length) {
  failed = true;
  console.error(`[doctrine-check] FAIL: doctrine file over ${FAIL_LINES} lines — nobody finishes it, so nobody follows it:`);
  for (const [doc, n] of oversize) console.error(`  - ${doc}: ${n} lines`);
  console.error('  Move the history to HISTORY.md and the specs to docs/. Move it; do not delete it.');
}

if (bulky.length) {
  for (const [doc, n] of bulky) {
    console.warn(`[doctrine-check] warn: ${doc} is ${n} lines (over ${WARN_LINES}). Rules first, record elsewhere.`);
  }
}

if (missingRules.length) {
  console.warn('[doctrine-check] warn: CLAUDE.md does not appear to carry these fleet standard rules:');
  for (const r of missingRules) console.warn(`  - ${r}`);
  console.warn('  Each was a real incident somewhere in this fleet. Matching is loose, so a rule');
  console.warn('  stated here in its own words counts — if one is genuinely absent, add it.');
}

if (suspectWrites.length) {
  console.warn('[doctrine-check] warn: doctrine names these paths, which are not on disk. If a line ORDERS a');
  console.warn('  session to write one, it is an instruction that cannot be followed — fix it or drop it.');
  for (const w of suspectWrites) console.warn(`  - ${w.doc}:${w.line}  ${w.path}`);
}

if (failed) process.exit(1);

const sizeNote = sizes.map(([doc, n]) => `${doc} ${n}L`).join(', ');
console.log(`[doctrine-check] PASS. ${referenced.size} referenced mechanism(s) all present. ${sizeNote}.`);
process.exit(0);
