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
 * literacy.ts is ASCII-only. Its string literals used to contain no
 * apostrophes by house rule, which let a naive [^']* capture treat every
 * single quote as a closing delimiter -- 2026-08-11's rung 7 update
 * ("Add real recovery-without-us content") added real apostrophes
 * (escaped as \' inside the single-quoted literal, e.g. "vault\'s
 * rules"), and the naive capture silently truncated at the first one,
 * comparing a torn-off fragment against assistant.js and reporting drift
 * that was never real -- this went unnoticed because the script isn't
 * wired into `npm test`. The capture below matches a full JS
 * single-quoted string literal (an escaped char OR any non-quote,
 * non-backslash char, repeated, up to the real closing quote) and then
 * unescapes \' and \\ back to their literal characters before comparing,
 * so it matches what the string's actual runtime VALUE is -- which is
 * what should appear verbatim inside assistant.js's plain backtick
 * template literal (no escaping needed there).
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

// (b) every deeper-layer string present verbatim, matched as the string's
// real runtime value (escapes resolved), not its raw source text -- see
// the header comment for why a naive [^']* capture is unsafe here. The
// interface fields are written `whyItWorks?: string;` / `theCrypto?: string;`
// (a `?` before the colon), so they never match `field:` and are skipped.
function collect(field) {
  const re = new RegExp(`${field}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(lit)) !== null) {
    out.push(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
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
