/**
 * sage-text.ts -- turns one of Sage's replies into safe display pieces.
 *
 * Sage's replies arrive as plain text but the model writes markdown out of
 * habit, so the chat showed literal **asterisks** around bold words (live
 * walk, 2026-11-19). This reads only what is worth keeping -- **bold**, and
 * the app's OWN page paths as links -- and drops the rest of the markdown
 * symbols. It never produces HTML: the result is a list of pieces the chat
 * renders as React text, so nothing a model writes can become markup or a
 * link to somewhere else.
 */

export type SagePiece =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'link'; text: string; path: string };

/** The only pages Sage may link to; anything else stays plain text. */
export const SAGE_PAGES: readonly string[] = ['/policy', '/vaults', '/keys', '/recover-descriptor'];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// A page path standing on its own: not part of a URL, a word or a longer path.
const PATH_RE = new RegExp(`(?<![\\w/.:-])(\\/vaults\\/${UUID}|${SAGE_PAGES.map(p => p.replace('/', '\\/')).join('|')})(?![\\w/-])`, 'g');

/** Drop the markdown that has no meaning in a chat bubble. */
function stripMarkdown(text: string): string {
  return text
    .split('\n')
    .map(line => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')       // headings
      .replace(/^(\s*)[*+]\s+/, '$1- ')       // "* item" -> "- item"
      .replace(/^\s{0,3}>\s?/, ''))           // quotes
    .join('\n')
    .replace(/`([^`\n]+)`/g, '$1')            // inline code
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1$2') // *italic*
    .replace(/(^|\W)_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2');           // _italic_
}

function linkify(text: string, out: SagePiece[]) {
  let last = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: 'text', text: text.slice(last, i) });
    out.push({ kind: 'link', text: m[1], path: m[1] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
}

export function sagePieces(raw: string): SagePiece[] {
  const text = stripMarkdown(raw);
  const out: SagePiece[] = [];
  const parts = text.split(/\*\*([^*\n]+?)\*\*/g);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) out.push({ kind: 'bold', text: part });
    else linkify(part.replace(/\*\*/g, ''), out);
  });
  return out;
}
