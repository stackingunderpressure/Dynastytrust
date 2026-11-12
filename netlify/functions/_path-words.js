// Twin of apps/web/src/lib/path-words.ts for the Netlify functions (plain
// Node, no TypeScript). scripts/test-path-words.mjs runs both against the
// same cases and requires identical words.

const s = (n) => (n === 1 ? '' : 's');

/** "2 of 3 keys"  or  "1 must-sign key plus 1 of the 2 other keys". */
export function whoSignsWords(quorum, total, mustSign = 0) {
  if (mustSign <= 0) return `${quorum} of ${total} key${s(total)}`;
  return `${mustSign} must-sign key${s(mustSign)} plus ${quorum} of the ${total} other key${s(total)}`;
}

/** Short form for tight spots: "2 of 3"  or  "1 must-sign + 1 of 2". */
export function whoSignsShort(quorum, total, mustSign = 0) {
  if (mustSign <= 0) return `${quorum} of ${total}`;
  return `${mustSign} must-sign + ${quorum} of ${total}`;
}

/** What a must-sign key means for the path it is on, in one sentence.
 *  Empty when there are none. */
export function mustSignMeaning(mustSign) {
  if (mustSign <= 0) return '';
  return mustSign === 1
    ? 'The must-sign key has to sign every spend on this path. If it is lost, this path can never be used again, however many of the others are left.'
    : `All ${mustSign} must-sign keys have to sign every spend on this path. If any one of them is lost, this path can never be used again, however many of the others are left.`;
}
