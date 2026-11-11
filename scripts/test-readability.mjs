/**
 * test-readability.mjs -- holds the floor on how small and how faint
 * the app's text may be. Operator, on his phone, 2026-11-11: "The type
 * is pretty small in the explainers. Little hard to read fine print."
 * Measured then: 610 of 788 visible text elements across fourteen
 * screens were under 14px (226 under 12px), and the fine-print grey
 * was 2.7:1 against its background. Sizes went up two steps and the
 * grey was lightened; this keeps both from drifting back.
 * Wired into `npm test`.
 *
 * Run:  node scripts/test-readability.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src');
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const files = (d) => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(f) ? [p] : []; });

// 1. No text below 12px anywhere, and the bulk of it at 13px or more.
const MIN_PX = 12;
const sizes = []; const tooSmall = [];
for (const f of files(src)) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/fontSize: ?['"]?(\d+(?:\.\d+)?)(?:px)?['"]?(?!\s*[*+\-/])/g)) {
      const px = Number(m[1]); sizes.push(px);
      if (px < MIN_PX) tooSmall.push(`${f.slice(src.length + 1)}:${i + 1} (${px}px)`);
    }
  });
}
assert.ok(sizes.length > 500, `expected to find the app's text sizes, found ${sizes.length}`);
assert.deepEqual(tooSmall, [], `text smaller than ${MIN_PX}px:\n  ${tooSmall.join('\n  ')}`);
const under13 = sizes.filter(s => s < 13).length;
assert.ok(under13 / sizes.length < 0.08, `${under13} of ${sizes.length} text sizes are 12px; keep 12px for badges and labels only`);
pass(`no text below ${MIN_PX}px in ${sizes.length} sizes; ${under13} at 12px`);

// 2. Every text colour is readable on every background it sits on.
const theme = readFileSync(join(src, 'theme.ts'), 'utf8');
const css = readFileSync(join(src, 'styles', 'core.css'), 'utf8');
const hexOf = (name) => { const m = theme.match(new RegExp(`\\b${name}: '(#[0-9A-Fa-f]{6})'`)); assert.ok(m, `theme colour ${name}`); return m[1]; };
const lum = (h) => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const worst = {};
for (const fg of ['text', 'sub', 'muted']) {
  worst[fg] = Math.min(...['bg', 'surface', 'raised', 'input', 'inset'].map(bg => contrast(hexOf(fg), hexOf(bg))));
  assert.ok(worst[fg] >= 4.5, `colors.${fg} is only ${worst[fg].toFixed(2)}:1 on one of its backgrounds; 4.5:1 is the floor for body text`);
}
assert.ok(contrast(hexOf('sub'), hexOf('surface')) > contrast(hexOf('muted'), hexOf('surface')), 'fine print stays quieter than secondary text');
pass(`text ${worst.text.toFixed(1)}:1, secondary ${worst.sub.toFixed(1)}:1, fine print ${worst.muted.toFixed(1)}:1 at worst -- all at least 4.5:1`);

// 3. The stylesheet's copy of the colour is the same colour.
assert.ok(css.includes(`--color-muted: ${hexOf('muted')};`), 'core.css --color-muted must match theme.ts muted');
pass('the stylesheet and the theme agree on the fine-print colour');

console.log(`readability tests passed (${n} cases)`);
