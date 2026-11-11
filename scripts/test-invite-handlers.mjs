/**
 * test-invite-handlers.mjs -- runs the REAL handlers for inviting,
 * joining, confirming and finalizing (netlify/functions/invites.js,
 * invites-lookup.js, invites-claim.js, members.js, compile-leaves.js)
 * against an in-memory stand-in for the database, sign-in and the
 * ledger, and walks the whole loop a family goes through:
 *   owner invites Anna to a path -> a stranger with the link is refused
 *   -> Anna joins with her own key -> finalizing is refused until the
 *   owner confirms her fingerprint -> after that her key cannot change.
 * Wired into `npm test`.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-invite-handlers.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { HDKey } from '@scure/bip32';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const hex = (b) => Buffer.from(b).toString('hex');
const mk = (seedByte, versions, path) => {
  const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte), versions);
  const acct = root.derive(path);
  return { xpub: acct.publicExtendedKey, pubkey: hex(acct.deriveChild(0).deriveChild(0).publicKey), fingerprint: hex(root.identifier.slice(0, 4)), derivation_path: path };
};
const TEST = { private: 0x04358394, public: 0x043587cf }, MAIN = { private: 0x0488ade4, public: 0x0488b21e };
const annaKey = mk(1, TEST, "m/48'/1'/0'/2'"), benKey = mk(2, TEST, "m/48'/1'/0'/2'"), annaMain = mk(1, MAIN, "m/48'/0'/0'/2'");

// ---- an in-memory database that speaks enough of the supabase client
const tables = { vaults: [], vault_invites: [], vault_members: [], events: [] };
let idSeq = 0;
function from(table) {
  const rows = tables[table] ?? (tables[table] = []);
  const filters = []; let op = 'select', payload = null, wantRows = false;
  const match = (r) => filters.every(f => f(r));
  const run = () => {
    if (op === 'insert') { const row = { id: `${table}-${++idSeq}`, created_at: new Date().toISOString(), ...payload }; rows.push(row); return [row]; }
    if (op === 'update') { const hit = rows.filter(match); hit.forEach(r => Object.assign(r, payload)); return hit; }
    if (op === 'delete') { const hit = rows.filter(match); for (const r of hit) rows.splice(rows.indexOf(r), 1); return hit; }
    return rows.filter(match);
  };
  const q = {
    select: () => { wantRows = true; return q; },
    insert: (row) => { op = 'insert'; payload = row; return q; },
    update: (obj) => { op = 'update'; payload = obj; return q; },
    delete: () => { op = 'delete'; return q; },
    eq: (k, v) => { filters.push(r => r[k] === v); return q; },
    neq: (k, v) => { filters.push(r => r[k] !== v); return q; },
    is: (k, v) => { filters.push(r => (r[k] ?? null) === v); return q; },
    order: () => q,
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    single: async () => { const d = run()[0]; return d ? { data: d, error: null } : { data: null, error: { message: 'no rows' } }; },
    then: (res) => res({ data: wantRows || op === 'select' ? run() : (run(), null), error: null }),
  };
  return q;
}
const supabase = { from };
let who = null;   // { userId, claims }
mock.module(new URL('../netlify/functions/_auth.js', import.meta.url).href, { namedExports: {
  requireUser: async () => (who ? who : { error: 'Not signed in' }),
  json: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) }),
} });
mock.module(new URL('../netlify/functions/_supabase.js', import.meta.url).href, { namedExports: { getSupabaseAdmin: () => supabase } });
mock.module(new URL('../netlify/functions/_ledger.js', import.meta.url).href, { namedExports: { recordEvent: async (_s, e) => { tables.events.push(e); return { error: null }; } } });
process.env.COMPILER_URL = 'http://compiler.invalid';
const H = {};
for (const f of ['invites', 'invites-lookup', 'invites-claim', 'members', 'compile-leaves']) H[f] = (await import(`../netlify/functions/${f}.js`)).handler;
const call = async (fn, method, { body, query } = {}) => {
  const r = await H[fn]({ httpMethod: method, body: body ? JSON.stringify(body) : undefined, queryStringParameters: query ?? {} });
  return { status: r.statusCode, ...JSON.parse(r.body) };
};
const as = (userId, email, aal = 'aal1') => { who = userId ? { userId, claims: { sub: userId, email, aal } } : null; };

const OWNER = 'u-dad';
const vault = { id: 'v1', user_id: OWNER, name: 'Family vault', network: 'signet', status: 'draft', address_type: 'tr_multileaf', consent_keys: [], consent_quorum: null,
  leaves: [
    { id: 'everyday', label: 'Everyday signers', keys: [benKey.pubkey], quorum: 1, unlock: { type: 'immediate' }, decay: null },
    { id: 'kids', label: 'The kids', keys: [], quorum: 1, unlock: { type: 'after', blocks: 262800 }, decay: null } ] };
tables.vaults.push(vault, { ...vault, id: 'v-main', network: 'bitcoin' });
tables.vault_members.push({ id: 'm-dad', vault_id: 'v1', user_id: OWNER, role: 'owner', label: 'Dad', status: 'active', pubkey: benKey.pubkey, fingerprint: benKey.fingerprint });

// 1. The owner invites Anna to hold a key on "The kids".
as('u-mallory', 'mallory@example.com');
let r = await call('invites', 'POST', { body: { vault_id: 'v1', leaf_id: 'kids', invited_label: 'Anna', invited_email: 'anna@example.com' } });
assert.equal(r.status, 403);
as(OWNER, 'dad@example.com');
r = await call('invites', 'POST', { body: { vault_id: 'v1', leaf_id: 'kids', invited_label: 'Anna', invited_email: 'not-an-email' } });
assert.equal(r.status, 400); assert.equal(tables.vault_invites.length, 0);
r = await call('invites', 'POST', { body: { vault_id: 'v1', leaf_id: 'kids', invited_label: 'Anna', invited_email: 'Anna@Example.com' } });
assert.equal(r.status, 201, JSON.stringify(r));
const invite = tables.vault_invites[0];
assert.deepEqual([invite.leaf_id, invite.invited_role, invite.invited_label, invite.invited_email, invite.invited_by], ['kids', 'heir', 'Anna', 'anna@example.com', OWNER]);
assert.ok(invite.token.length >= 40);
assert.ok(!JSON.stringify(tables.events).includes('anna@example.com'), 'the email address is not sealed into the record');
// the older role-based invite still works as before
r = await call('invites', 'POST', { body: { vault_id: 'v1', invited_role: 'viewer' } });
assert.equal(r.status, 201); assert.equal(tables.vault_invites[1].leaf_id, undefined);
pass('only the owner can invite; a path invite stores the path, the role it implies, the name and the email');

// 2. What the invite page shows before sign-in: her path, nothing else.
as(null);
r = await call('invites-lookup', 'GET', { query: { token: invite.token } });
assert.equal(r.status, 200);
assert.deepEqual(r.vault.paths.map(p => p.id), ['kids']);
assert.deepEqual(r.members, []);
assert.equal(r.invite.email_hint, 'a***@example.com');
assert.ok(!JSON.stringify(r).includes(benKey.pubkey) && !JSON.stringify(r).includes('anna@example.com') && !JSON.stringify(r).includes('Everyday'));
pass('the invite page shows the invited person their own path only, with the email masked and no keys');

// 3. Someone else with the link, and a bad key, are refused -- and the invite survives.
const claim = (key = annaKey, token = invite.token) => call('invites-claim', 'POST', { body: { token, ...key } });
as('u-mallory', 'mallory@example.com');
r = await claim(); assert.equal(r.status, 403); assert.match(r.error, /different email address/);
as('u-anna', 'anna@example.com');
r = await claim({ ...annaKey, pubkey: benKey.pubkey }); assert.equal(r.status, 400); assert.match(r.error, /does not belong to the xpub/);
r = await claim({}); assert.equal(r.status, 400);
r = await claim(annaMain); assert.equal(r.status, 400); assert.match(r.error, /real-bitcoin key/);
r = await claim(benKey); assert.equal(r.status, 409); assert.match(r.error, /fingerprint is already in this vault/);
assert.equal(invite.claimed_at ?? null, null, 'refused attempts must not consume the invite');
assert.equal(tables.vault_members.length, 1);
// real bitcoin: a session that has not passed the second step cannot join
tables.vault_invites.push({ id: 'i-main', vault_id: 'v-main', invited_role: 'heir', invited_label: 'Anna', invited_email: 'anna@example.com', leaf_id: 'kids', token: 'tok-main', expires_at: new Date(Date.now() + 1e9).toISOString(), claimed_at: null });
r = await claim(annaMain, 'tok-main'); assert.equal(r.status, 403); assert.equal(r.needs_two_step, true);
as('u-anna', 'anna@example.com', 'aal2');
r = await claim(annaMain, 'tok-main'); assert.equal(r.status, 200, JSON.stringify(r));
pass('a stranger with the link, a mismatched or wrong-network key, a duplicate key and a one-step session on real bitcoin are refused without burning the invite');

// 4. Anna joins with her own key.
as('u-anna', 'anna@example.com');
r = await claim(); assert.equal(r.status, 200, JSON.stringify(r));
const anna = tables.vault_members.find(m => m.vault_id === 'v1' && m.user_id === 'u-anna');
assert.deepEqual([anna.role, anna.leaf_id, anna.label, anna.pubkey, anna.xpub, anna.fingerprint, anna.derivation_path, anna.status], ['heir', 'kids', 'Anna', annaKey.pubkey, annaKey.xpub, annaKey.fingerprint, annaKey.derivation_path, 'active']);
assert.equal(anna.key_confirmed_at ?? null, null);
assert.equal((await claim()).status, 409, 'the invite cannot be used twice');
assert.deepEqual(tables.events.at(-1).event_type, 'member_joined');
pass('the invited person joins with their own validated key, on their path, unconfirmed');

// 5. Finalizing is refused until the owner confirms her fingerprint.
vault.leaves[1].keys = [annaKey.pubkey];
as(OWNER, 'dad@example.com');
r = await call('compile-leaves', 'POST', { body: { vault_id: 'v1' } });
assert.equal(r.status, 400); assert.match(r.error, /Anna's key on "The kids" has not been confirmed/);
assert.equal(vault.status, 'draft');
as('u-anna', 'anna@example.com');
r = await call('members', 'PATCH', { query: { id: anna.id }, body: { confirm_key: true, fingerprint: annaKey.fingerprint } });
assert.equal(r.status, 403, 'a member cannot confirm their own key');
as(OWNER, 'dad@example.com');
r = await call('members', 'PATCH', { query: { id: anna.id }, body: { confirm_key: true, fingerprint: benKey.fingerprint } });
assert.equal(r.status, 409); assert.match(r.error, /not this person's current key/);
assert.equal(anna.key_confirmed_at ?? null, null);
r = await call('members', 'PATCH', { query: { id: anna.id }, body: { confirm_key: true, fingerprint: annaKey.fingerprint.toUpperCase() } });
assert.equal(r.status, 200, JSON.stringify(r));
assert.ok(anna.key_confirmed_at); assert.equal(anna.key_confirmed_by, OWNER);
assert.deepEqual([tables.events.at(-1).event_type, tables.events.at(-1).metadata.fingerprint, tables.events.at(-1).metadata.leaf_id], ['key_confirmed', annaKey.fingerprint, 'kids']);
pass('finalizing is refused while her key is unconfirmed; only the owner can confirm, and only against the fingerprint on record');

// 6. What was confirmed cannot be swapped afterwards.
as('u-anna', 'anna@example.com');
const other = mk(9, TEST, "m/48'/1'/0'/2'");
r = await call('members', 'PATCH', { query: { id: anna.id }, body: other });
assert.equal(r.status, 409); assert.match(r.error, /confirmed by the vault owner and can no longer be changed/);
assert.equal(anna.pubkey, annaKey.pubkey);
r = await call('members', 'PATCH', { query: { id: anna.id }, body: { label: 'Anna W.' } });
assert.equal(r.status, 200); assert.equal(anna.label, 'Anna W.');
// before confirmation a path member may fix their key, with the same checks as at joining
anna.key_confirmed_at = null;
r = await call('members', 'PATCH', { query: { id: anna.id }, body: { ...other, pubkey: benKey.pubkey } });
assert.equal(r.status, 400); assert.match(r.error, /does not belong to the xpub/);
r = await call('members', 'PATCH', { query: { id: anna.id }, body: other });
assert.equal(r.status, 200); assert.equal(anna.pubkey, other.pubkey);
pass('a confirmed key cannot be changed; an unconfirmed one can, with the same checks as at joining');

// 7. Nobody new can join once the vault is finalized.
tables.vault_invites.push({ id: 'i-late', vault_id: 'v1', invited_role: 'heir', invited_label: 'Late', invited_email: 'late@example.com', leaf_id: 'kids', token: 'tok-late', expires_at: new Date(Date.now() + 1e9).toISOString(), claimed_at: null });
vault.status = 'compiled';
as('u-late', 'late@example.com');
r = await claim(mk(5, TEST, "m/48'/1'/0'/2'"), 'tok-late');
assert.equal(r.status, 409); assert.match(r.error, /already been finalized/);
as(OWNER, 'dad@example.com');
r = await call('invites', 'POST', { body: { vault_id: 'v1', leaf_id: 'kids', invited_label: 'Zoe', invited_email: 'zoe@example.com' } });
assert.equal(r.status, 400); assert.match(r.error, /still being set up/);
pass('once a vault is finalized nobody can be invited to it or join it');

console.log(`invite-handler tests passed (${n} cases)`);
