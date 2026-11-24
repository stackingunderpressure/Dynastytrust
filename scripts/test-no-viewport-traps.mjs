/**
 * test-no-viewport-traps.mjs -- no pop-up window can hide its own button
 * below the phone's browser bars again.
 *
 * Operator, 2026-11-24 (the recovery-phrase window): "it gets stuck down
 * there you can't find the button to keep going. Need to rethink that bug
 * and anything similar anywhere else." Panels were capped at 92vh -- on a
 * phone, vh is measured with the bars hidden, so the last button sat under
 * them -- and two panels had no cap at all.
 *
 * Fails when, anywhere in apps/web/src:
 *  1. a height or maxHeight is set in vh (use dvh, or PANEL_FIT);
 *  2. a full-screen overlay (position fixed + inset 0) is not followed, in
 *     its own block, by a panel that spreads PANEL_FIT or caps itself in
 *     dvh and scrolls (overflowY auto).
 * Page wrappers' minHeight: '100vh' is allowed: it makes a page a little
 * taller, never hides anything.
 *
 * Run: node scripts/test-no-viewport-traps.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../apps/web/src/', import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|ts|css)$/.test(f)) files.push(p);
  }
})(root);

const bad = [];
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/\b(max)?[hH]eight\s*:\s*['"`][^'"`]*\b\d+(\.\d+)?vh\b/.test(l) && !/minHeight/.test(l)) bad.push(`${f.slice(root.length)}:${i + 1} sets a height in vh: ${l.trim()}`);
    if (/position:\s*['"]fixed['"]/.test(l)) {
      const block = lines.slice(i, i + 4).join('\n');
      if (!/inset:\s*0/.test(block)) return; // a toast or a bar, not a window
      const after = lines.slice(i, i + 45).join('\n');
      const fits = /\.\.\.PANEL_FIT/.test(after) || (/maxHeight:\s*['"][^'"]*dvh/.test(after) && /overflowY:\s*['"]auto['"]/.test(after));
      if (!fits) bad.push(`${f.slice(root.length)}:${i + 1} a full-screen window whose panel does not fit the visible screen (spread PANEL_FIT)`);
    }
  });
}
assert.deepEqual(bad, [], `\n${bad.join('\n')}\n`);
const overlays = files.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/\.\.\.PANEL_FIT/g) ?? []).length, 0);
assert.ok(overlays >= 9, `expected every window to use PANEL_FIT, found ${overlays}`);
console.log(`no-viewport-traps: ${files.length} files checked, ${overlays} windows fit the visible screen`);
