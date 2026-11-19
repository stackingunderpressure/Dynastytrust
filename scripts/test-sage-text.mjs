/**
 * test-sage-text.mjs -- Sage's replies show without markdown symbols, with
 * bold kept and only the app's own pages turned into links (live walk,
 * 2026-11-19: every answer showed literal asterisks; he never linked a page).
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-sage-text.mjs
 */
import assert from 'node:assert/strict';
import { sagePieces } from '../apps/web/src/lib/sage-text.ts';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const flat = (ps) => ps.map(p => p.text).join('');

// Bold kept as bold, its asterisks gone.
let p = sagePieces('The **recovery path** opens on a fixed date.');
assert.deepEqual(p, [
  { kind: 'text', text: 'The ' },
  { kind: 'bold', text: 'recovery path' },
  { kind: 'text', text: ' opens on a fixed date.' },
]);
pass('**bold** becomes bold, no asterisks');

// Headings, bullets, italics, code and stray asterisks never show.
p = sagePieces('## Three doors\n* one\n* two\nThis is *really* `after()` and **unclosed');
assert.equal(flat(p), 'Three doors\n- one\n- two\nThis is really after() and unclosed');
assert.ok(!flat(p).includes('*') && !flat(p).includes('#'));
pass('headings, bullets, italics, code and stray asterisks are dropped');

// Only the app's own pages become links.
p = sagePieces('Build it on /policy, then see /vaults or /keys.');
assert.deepEqual(p.filter(x => x.kind === 'link').map(x => x.path), ['/policy', '/vaults', '/keys']);
const id = '3f2a9c1e-1b2c-4d5e-8f90-abcdef012345';
p = sagePieces(`Open /vaults/${id} to see it.`);
assert.deepEqual(p.filter(x => x.kind === 'link').map(x => x.path), [`/vaults/${id}`]);
pass('the app pages and a vault page become links');

for (const s of ['see https://evil.example/policy', 'go to /policyx', 'try /vaults/../keys', 'see /admin', 'a/policy b', 'javascript:/policy']) {
  assert.equal(sagePieces(s).filter(x => x.kind === 'link').length, 0, `"${s}" must not link`);
  assert.equal(flat(sagePieces(s)), s);
}
pass('outside URLs, look-alike paths and unknown pages stay plain text');

// Text in, text out: never markup.
p = sagePieces('<img src=x onerror=alert(1)> **<b>hi</b>**');
assert.ok(p.every(x => typeof x.text === 'string'));
assert.equal(flat(p), '<img src=x onerror=alert(1)> <b>hi</b>');
pass('markup in a reply stays text');

console.log(`sage-text tests passed (${n} cases)`);
