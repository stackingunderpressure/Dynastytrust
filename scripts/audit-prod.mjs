/**
 * audit-prod.mjs -- the supply-chain gate (security backlog item 8).
 *
 * Fails when any dependency that SHIPS -- to the browser bundle or to the
 * Netlify functions -- carries a known vulnerability of high or critical
 * severity. Dev tooling (vite, eslint, postcss...) is deliberately not
 * gated here: it never reaches a user, and a gate that fails on a linter's
 * glob library teaches people to ignore it. Upgrade that on its own
 * schedule with `npm audit` at the root.
 *
 * Two trees are audited, because they are installed separately in CI:
 *   - the root workspace (apps/web + packages/*) with --omit=dev
 *   - netlify/functions (its own package.json / lockfile)
 *
 * Needs the npm registry's advisory database. Offline, it does NOT pass
 * silently: it exits non-zero and says UNVERIFIED, because a gate that
 * did not run is not green.
 *
 * Run:  node scripts/audit-prod.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATED = new Set(['high', 'critical']);

function audit(label, cwd, extraArgs) {
  const r = spawnSync('npm', ['audit', '--json', ...extraArgs], { cwd, encoding: 'utf8' });
  let report;
  try {
    report = JSON.parse(r.stdout || '{}');
  } catch {
    report = null;
  }
  if (!report || !report.metadata) {
    const err = (r.stderr || r.stdout || '').trim().slice(0, 400);
    console.error(`[audit-prod] UNVERIFIED: npm audit produced no report for ${label} (registry unreachable?)\n${err}`);
    return { unverified: true, failures: [] };
  }
  const v = report.metadata.vulnerabilities;
  console.log(`[audit-prod] ${label}: ${v.critical} critical, ${v.high} high, ${v.moderate} moderate, ${v.low} low`);
  const failures = [];
  for (const [name, info] of Object.entries(report.vulnerabilities || {})) {
    if (!GATED.has(info.severity)) continue;
    const titles = (info.via || []).map(x => (typeof x === 'string' ? `via ${x}` : x.title)).join('; ');
    failures.push(`  ${name} (${info.severity}, ${info.range}): ${titles}`);
  }
  return { unverified: false, failures };
}

const results = [
  audit('shipped (root, --omit=dev)', root, ['--omit=dev']),
  audit('netlify/functions', join(root, 'netlify', 'functions'), []),
];

const unverified = results.some(r => r.unverified);
const failures = results.flatMap(r => r.failures);

if (failures.length > 0) {
  console.error('[audit-prod] FAIL: high/critical vulnerabilities in code that ships:');
  for (const f of failures) console.error(f);
  process.exit(1);
}
if (unverified) process.exit(1);
console.log('[audit-prod] PASS: no high/critical vulnerabilities in anything that ships');
