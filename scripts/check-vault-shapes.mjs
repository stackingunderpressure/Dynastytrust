/**
 * check-vault-shapes.mjs -- enforces the vault-shape doctrine
 * (docs/vault-shape-doctrine.md): a small, fixed set of vetted vault STRUCTURES
 * with parameter freedom inside each, compiled from structured parameters -- NOT
 * an open miniscript-authoring surface.
 *
 * This is the mechanism behind the doctrine. It fails the build if:
 *   1. The production (non-test) shape count leaves the curated band [5, 10] --
 *      so adding a genuinely new STRUCTURE forces a deliberate decision and a
 *      doctrine-doc update, instead of silent structure sprawl (the
 *      combinatorial wall).
 *   2. Any template declares a mode outside the known set.
 *   3. Compilation stops being parameter-driven (structured founder keys +
 *      quorum) -- i.e. someone wires up a raw-policy authoring path.
 *
 * Text-based, in the repo's node-script style (like check-policy-builder.mjs).
 * Run:  node scripts/check-vault-shapes.mjs   (wired into npm test)
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pbPath = join(here, '..', 'apps', 'web', 'src', 'pages', 'PolicyBuilder.tsx');
const src = await readFile(pbPath, 'utf8');

// The curated band. The lower bound guards against gutting the set; the upper
// bound is the anti-sprawl ceiling. Raising the ceiling is a deliberate act that
// must come with a docs/vault-shape-doctrine.md update.
const MIN_SHAPES = 5;
const MAX_SHAPES = 10;
const KNOWN_MODES = new Set(['plain', 'inheritance']);

// Each VAULT_TEMPLATES entry looks like `{ id: 'slug', title: ..., ...,
// config: { mode: 'inheritance', ... }, ..., testMode: true }`. Count the
// production shapes (those WITHOUT `testMode: true`) by pairing every `id:` with
// whether its object also carries testMode.

// Collect all top-level template ids (the ones at 4-space indent inside the
// VAULT_TEMPLATES array; rule ids inside trustDoc are more deeply indented).
const idRe = /^    id: '([a-z0-9-]+)',$/gm;
const ids = [];
let m;
while ((m = idRe.exec(src)) !== null) ids.push(m[1]);

assert.ok(ids.length >= MIN_SHAPES, `expected at least ${MIN_SHAPES} vault shapes, found ${ids.length}`);

// testMode templates carry `testMode: true`; count them and derive production.
const testCount = (src.match(/testMode: true/g) || []).length;
const productionCount = ids.length - testCount;

assert.ok(
  productionCount >= MIN_SHAPES && productionCount <= MAX_SHAPES,
  `production vault shapes = ${productionCount}, outside the curated band [${MIN_SHAPES}, ${MAX_SHAPES}]. ` +
    `Adding a new STRUCTURE past the ceiling must be a deliberate decision -- update docs/vault-shape-doctrine.md and this band.`,
);

// Every declared mode must be known (no exotic structural mode sneaking in).
const modeRe = /mode: '([a-z_]+)'/g;
const modes = new Set();
while ((m = modeRe.exec(src)) !== null) modes.add(m[1]);
for (const md of modes) {
  assert.ok(KNOWN_MODES.has(md), `unknown vault mode '${md}' -- structures must stay within {plain, inheritance}`);
}

// Compilation must be parameter-driven, not raw-policy-driven. The builder calls
// api.compile with structured founder keys + quorum; it must NOT grow a
// user-editable miniscript/policy authoring field.
assert.ok(src.includes('api.compile('), 'PolicyBuilder must compile via api.compile (parameter-driven)');
assert.ok(
  /founder_keys:/.test(src) && /founder_quorum:/.test(src),
  'PolicyBuilder must send structured founder_keys + founder_quorum (parameterized vetted shape), not a raw policy string',
);

console.log(
  `vault-shape doctrine OK -- ${productionCount} production shapes + ${testCount} test variants, ` +
    `modes {${[...modes].join(', ')}}, parameter-driven compile (band [${MIN_SHAPES}, ${MAX_SHAPES}])`,
);
