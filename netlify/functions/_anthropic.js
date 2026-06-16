/**
 * _anthropic.js -- a tiny single-call wrapper around the Claude
 * Messages API so the model id and request shape live in ONE place
 * and can be swapped without touching the assistant logic.
 *
 * Used by the education bot ("Wizard"). The caller is responsible
 * for never placing key material in `system` or `messages` -- this
 * helper just relays whatever text it is given to the model
 * provider. The assistant function is where the no-key-material
 * rule is enforced when it assembles context.
 *
 * Model is swappable via the ASSISTANT_MODEL env var; defaults to
 * the current Opus.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * Make one Claude call and return the concatenated text reply.
 *
 * @param {object}   args
 * @param {string}   args.system     -- the system prompt
 * @param {Array}    args.messages   -- [{ role: 'user'|'assistant', content: string }]
 * @param {number}   [args.maxTokens]
 * @returns {Promise<string>} concatenated text from the content array
 */
export async function askClaude({ system, messages, maxTokens = 1024 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('assistant not configured');
  }

  const model = process.env.ASSISTANT_MODEL || DEFAULT_MODEL;

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages,
      }),
    });
  } catch (err) {
    // Network-level failure -- don't leak internals to the caller.
    throw new Error('assistant request failed');
  }

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`assistant returned non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const detail =
      (payload && payload.error && payload.error.message) ||
      `HTTP ${res.status}`;
    throw new Error(`assistant error: ${detail}`);
  }

  // The Messages API returns content as an array of blocks; we only
  // use text blocks for slice 1 (no tool use).
  const parts = Array.isArray(payload.content) ? payload.content : [];
  const out = parts
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');

  if (!out) {
    throw new Error('assistant returned an empty reply');
  }
  return out;
}
