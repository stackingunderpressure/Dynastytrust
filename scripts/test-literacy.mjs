/**
 * test-literacy.mjs -- standalone jargon-guard for the Rabbit Hole curriculum.
 *
 * WHY A LIGHTWEIGHT PARSE INSTEAD OF AN IMPORT:
 *   apps/web/src/lib/literacy.ts is a TypeScript module consumed by the Vite
 *   app. Node cannot `import` a .ts file without a loader, and pulling in the
 *   app build graph just to test a data table would be heavy and fragile. So
 *   literacy.ts is deliberately authored as PURE DATA WITH NO IMPORTS, and
 *   this test reads the file as text and parses the two fields it needs
 *   (rung numbers and consequence strings) with focused regexes. The
 *   no-imports rule in literacy.ts is what keeps this parse simple and safe.
 *
 * WHAT IT ASSERTS:
 *   (a) rungs 0 through 9 are all present.
 *   (b) each `consequence` is a non-empty string AND contains no crypto
 *       jargon -- the surface layer must stay plain English. Jargon is
 *       allowed only in the deeper `theCrypto` layer, which this test
 *       deliberately ignores.
 *
 * This is NOT wired into `npm test` (that runs scripts/test-policy.mjs only,
 * which is not an aggregator). Run it directly:  node scripts/test-literacy.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const litPath = join(here, '..', 'apps', 'web', 'src', 'lib', 'literacy.ts');
const src = await readFile(litPath, 'utf8');

// Jargon-guard: these terms must NEVER appear in a surface `consequence`.
// Mirrors the forbidden list in the cut spec; matched case-insensitively on
// word boundaries so plain words that merely contain a fragment are safe.
const JARGON =
  /\b(shamir|descriptor|schnorr|taproot|miniscript|tapscript|cltv|csv|multisig|pubkey|xpub|sighash|secp256k1|bip\d+)\b/i;

/**
 * Pull the value of a single-quoted string-literal field that begins at
 * `field:` starting from index `from`. Handles \' escapes inside the string.
 * Returns { value, end } or null if no string literal follows.
 */
function readStringField(text, field, from) {
  const labelIdx = text.indexOf(field + ':', from);
  if (labelIdx === -1) return null;
  // Find the opening quote after the label.
  let i = labelIdx + field.length + 1;
  while (i < text.length && text[i] !== "'") i++;
  if (i >= text.length) return null;
  i++; // step past opening quote
  let value = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      value += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === "'") break;
    value += ch;
    i++;
  }
  return { value, end: i, labelIdx };
}

// Walk every `rung:` entry. The data is `Record<number, RungLesson>` with each
// object opening `N: { rung: N, ... consequence: '...' }`. We key off the
// `rung:` field (the canonical number on each lesson) and read the
// `consequence:` that follows it within the same object.
const found = new Map(); // rung number -> consequence string
const rungRe = /\brung:\s*(\d+)/g;
let m;
while ((m = rungRe.exec(src)) !== null) {
  // Skip the interface declaration's `rung: number;` (no digit there, so the
  // regex above already won't match it -- it requires a digit).
  const rung = Number(m[1]);
  const got = readStringField(src, 'consequence', m.index);
  assert.ok(got, `rung ${rung}: no consequence string found after it`);
  found.set(rung, got.value);
}

// (a) rungs 0-9 all present.
for (let r = 0; r <= 9; r++) {
  assert.ok(found.has(r), `missing rung ${r}`);
}
assert.equal(found.size, 10, `expected exactly 10 rungs, got ${found.size}`);

// (b) each consequence non-empty and jargon-free.
for (const [rung, consequence] of found) {
  assert.ok(
    typeof consequence === 'string' && consequence.trim().length > 0,
    `rung ${rung}: consequence is empty`,
  );
  const hit = consequence.match(JARGON);
  assert.ok(
    !hit,
    `rung ${rung}: consequence layer leaked jargon "${hit && hit[0]}" -- ` +
      `crypto vocabulary belongs only in theCrypto, never on the surface.`,
  );
}

console.log(`literacy tests passed (${found.size} rungs, all jargon-free)`);
