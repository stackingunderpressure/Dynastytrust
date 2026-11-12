/**
 * test-sealed-actions.mjs -- every action that changes a vault or who
 * belongs to it reaches the sealed record (operator, 2026-11-12: "the
 * roles of each person who joins the vault, the labeling and the logging
 * of their actions and their path into the vaults").
 *
 * Runs the REAL handlers (invites.js, vault-membership-grants.js,
 * liveness.js, vaults.js, signer-sessions.js) against an in-memory
 * stand-in for the database, sign-in and the ledger, and checks for each
 * action: the entry is sealed, with the right event type and actor, with
 * nothing secret in it, and only when something actually changed.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-sealed-actions.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const real = await import(new URL('../netlify/functions/_ledger.js?real', import.meta.url).href);
const { isMilestone } = await import('../netlify/functions/_anchor.js');

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

// ---- an in-memory database that speaks enough of the supabase client
const tables = { vaults: [], vault_invites: [], vault_members: [], vault_membership_grants: [], liveness_signals: [], proposals: [], signer_sessions: [] };
let idSeq = 0;
let oldSignerRoleRule = false; // simulate the database before 20261112230000_signer_role_real.sql
function from(table) {
  const rows = tables[table] ?? (tables[table] = []);
  const filters = []; let op = 'select', payload = null, wantRows = false, headCount = false;
  const match = (r) => filters.every(f => f(r));
  // Like the real client, every answer is a copy, never the stored row.
  const run = () => { const r = runRaw(); return { ...r, rows: r.rows.map((x) => structuredClone(x)) }; };
  const runRaw = () => {
    if ((op === 'insert' || op === 'update') && table === 'signer_sessions' && oldSignerRoleRule && payload.signer_role && !['founder', 'heir'].includes(payload.signer_role)) {
      return { rows: [], error: { code: '23514', message: 'new row for relation "signer_sessions" violates check constraint "signer_sessions_signer_role_check"' } };
    }
    if (op === 'insert') { const row = { id: `${table}-${++idSeq}`, created_at: new Date().toISOString(), ...payload }; rows.push(row); return { rows: [row] }; }
    if (op === 'upsert') {
      const hit = rows.find(r => r.vault_id === payload.vault_id && r.role === payload.role && r.key_id === payload.key_id);
      if (hit) { Object.assign(hit, payload); return { rows: [hit] }; }
      const row = { id: `${table}-${++idSeq}`, created_at: new Date().toISOString(), ...payload }; rows.push(row); return { rows: [row] };
    }
    if (op === 'update') { const hit = rows.filter(match); hit.forEach(r => Object.assign(r, payload)); return { rows: hit }; }
    if (op === 'delete') { const hit = rows.filter(match); for (const r of hit) rows.splice(rows.indexOf(r), 1); return { rows: hit }; }
    return { rows: rows.filter(match) };
  };
  const q = {
    select: (_f, opts) => { wantRows = true; if (opts?.head) headCount = true; return q; },
    insert: (row) => { op = 'insert'; payload = row; return q; },
    upsert: (row) => { op = 'upsert'; payload = row; return q; },
    update: (obj) => { op = 'update'; payload = obj; return q; },
    delete: () => { op = 'delete'; return q; },
    eq: (k, v) => { filters.push(r => r[k] === v); return q; },
    neq: (k, v) => { filters.push(r => r[k] !== v); return q; },
    is: (k, v) => { filters.push(r => (r[k] ?? null) === v); return q; },
    order: () => q,
    limit: () => q,
    maybeSingle: async () => { const r = run(); return { data: r.rows[0] ?? null, error: r.error ?? null }; },
    single: async () => { const r = run(); if (r.error) return { data: null, error: r.error }; const d = r.rows[0]; return d ? { data: d, error: null } : { data: null, error: { message: 'no rows' } }; },
    then: (res) => { const r = run(); res(headCount ? { count: r.rows.length, error: null } : { data: wantRows || op === 'select' ? r.rows : null, error: r.error ?? null }); },
  };
  return q;
}
const supabase = { from };
const sealed = [];
let who = null;
mock.module(new URL('../netlify/functions/_auth.js', import.meta.url).href, { namedExports: {
  requireUser: async () => (who ? who : { error: 'Not signed in' }),
  json: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) }),
} });
mock.module(new URL('../netlify/functions/_supabase.js', import.meta.url).href, { namedExports: { getSupabaseAdmin: () => supabase } });
mock.module(new URL('../netlify/functions/_ledger.js', import.meta.url).href, { namedExports: {
  recordEvent: async (_s, e) => { sealed.push(e); return { error: null }; },
  canonicalJson: real.canonicalJson,
} });
// Signature checks have their own tests (test-liveness / harness); here a
// signal or a signed PSBT is taken as already verified, naming its keys.
let psbtSigners = [];
mock.module(new URL('../netlify/functions/_psbt-verify.js', import.meta.url).href, { namedExports: {
  verifySignedPsbt: () => ({ ok: true, validSignatures: psbtSigners.length }),
  signersOnEveryInput: () => psbtSigners,
} });
mock.module(new URL('../netlify/functions/_liveness.js', import.meta.url).href, { namedExports: {
  verifyLivenessSignalForStorage: ({ kind, signal }) => ({ ok: true, subject: signal.subject, raisedBy: kind === 'duress-flag' ? signal.raisedBy : null }),
  loadVaultLivenessConfig: () => null,
} });

const H = {};
for (const f of ['invites', 'vault-membership-grants', 'liveness', 'vaults', 'signer-sessions']) H[f] = (await import(`../netlify/functions/${f}.js`)).handler;
const call = async (fn, method, { body, query } = {}) => {
  const r = await H[fn]({ httpMethod: method, body: body ? JSON.stringify(body) : undefined, queryStringParameters: query ?? {} });
  return { status: r.statusCode, ...JSON.parse(r.body) };
};
const as = (userId) => { who = userId ? { userId, claims: { sub: userId, aal: 'aal1' } } : null; };
const last = () => sealed[sealed.length - 1];
const sealedSince = (mark) => sealed.slice(mark);

const OWNER = 'u-dad', ANNA = 'u-anna', BEN = 'u-ben';
const K = (c) => '02' + c.repeat(64);       // a compressed key; x-only is the last 64
const DAD_KEY = K('a'), ANNA_KEY = K('b'), BEN_KEY = K('c'), GRAN_KEY = K('d');
tables.vaults.push({
  id: 'v1', user_id: OWNER, name: 'Family vault', network: 'signet', status: 'compiled', archived: false, duress: false,
  trust_doc: { purpose: 'Care for the family' }, key_labels: [], key_origins: [], consent_keys: [GRAN_KEY], consent_quorum: 1,
  leaves: [
    { id: 'everyday', label: 'Everyday', keys: [ANNA_KEY, BEN_KEY], quorum: 1, required_keys: [DAD_KEY], unlock: { type: 'immediate' }, decay: null },
    { id: 'later', label: 'Later', keys: [ANNA_KEY], quorum: 1, unlock: { type: 'after', blocks: 950000 }, decay: null },
  ],
}, { id: 'v-draft', user_id: OWNER, name: 'Draft', network: 'signet', status: 'draft', archived: false, duress: false, trust_doc: {}, key_labels: [], key_origins: [], leaves: [] });
tables.vault_members.push(
  { id: 'm-dad', vault_id: 'v1', user_id: OWNER, role: 'owner', label: 'Dad', status: 'active', pubkey: DAD_KEY, fingerprint: 'aaaaaaaa' },
  { id: 'm-anna', vault_id: 'v1', user_id: ANNA, role: 'protector', label: 'Anna', status: 'active', pubkey: ANNA_KEY, fingerprint: 'bbbbbbbb' },
  { id: 'm-ben', vault_id: 'v1', user_id: BEN, role: 'viewer', label: 'Ben', status: 'active', pubkey: BEN_KEY, fingerprint: 'cccccccc' },
);

// 1. Withdrawing an invite.
tables.vault_invites.push({ id: 'inv-1', vault_id: 'v1', invited_by: OWNER, invited_role: 'heir', invited_label: 'Cousin', invited_email: 'cousin@example.com', leaf_id: 'later', claimed_at: null, token: 't'.repeat(48) });
as(ANNA);
let r = await call('invites', 'DELETE', { query: { id: 'inv-1' } });
assert.equal(r.status, 403); assert.equal(sealed.length, 0);
as(OWNER);
r = await call('invites', 'DELETE', { query: { id: 'inv-1' } });
assert.equal(r.status, 200);
assert.deepEqual([last().event_type, last().vault_id, last().user_id], ['invite_revoked', 'v1', OWNER]);
assert.deepEqual(last().metadata, { invite_id: 'inv-1', role: 'heir', label: 'Cousin', leaf_id: 'later', was_claimed: false });
assert.ok(!JSON.stringify(sealed).includes('cousin@example.com') && !JSON.stringify(sealed).includes('t'.repeat(48)), 'neither the email nor the invite link is sealed');
pass('withdrawing an invite is sealed by the owner who did it, with the path and role but no email or link');

// 2. Offering membership, and the member's answer.
let mark = sealed.length;
r = await call('vault-membership-grants', 'POST', { body: { vault_id: 'v1', role: 'heir', key_id: 'k-anna', recipient_label: 'Anna', recipient_pubkey: 'ab'.repeat(32), reply_pubkey: 'cd'.repeat(32), reply_privkey: 'SECRET-REPLY-KEY' } });
assert.equal(r.status, 201);
const grantId = r.grant.id;
for (const status of ['accepted', 'left', 'declined']) {
  r = await call('vault-membership-grants', 'PATCH', { query: { id: grantId }, body: { status } });
  assert.equal(r.status, 200, `${status}: ${JSON.stringify(r)}`);
  assert.equal(r.grant.vault_id, undefined, 'the reply shape returned to the app is unchanged');
}
r = await call('vault-membership-grants', 'PATCH', { query: { id: grantId }, body: { status: 'left' } });
assert.equal(r.status, 409, 'leaving a grant that is not accepted is refused');
const g = sealedSince(mark);
assert.deepEqual(g.map(e => e.event_type), ['grant_sent', 'grant_accepted', 'grant_left', 'grant_declined'], 'a refused leave is not sealed');
assert.ok(g.every(e => e.vault_id === 'v1' && e.metadata.recipient_label === 'Anna' && e.metadata.role === 'heir'));
assert.ok(!JSON.stringify(g).includes('SECRET-REPLY-KEY'), 'the messaging private key is never sealed');
pass('offering membership and each answer (accepted, stepped away, declined) are sealed; the messaging private key never is');

// 3. The duress alarm: raised by a member, named; cleared by the owner.
mark = sealed.length;
as(ANNA);
r = await call('liveness', 'POST', { body: { vault_id: 'v1', kind: 'proof-of-life', signal: { subject: 'b'.repeat(64), issuedAt: '2026-11-12T10:00:00Z' } } });
assert.equal(r.status, 201);
assert.equal(sealedSince(mark).length, 0, 'a routine heartbeat is not sealed');
r = await call('liveness', 'POST', { body: { vault_id: 'v1', kind: 'duress-flag', signal: { subject: 'a'.repeat(64), raisedBy: 'b'.repeat(64), sig: 'f'.repeat(128) } } });
assert.equal(r.status, 201);
assert.deepEqual([last().event_type, last().user_id, last().metadata.raised_by_key, last().metadata.subject_key], ['duress_raised', ANNA, 'b'.repeat(64), 'a'.repeat(64)]);
assert.equal(last().metadata.signal.sig, 'f'.repeat(128), 'the signed signal itself is sealed, so the record proves it');
r = await call('liveness', 'DELETE', { query: { vault_id: 'v1', subject: 'a'.repeat(64) } });
assert.equal(r.status, 403, 'only the owner clears an alarm');
as(OWNER);
r = await call('liveness', 'DELETE', { query: { vault_id: 'v1', subject: 'a'.repeat(64) } });
assert.equal(r.status, 200);
assert.deepEqual([last().event_type, last().user_id, last().metadata.cleared[0].raised_by_key], ['duress_cleared', OWNER, 'b'.repeat(64)]);
r = await call('liveness', 'DELETE', { query: { vault_id: 'v1', subject: 'a'.repeat(64) } });
assert.equal(sealedSince(mark).length, 2, 'clearing when there is no alarm seals nothing');
assert.ok(isMilestone('duress_raised') && isMilestone('duress_cleared') && isMilestone('key_origins_repaired'), 'duress and hardware key repair are pinned to Bitcoin at once');
assert.ok(!isMilestone('vault_renamed') && !isMilestone('grant_sent'), 'everything else waits for the daily sweep');
pass('a duress alarm is sealed naming who raised it with the signed signal; clearing names the owner; heartbeats are not sealed; both are pinned at once');

// 4. Vault edits: only real changes on a finished vault.
mark = sealed.length;
const patch = (id, body) => call('vaults', 'PATCH', { query: { id }, body });
r = await patch('v1', { name: 'The Winchester vault' }); assert.equal(r.status, 200);
r = await patch('v1', { name: 'The Winchester vault' });
r = await patch('v1', { archived: true }); r = await patch('v1', { archived: true }); r = await patch('v1', { archived: false });
r = await patch('v1', { duress: true }); r = await patch('v1', { duress: false });
r = await patch('v1', { trust_doc: { purpose: 'Care for the family' } });
r = await patch('v1', { trust_doc: { purpose: 'Care for the family and the farm' } });
assert.equal(r.status, 200);
const edits = sealedSince(mark);
assert.deepEqual(edits.map(e => e.event_type), ['vault_renamed', 'vault_archived', 'vault_unarchived', 'halt_on', 'halt_off', 'trust_doc_updated'], 'an edit that changes nothing is not sealed');
assert.deepEqual(edits[0].metadata, { from: 'Family vault', to: 'The Winchester vault' });
const doc = edits[5].metadata;
assert.match(doc.fingerprint_after, /^[0-9a-f]{64}$/); assert.notEqual(doc.fingerprint_before, doc.fingerprint_after);
assert.ok(!JSON.stringify(edits).includes('the farm'), 'the trust document is sealed by fingerprint, not by its text');
mark = sealed.length;
r = await patch('v-draft', { name: 'Draft two' }); assert.equal(r.status, 200);
assert.equal(sealedSince(mark).length, 0, 'a draft being shaped is not sealed edit by edit');
pass('renaming, archiving, halting and trust document edits on a finished vault are sealed only when they change; the document by its fingerprint; drafts are not');

// 5. Key labels and what a hardware wallet is told about a key.
mark = sealed.length;
r = await patch('v1', { key_label: { pubkey: ANNA_KEY, label: "Anna's Coldcard" } }); assert.equal(r.status, 200);
r = await patch('v1', { key_label: { pubkey: ANNA_KEY, label: "Anna's Coldcard" } });
r = await patch('v1', { key_label: { pubkey: ANNA_KEY, label: null } });
const origins = [{ pubkey: ANNA_KEY, fingerprint: 'bbbbbbbb', derivation_path: "m/48'/1'/0'/2'/0/0" }];
r = await patch('v1', { key_origins: origins }); assert.equal(r.status, 200, JSON.stringify(r));
r = await patch('v1', { key_origins: origins });
const keys = sealedSince(mark);
assert.deepEqual(keys.map(e => e.event_type), ['key_label_changed', 'key_label_changed', 'key_origins_repaired']);
assert.deepEqual(keys[0].metadata, { key: ANNA_KEY, from: null, to: "Anna's Coldcard" });
assert.deepEqual(keys[1].metadata, { key: ANNA_KEY, from: "Anna's Coldcard", to: null });
assert.deepEqual(keys[2].metadata, { before: [], after: origins });
pass("renaming a key and changing a key's hardware wallet details are sealed, with before and after, only when they change");

// 6. A signature carries the signer's real role, path and capacity.
tables.proposals.push({ id: 'p1', vault_id: 'v1', psbt_hex: '70736274ff', path: 'everyday' });
const sign = (who, signers) => { as(who); psbtSigners = signers; return call('signer-sessions', 'POST', { body: { proposal_id: 'p1', psbt_partial_hex: '70736274ff01' } }); };
mark = sealed.length;
r = await sign(OWNER, ['a'.repeat(64)]);
assert.equal(r.status, 200, JSON.stringify(r));
assert.equal(r.session.signer_role, 'owner', 'the owner is recorded as the owner, not as a founder');
assert.deepEqual([last().event_type, last().metadata.role, last().metadata.path], ['signed', 'owner', 'everyday']);
assert.deepEqual(last().metadata.signed_as, [{ key: 'a'.repeat(64), as: 'must_sign' }]);
r = await sign(ANNA, ['b'.repeat(64)]);
assert.equal(r.session.signer_role, 'protector', 'a protector is recorded as a protector');
assert.deepEqual(last().metadata.signed_as, [{ key: 'b'.repeat(64), as: 'signer' }]);
r = await sign(BEN, ['c'.repeat(64)]);
assert.equal(r.status, 403, 'a view-only member cannot record a signature');
// The consent key of the primary path is labelled as such.
tables.vault_members.push({ id: 'm-gran', vault_id: 'v1', user_id: 'u-gran', role: 'beneficiary', label: 'Gran', status: 'active', pubkey: GRAN_KEY, fingerprint: 'dddddddd' });
r = await sign('u-gran', ['d'.repeat(64)]);
assert.equal(r.session.signer_role, 'beneficiary');
assert.deepEqual(last().metadata.signed_as, [{ key: 'd'.repeat(64), as: 'consent' }]);
assert.equal(sealedSince(mark).length, 3);
pass('a signature records the real role (owner, protector, beneficiary) and seals the path and whether the key signed as must-sign, consent or an ordinary signer');

// 7. If production code meets the database before the migration, the
//    signature is kept under the old label and the sealed entry still
//    names the real role.
oldSignerRoleRule = true;
tables.signer_sessions.length = 0;
r = await sign(OWNER, ['a'.repeat(64)]);
assert.equal(r.status, 200, JSON.stringify(r));
assert.equal(r.session.signer_role, 'founder');
assert.equal(last().metadata.role, 'owner');
r = await sign(ANNA, ['b'.repeat(64)]);
assert.equal(r.status, 200); assert.equal(r.session.signer_role, 'founder');
oldSignerRoleRule = false;
pass('before the database change is applied, a signature is never lost over its label; the sealed entry still names the real role');

console.log(`\ntest-sealed-actions OK (${n} checks)`);
