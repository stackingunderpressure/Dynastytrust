/**
 * test-vault-key.mjs -- zero-knowledge storage, Z1 slice 1
 * (docs/zero-knowledge-storage-plan.md): the vault key, sealed fields, key
 * sharing between members' devices, the reply-key seal (Z0), and the REAL
 * netlify/functions/vault-keys.js handler against an in-memory database.
 * Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/register-ts-resolver.mjs scripts/test-vault-key.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// Each "device" is its own localStorage (the messaging key lives there).
const devices = new Map();
let current = null;
const useDevice = (name) => { if (!devices.has(name)) devices.set(name, new Map()); current = devices.get(name); };
globalThis.localStorage = {
  getItem: (k) => (current.has(k) ? current.get(k) : null),
  setItem: (k, v) => current.set(k, String(v)),
  removeItem: (k) => current.delete(k),
};

const vk = await import('../apps/web/src/lib/vault-key.ts');
const msg = await import('../apps/web/src/lib/messaging.ts');
const rk = await import('../apps/web/src/lib/reply-key-seal.ts');

const V = 'vault-1';

// 1. Sealing: round trip, bound to vault + field + version, tamper-evident.
{
  const key = vk.newVaultKey();
  const keys = new Map([[1, key]]);
  const sealed = vk.sealField(key, 1, V, 'comment:p1', '{"body":"Pay the roof","vote":"approve"}');
  assert.ok(sealed.startsWith('zk1:1:'));
  assert.ok(!sealed.includes('roof') && !sealed.includes('approve'));
  assert.equal(vk.openField(keys, V, 'comment:p1', sealed), '{"body":"Pay the roof","vote":"approve"}');
  assert.equal(vk.openField(keys, 'vault-2', 'comment:p1', sealed), null, 'another vault');
  assert.equal(vk.openField(keys, V, 'comment:p2', sealed), null, 'another proposal');
  assert.equal(vk.openField(new Map([[2, key]]), V, 'comment:p1', sealed), null, 'unknown version');
  const t = sealed.slice(0, -6) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-5);
  assert.equal(vk.openField(keys, V, 'comment:p1', t), null, 'tampered');
  pass('a sealed field opens only for its vault, field and version, and shows no plain text');
}

// 2. Key sharing between devices, with the owner's check value.
useDevice('dad'); const dadPub = msg.getMessagingPubkey();
useDevice('anna'); const annaPub = msg.getMessagingPubkey();
useDevice('mallory'); const malPub = msg.getMessagingPubkey();
{
  useDevice('dad');
  const key = vk.newVaultKey();
  const check = vk.vaultKeyCheck(key, V, 1);
  const wraps = vk.wrapVaultKey(key, V, 1, [{ user_id: 'u-dad', pubkey: dadPub }, { user_id: 'u-anna', pubkey: annaPub }]);
  assert.equal(wraps.length, 2);
  useDevice('anna');
  const annaRow = wraps.find(w => w.recipient_user_id === 'u-anna');
  const got = vk.unwrapVaultKeys([{ version: 1, wrap: annaRow.wrap }], V, 'u-anna', { 1: check });
  assert.deepEqual(got.get(1), key);
  // A member slipping Anna a different key at the same version is rejected by the check.
  useDevice('mallory');
  const fake = vk.wrapVaultKey(vk.newVaultKey(), V, 1, [{ user_id: 'u-anna', pubkey: annaPub }]);
  useDevice('anna');
  assert.equal(vk.unwrapVaultKeys([{ version: 1, wrap: fake[0].wrap }], V, 'u-anna', { 1: check }).size, 0);
  // Mallory can't open Anna's wrap.
  useDevice('mallory');
  assert.equal(vk.unwrapVaultKeys([{ version: 1, wrap: annaRow.wrap }], V, 'u-mallory', { 1: check }).size, 0);
  pass("members get the owner's key; a substituted key fails the check; others can't open a member's wrap");
}

// 3. What happens on open.
{
  const ok = () => true;
  const base = { owner_user_id: 'u-dad', members: [{ user_id: 'u-dad', messaging_pubkey: dadPub }, { user_id: 'u-anna', messaging_pubkey: annaPub }] };
  let p = vk.planVaultKeySync({ ...base, version: 0, current_holders: [] }, 'u-dad', false, ok);
  assert.equal(p.kind, 'create'); assert.equal(p.version, 1); assert.equal(p.recipients.length, 2);
  assert.equal(vk.planVaultKeySync({ ...base, version: 0, current_holders: [] }, 'u-anna', false, ok).kind, 'wait');
  const holders = [{ user_id: 'u-dad', pubkey: dadPub }];
  p = vk.planVaultKeySync({ ...base, version: 1, current_holders: holders }, 'u-dad', true, ok);
  assert.equal(p.kind, 'share'); assert.deepEqual(p.recipients.map(r => r.user_id), ['u-anna']);
  assert.equal(vk.planVaultKeySync({ ...base, version: 1, current_holders: holders }, 'u-anna', false, ok).kind, 'wait');
  // Anna on a new phone (new messaging key): she is shared the key again.
  const both = [...holders, { user_id: 'u-anna', pubkey: annaPub }];
  const newPhone = { ...base, members: [base.members[0], { user_id: 'u-anna', messaging_pubkey: malPub }] };
  p = vk.planVaultKeySync({ ...newPhone, version: 1, current_holders: both }, 'u-dad', true, ok);
  assert.equal(p.kind, 'share'); assert.equal(p.recipients[0].pubkey, malPub);
  // ...unless her key changed since it was pinned: then she is NOT handed the key.
  p = vk.planVaultKeySync({ ...newPhone, version: 1, current_holders: both }, 'u-dad', true, (u) => u !== 'u-anna');
  assert.equal(p.kind, 'none');
  // Anna removed: the owner replaces the key for the remaining members.
  p = vk.planVaultKeySync({ owner_user_id: 'u-dad', members: [base.members[0]], version: 1, current_holders: both }, 'u-dad', true, ok);
  assert.equal(p.kind, 'rotate'); assert.equal(p.version, 2); assert.deepEqual(p.removed, ['u-anna']);
  assert.deepEqual(p.recipients.map(r => r.user_id), ['u-dad']);
  pass('owner creates; members wait then get it; new-device re-share; changed keys skipped; removal replaces the key');
}

// 4. Reply key (Z0): sealed to this browser's own messaging key; legacy rows still open.
{
  useDevice('dad');
  const priv = 'ab'.repeat(32);
  const sealed = rk.sealReplyKey(priv);
  assert.ok(!JSON.stringify(sealed).includes(priv));
  assert.equal(rk.openReplyKey({ reply_privkey: null, reply_privkey_sealed: sealed }), priv);
  assert.equal(rk.openReplyKey({ reply_privkey: priv }), priv);
  useDevice('mallory');
  assert.equal(rk.openReplyKey({ reply_privkey: null, reply_privkey_sealed: sealed }), null);
  pass('the reply key is stored sealed to its owner, never readable; old rows still work');
}

// 5. The real vault-keys handler.
const tables = { vaults: [], vault_members: [], vault_keys: [], proposals: [], proposal_comments: [] };
const events = [];
let seq = 0;
function from(table) {
  const rows = tables[table];
  const filters = []; let op = 'select', payload = null, opts = {};
  const match = (r) => filters.every(f => f(r));
  const run = () => {
    if (op === 'update') { const hit = rows.filter(match); hit.forEach(r => Object.assign(r, payload)); return hit; }
    if (op === 'upsert') {
      const keys = opts.onConflict.split(',');
      const out = [];
      for (const row of payload) {
        if (rows.some(r => keys.every(k => r[k] === row[k]))) continue;
        const nr = { id: `${table}-${++seq}`, ...row }; rows.push(nr); out.push(nr);
      }
      return out;
    }
    return rows.filter(match);
  };
  const q = {
    select: () => q,
    update: (o) => { op = 'update'; payload = o; return q; },
    insert: (row) => { op = 'insert'; payload = row; return q; },
    order: () => q,
    single: async () => { if (op === 'insert') { const nr = { id: `${table}-${++seq}`, created_at: 'now', ...payload }; rows.push(nr); return { data: nr, error: null }; } const d = run()[0]; return { data: d ?? null, error: d ? null : { message: 'no rows' } }; },
    upsert: (p, o) => { op = 'upsert'; payload = p; opts = o; return q; },
    eq: (k, v) => { filters.push(r => r[k] === v); return q; },
    in: (k, vs) => { filters.push(r => vs.includes(r[k])); return q; },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (res) => res({ data: run(), error: null }),
  };
  return q;
}
let who = null;
mock.module(new URL('../netlify/functions/_auth.js', import.meta.url).href, { namedExports: {
  requireUser: async () => (who ? { userId: who } : { error: 'Not signed in' }),
  json: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) }),
} });
mock.module(new URL('../netlify/functions/_supabase.js', import.meta.url).href, { namedExports: { getSupabaseAdmin: () => ({ from }) } });
mock.module(new URL('../netlify/functions/_ledger.js', import.meta.url).href, { namedExports: { recordEvent: async (_s, e) => { events.push(e); return { error: null }; } } });
const { handler } = await import('../netlify/functions/vault-keys.js');
const comments = (await import('../netlify/functions/proposal-comments.js')).handler;
const call = async (userId, method, { body, query } = {}) => {
  who = userId;
  const r = await handler({ httpMethod: method, body: body ? JSON.stringify(body) : undefined, queryStringParameters: query ?? {} });
  return { status: r.statusCode, ...JSON.parse(r.body) };
};
tables.vaults.push({ id: V, user_id: 'u-dad', vault_key_version: 0, vault_key_checks: {} });
tables.vault_members.push(
  { vault_id: V, user_id: 'u-dad', status: 'active', messaging_pubkey: dadPub },
  { vault_id: V, user_id: 'u-anna', status: 'active', messaging_pubkey: annaPub },
  { vault_id: V, user_id: 'u-gone', status: 'removed', messaging_pubkey: malPub },
);
{
  useDevice('dad');
  const key = vk.newVaultKey();
  const check = vk.vaultKeyCheck(key, V, 1);
  const wraps = vk.wrapVaultKey(key, V, 1, [{ user_id: 'u-dad', pubkey: dadPub }, { user_id: 'u-anna', pubkey: annaPub }]);
  assert.equal((await call('u-stranger', 'GET', { query: { vault_id: V } })).status, 403);
  // Anna (not owner) can't create the first key.
  useDevice('anna');
  const annaWraps = vk.wrapVaultKey(key, V, 1, [{ user_id: 'u-anna', pubkey: annaPub }]);
  assert.equal((await call('u-anna', 'POST', { body: { vault_id: V, version: 1, check, wraps: annaWraps } })).status, 403);
  // A wrap that names someone else's sender key is refused.
  assert.equal((await call('u-dad', 'POST', { body: { vault_id: V, version: 1, check, wraps: annaWraps } })).status, 400);
  // A removed member is not a valid recipient.
  useDevice('dad');
  const toGone = vk.wrapVaultKey(key, V, 1, [{ user_id: 'u-gone', pubkey: malPub }]);
  assert.equal((await call('u-dad', 'POST', { body: { vault_id: V, version: 1, check, wraps: [...wraps, ...toGone] } })).status, 400);
  // The owner creates version 1.
  let r = await call('u-dad', 'POST', { body: { vault_id: V, version: 1, check, wraps } });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(tables.vaults[0].vault_key_version, 1);
  assert.equal(tables.vaults[0].vault_key_checks['1'], check);
  // Nothing stored is readable.
  assert.ok(!JSON.stringify(tables.vault_keys).includes(Buffer.from(key).toString('hex')));
  // Anna reads her wrap and opens it.
  r = await call('u-anna', 'GET', { query: { vault_id: V } });
  assert.equal(r.version, 1);
  assert.equal(r.mine.length, 1);
  useDevice('anna');
  assert.deepEqual(vk.unwrapVaultKeys(r.mine, V, 'u-anna', r.checks).get(1), key);
  assert.deepEqual(r.current_holders.map(h => h.user_id).sort(), ['u-anna', 'u-dad']);
  // Replaying version 1 creation is refused; skipping ahead is refused.
  useDevice('dad');
  assert.equal((await call('u-dad', 'POST', { body: { vault_id: V, version: 3, check, wraps } })).status, 409);
  // Z1 slice 2: every wrap addressed to me across all my vaults, in one call
  // (the dashboard opens many vault names at once) -- and nobody else's.
  r = await call('u-anna', 'GET');
  assert.equal(r.status, 200);
  assert.deepEqual(r.vaults.map(v => [v.vault_id, v.version, v.mine.length]), [[V, 1, 1]]);
  useDevice('anna');
  assert.deepEqual(vk.unwrapVaultKeys(r.vaults[0].mine, V, 'u-anna', r.vaults[0].checks).get(1), key);
  assert.deepEqual((await call('u-stranger', 'GET')).vaults, []);
  assert.equal((await call(null, 'GET')).status, 401);
  pass('vault-keys: members only; only the owner creates or replaces; wraps must come from the caller and go to active members; stored rows hold no key');
}

// 6. The real proposal-comments handler stores the sealed text only, and the
//    activity log never names the vote.
{
  tables.proposals.push({ id: 'p1', vault_id: V });
  useDevice('anna');
  const key = vk.newVaultKey();
  const sealed = vk.sealField(key, 1, V, 'comment:p1', JSON.stringify({ body: 'Fine by me', vote: 'decline' }));
  who = 'u-anna';
  let r = await comments({ httpMethod: 'POST', body: JSON.stringify({ proposal_id: 'p1', sealed }), queryStringParameters: {} });
  assert.equal(r.statusCode, 201, r.body);
  const row = tables.proposal_comments[0];
  assert.equal(row.sealed, sealed); assert.equal(row.body, null); assert.equal(row.vote, null);
  assert.equal(events.at(-1).event_type, 'commented');
  assert.ok(!JSON.stringify(events).includes('decline') && !JSON.stringify(events).includes('Fine by me'));
  r = await comments({ httpMethod: 'POST', body: JSON.stringify({ proposal_id: 'p1', sealed: 'plain text' }), queryStringParameters: {} });
  assert.equal(r.statusCode, 400);
  r = await comments({ httpMethod: 'POST', body: JSON.stringify({ proposal_id: 'p1', sealed, vote: 'approve' }), queryStringParameters: {} });
  assert.equal(r.statusCode, 400);
  who = 'u-stranger';
  r = await comments({ httpMethod: 'POST', body: JSON.stringify({ proposal_id: 'p1', sealed }), queryStringParameters: {} });
  assert.equal(r.statusCode, 403);
  pass('proposal-comments: stores the sealed text only; the log says "commented", never the vote; fakes and strangers refused');
}

console.log(`vault key: ${n} checks passed`);
