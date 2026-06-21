#!/usr/bin/env node
/*
 * Doctrine drift-check — fleet guardrail standard.
 *
 * A CLAUDE.md that promises a hook or script that isn't on disk is worse than
 * an honest blank one: it tells the next session it's protected when it isn't.
 * This scans the doctrine docs for references to .claude/hooks/*.sh and
 * scripts/* and fails if any referenced mechanism doesn't exist. It keeps the
 * map honest about the territory.
 *
 *   node scripts/doctrine-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DOCS = ['CLAUDE.md', 'GUARDRAILS.md', 'AGENTS.md'];
// Match repo-relative mechanism paths the doctrine might claim exist.
const REF_RE = /(?:\.claude\/hooks\/[\w.-]+\.sh|scripts\/[\w.-]+\.(?:mjs|cjs|js|ts|sh))/g;

const referenced = new Set();
for (const doc of DOCS) {
  const p = join(ROOT, doc);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  for (const m of text.matchAll(REF_RE)) referenced.add(m[0]);
}

const missing = [...referenced].filter((rel) => !existsSync(join(ROOT, rel))).sort();

if (missing.length) {
  console.error('[doctrine-check] FAIL: doctrine references mechanisms that do not exist on disk:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('  Either build the mechanism or remove the claim. The map must match the territory.');
  process.exit(1);
}

console.log(`[doctrine-check] PASS. ${referenced.size} referenced mechanism(s) all present.`);
process.exit(0);
