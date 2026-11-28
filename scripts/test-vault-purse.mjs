/**
 * test-vault-purse.mjs -- the family purse's rules (netlify/functions/
 * _purse.js, vault-purse.js; operator, 2026-11-28: "Game master sets it at
 * the start, family vote later", "With all inputs configurable").
 *
 * Run: node --experimental-test-module-mocks scripts/test-vault-purse.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const { PURSE_DEFAULTS, validatePurseSettings, changedKeys } = await import(F('_purse.js'));
const M = ['m-dad', 'm-wife', 'm-26', 'm-23', 'm-21', 'm-18'];

// 1. The rules themselves.
assert.deepEqual(validatePurseSettings({}, M), { ok: true, settings: { ...PURSE_DEFAULTS } });
pass('the defaults are valid on their own');
assert.match(validatePurseSettings({ approvals_needed: 7 }, M).error, /more than the 6 people/);
assert.match(validatePurseSettings({ approvals_needed: 3, voters: ['m-dad', 'm-wife'] }, M).error, /more than the 2 people/);
assert.match(validatePurseSettings({ voters: ['stranger'] }, M).error, /not an active member/);
assert.match(validatePurseSettings({ treasurer_member_id: 'stranger' }, M).error, /treasurer/);
assert.match(validatePurseSettings({ monthly_cap_sats: 50_000 }, M).error, /monthly cap cannot be smaller/);
assert.match(validatePurseSettings({ per_payout_limit_sats: 2_000_000, monthly_cap_sats: 3_000_000 }, M).error, /bigger than the on-chain threshold/);
assert.match(validatePurseSettings({ request_expiry_days: 0 }, M).error, /between 1 and 90/);
assert.match(validatePurseSettings({ refill_sats: -1 }, M).error, /refill/);
pass('refuses yeses beyond the voters, strangers, a cap below one payout, a payout above the on-chain line, bad expiry');
assert.equal(validatePurseSettings({ approvals_needed: '2', treasurer_member_id: 'm-dad' }, M).settings.approvals_needed, 2);
assert.deepEqual(changedKeys(PURSE_DEFAULTS, { ...PURSE_DEFAULTS, approvals_needed: 4 }), ['approvals_needed']);
pass('reads number text from a form and names what changed');

// 2. The function.
let db;
const reset = () => {
  db = { vault: { id: 'v1', user_id: 'dad' }, members: M.map((id, i) => ({ id, user_id: i === 0 ? 'dad' : `u${i}`, role: i === 0 ? 'owner' : 'founder', label: id.slice(2), status: 'active' })), purse: null, events: [] };
};
const q = (table) => {
  const f = {};
  const o = {
    select: () => o, eq: (k, v) => { f[k] = v; return o; }, order: () => o, limit: () => o,
    maybeSingle: async () => {
      if (table === 'vaults') return { data: f.id === db.vault.id ? db.vault : null, error: null };
      if (table === 'vault_purse') return { data: db.purse && f.vault_id === db.vault.id ? db.purse : null, error: null };
      return { data: null, error: null };
    },
    upsert: async (row) => { db.purse = { ...row }; return { error: null }; },
    then: (res) => res({ data: table === 'vault_members' ? db.members.filter((m) => m.status === f.status) : [], error: null }),
  };
  return o;
};
const supabase = { from: q, rpc: async () => ({ data: 1, error: null }) };
let user = null;
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => supabase } });
const realAuth = await import(F('_auth.js'));
mock.module(F('_auth.js'), { namedExports: { ...realAuth, requireUser: async () => (user ? { userId: user } : { error: 'Not signed in' }), json: (statusCode, body) => ({ statusCode, headers: {}, body }) } });
const realLedger = await import(F('_ledger.js'));
mock.module(F('_ledger.js'), { namedExports: { ...realLedger, recordEvent: async (_s, e) => { db.events.push(e); } } });
const { handler } = await import(F('vault-purse.js'));
const get = () => handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { vault_id: 'v1' } });
const put = (settings) => handler({ httpMethod: 'PUT', headers: {}, body: JSON.stringify({ vault_id: 'v1', settings }) });
const handover = (confirm = true) => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1', action: 'handover', confirm }) });

reset();
user = 'u3';
let r = await get();
assert.equal(r.statusCode, 200); assert.equal(r.body.saved, false); assert.equal(r.body.can_edit, false); assert.equal(r.body.members.length, 6);
pass('a family member sees the defaults and cannot edit');
assert.equal((await put({ approvals_needed: 1 })).statusCode, 403);
user = 'outsider';
assert.equal((await get()).statusCode, 403);
pass('a member cannot change the rules; an outsider cannot even read them');

user = 'dad';
r = await put({ approvals_needed: 4, treasurer_member_id: 'm-wife' });
assert.equal(r.statusCode, 200); assert.equal(db.purse.settings.approvals_needed, 4); assert.equal(db.purse.governance, 'owner');
assert.deepEqual(db.events.at(-1), { vault_id: 'v1', user_id: 'dad', event_type: 'purse_rules_set', metadata: { changed: ['approvals_needed', 'treasurer_member_id'], settings: db.purse.settings } });
pass('the owner sets the rules, and the change is sealed into the ledger with what changed');
assert.equal((await put({ approvals_needed: 9 })).statusCode, 400);
assert.equal(db.purse.settings.approvals_needed, 4);
pass('a bad change is refused and nothing is saved');

assert.equal((await handover(false)).statusCode, 400);
r = await handover();
assert.equal(r.statusCode, 200); assert.equal(db.purse.governance, 'family'); assert.ok(db.purse.handed_over_at);
assert.equal(db.purse.settings.approvals_needed, 4);
assert.equal(db.events.at(-1).event_type, 'purse_rules_handed_to_family');
pass('the handover needs an explicit confirm, keeps the rules, and is sealed');
assert.equal((await put({ approvals_needed: 2 })).statusCode, 409);
assert.equal((await handover()).statusCode, 409);
assert.equal((await get()).body.can_edit, false);
pass('after the handover the owner can no longer change the rules or hand them over again');

const { isMilestone } = await import(F('_anchor.js'));
assert.ok(isMilestone('purse_rules_set') && isMilestone('purse_rules_handed_to_family'));
pass('both are anchored to Bitcoin at once');

console.log(`test-vault-purse: ${n} passed`);
