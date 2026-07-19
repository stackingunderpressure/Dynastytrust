/**
 * test-rung-digest.mjs -- binds Sage's in-context curriculum to the source of
 * truth so the hand-maintained digest cannot silently drift.
 *
 * netlify/functions/assistant.js teaches from a hand-authored digest of the
 * Rabbit Hole ladder (this repo deliberately does NOT import app code into a
 * Netlify function). A hand-sync can rot: someone edits literacy.ts and the
 * digest goes stale, so Sage teaches an old rung or -- worse -- drills into an
 * improvised machinery claim. This test refuses that drift.
 *
 * WHAT IT ASSERTS:
 *   (a) every rung 0..9 is referenced in assistant.js ("Rung N ").
 *   (b) every `whyItWorks` and every `theCrypto` string in literacy.ts appears
 *       VERBATIM in assistant.js -- so the deep, load-bearing Bitcoin claims
 *       Sage may surface are the grounded text, never a paraphrase that could
 *       drift into a subtle falsehood in a money-touching vault.
 *
 * Standalone runner (repo pattern, like test-literacy.mjs). NOT wired into
 * `npm test`. Run directly:  node scripts/test-rung-digest.mjs
 *
 * literacy.ts is ASCII-only and, by house rule, its string literals contain no
 * apostrophes, so a simple single-quote capture is safe here.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const litPath = join(here, '..', 'apps', 'web', 'src', 'lib', 'literacy.ts');
const asstPath = join(here, '..', 'netlify', 'functions', 'assistant.js');

const lit = await readFile(litPath, 'utf8');
const asst = await readFile(asstPath, 'utf8');

// (a) all ten rungs referenced in Sage's context.
for (let n = 0; n <= 9; n++) {
  assert.ok(
    asst.includes(`Rung ${n} `),
    `assistant.js is missing rung ${n} in its curriculum context`,
  );
}

// (b) every deeper-layer string present verbatim. literacy.ts string literals
// use single quotes and contain no apostrophes, so [^']* captures each whole.
// The interface fields are written `whyItWorks?: string;` / `theCrypto?: string;`
// (a `?` before the colon), so they never match `field:` and are skipped.
function collect(field) {
  const re = new RegExp(`${field}:\\s*'([^']*)'`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(lit)) !== null) out.push(m[1]);
  return out;
}

const whyItWorks = collect('whyItWorks');
const theCrypto = collect('theCrypto');

assert.equal(
  whyItWorks.length,
  10,
  `expected 10 whyItWorks strings in literacy.ts, got ${whyItWorks.length}`,
);
assert.equal(
  theCrypto.length,
  6,
  `expected 6 theCrypto strings in literacy.ts, got ${theCrypto.length}`,
);

let checked = 0;
for (const s of [...whyItWorks, ...theCrypto]) {
  assert.ok(s.length > 0, 'empty deeper-layer string in literacy.ts');
  assert.ok(
    asst.includes(s),
    `assistant.js is missing a grounded deeper-layer string verbatim (drift):\n  "${s.slice(0, 80)}..."`,
  );
  checked++;
}

console.log(
  `rung-digest sync OK -- 10 rungs referenced, ${checked} deeper-layer strings bound verbatim`,
);
