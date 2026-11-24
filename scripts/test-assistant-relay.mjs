/**
 * test-assistant-relay.mjs -- zero-knowledge storage, Z1 slice 5
 * (docs/zero-knowledge-storage-plan.md): the REAL netlify/functions/assistant.js
 * handler is a stateless relay. It stores nothing (it has no database at
 * all), relays exactly the conversation the browser sent, refuses a seed
 * phrase or private key in ANY of the person's messages before the model
 * is called, and bounds what one turn can carry. Wired into `npm test`.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-assistant-relay.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

let who = 'u-1';
const asked = [];
let modelReply = 'Happy to help.';
mock.module(new URL('../netlify/functions/_auth.js', import.meta.url).href, { namedExports: {
  requireUser: async () => (who ? { userId: who } : { error: 'Not signed in' }),
  json: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) }),
} });
mock.module(new URL('../netlify/functions/_anthropic.js', import.meta.url).href, { namedExports: {
  askClaude: async (req) => { asked.push(req); return modelReply; },
} });
// Any attempt to reach the database fails the test.
mock.module(new URL('../netlify/functions/_supabase.js', import.meta.url).href, { namedExports: {
  getSupabaseAdmin: () => { throw new Error('the assistant must not touch the database'); },
} });

const { handler, checkConversation } = await import('../netlify/functions/assistant.js');
const call = async (body) => {
  const r = await handler({ httpMethod: 'POST', body: JSON.stringify(body) });
  return { status: r.statusCode, ...JSON.parse(r.body) };
};

// 1. Relays exactly what was sent; stores nothing; returns the proposal.
{
  const conversation = [
    { role: 'user', content: 'I want my two kids to inherit.' },
    { role: 'assistant', content: 'How old are they?' },
    { role: 'user', content: 'Twelve and fifteen.' },
  ];
  modelReply = 'A family vault fits.\n```vault-proposal\n{"template":"family-inheritance","founder_quorum":1,"founder_count":1,"heir_quorum":1,"heir_count":2,"recovery_after_months":6,"inheritance_after_months":24,"summary":"You now; your kids after two years."}\n```';
  const r = await call({ messages: conversation, mode: 'guided' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.reply, 'A family vault fits.');
  assert.equal(r.proposed_values.template, 'family-inheritance');
  assert.equal(r.thread, undefined, 'no server-side thread exists any more');
  assert.deepEqual(asked.at(-1).messages, conversation, 'exactly the conversation the browser showed and sent');
  assert.ok(!asked.at(-1).system.includes('looking at an existing vault'), 'no vault is read into the prompt');
  pass('the assistant relays exactly the conversation it was sent, stores nothing and reads no vault');
}

// 2. A secret anywhere in the person's messages stops it before the model.
{
  const before = asked.length;
  const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  let r = await call({ messages: [{ role: 'user', content: seed }, { role: 'assistant', content: 'Stop!' }, { role: 'user', content: 'ok' }] });
  assert.equal(r.status, 400); assert.match(r.error, /seed phrase or private key/);
  r = await call({ messages: [{ role: 'user', content: 'my key is xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi' }] });
  assert.equal(r.status, 400);
  assert.equal(asked.length, before, 'the model was never called');
  pass('a seed phrase or private key in any of the person\'s messages is refused before anything reaches the model');
}

// 3. What one turn can carry.
{
  assert.match(checkConversation(undefined).error, /Missing/);
  assert.match(checkConversation([{ role: 'system', content: 'x' }]).error, /role/);
  assert.match(checkConversation([{ role: 'user', content: '   ' }]).error, /content/);
  assert.match(checkConversation([{ role: 'user', content: 'x'.repeat(8001) }]).error, /too long/);
  assert.match(checkConversation([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]).error, /last message must be yours/);
  const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  long.push({ role: 'user', content: 'last' });
  const c = checkConversation(long);
  assert.ok(c.messages.length <= 20 && c.messages[0].role === 'user' && c.messages.at(-1).content === 'last');
  who = null;
  assert.equal((await call({ messages: [{ role: 'user', content: 'hi' }] })).status, 401);
  pass('only signed-in people; at most the last 20 turns, each bounded, starting and ending on the person');
}

console.log(`assistant relay: ${n} checks passed`);
