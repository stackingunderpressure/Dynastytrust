/**
 * test-path-words.mjs -- the browser and the server describe who must
 * sign on a path in the same words (lib/path-words.ts and
 * netlify/functions/_path-words.js). Wired into `npm test`.
 */
import assert from 'node:assert/strict';
import * as web from '../apps/web/src/lib/path-words.ts';
import * as fn from '../netlify/functions/_path-words.js';

let n = 0;
for (const [q, t, m] of [[1, 1, 0], [2, 3, 0], [1, 2, 1], [2, 2, 2], [1, 1, 1], [3, 5, 3]]) {
  for (const f of ['whoSignsWords', 'whoSignsShort']) { assert.equal(web[f](q, t, m), fn[f](q, t, m)); n++; }
  assert.equal(web.mustSignMeaning(m), fn.mustSignMeaning(m)); n++;
}
assert.equal(web.whoSignsWords(2, 3), '2 of 3 keys');
assert.equal(web.whoSignsWords(1, 1), '1 of 1 key');
assert.equal(web.whoSignsWords(1, 2, 1), '1 must-sign key plus 1 of the 2 other keys');
assert.equal(web.whoSignsWords(1, 1, 2), '2 must-sign keys plus 1 of the 1 other key');
assert.equal(web.whoSignsShort(1, 2, 1), '1 must-sign + 1 of 2');
assert.equal(web.whoSignsShort(2, 3), '2 of 3');
assert.equal(web.mustSignMeaning(0), '');
assert.match(web.mustSignMeaning(1), /^The must-sign key has to sign every spend on this path\. If it is lost, this path can never be used again/);
assert.match(web.mustSignMeaning(2), /^All 2 must-sign keys .* If any one of them is lost/);
console.log(`path-words tests passed (${n} comparisons, web/functions identical)`);
