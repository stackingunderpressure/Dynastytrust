/**
 * test-rotate-handler.mjs -- runs the real /api/vaults-rotate handler
 * (netlify/functions/vaults-rotate.js) against stand-ins for sign-in,
 * the database and the ledger, to prove what it WRITES: a path-builder
 * vault becomes a leaves draft with every key carried and only the
 * dated paths' waits changed; a named-field vault still rotates as it
 * always did; a Bloc vault, a stranger, a draft and bad dates are
 * refused with nothing written. Wired into `npm test`.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-rotate-handler.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const K = (c) => '02' + c.repeat(64);
const OWNER = 'owner-1', YEAR = 52_560, ABS = 950_000;

const db = { vaults: [], members: [], inserted: [], upserts: [], events: [] };
const supabase = {
  from(table) {
    const f = [];
    const q = {
      select: () => q,
      eq: (k, v) => { f.push([k, v]); return q; },
      maybeSingle: async () => ({ data: db.vaults.find(r => f.every(([k, v]) => r[k] === v)) ?? null, error: null }),
      then: (res) => res({ data: table === 'vault_members' ? db.members.filter(r => f.every(([k, v]) => r[k] === v)) : [], error: null }),
      insert: (row) => ({ select: () => ({ single: async () => { const created = { id: `new-${db.inserted.length + 1}`, ...row }; db.inserted.push(created); return { data: created, error: null }; } }) }),
      upsert: async (rows) => { db.upserts.push(...rows); return { error: null }; },
    };
    return q;
  },
};
let caller = OWNER;
mock.module(new URL('../netlify/functions/_auth.js', import.meta.url).href, {
  namedExports: {
    requireUser: async () => (caller ? { userId: caller } : { error: 'Not signed in' }),
    json: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) }),
  },
});
mock.module(new URL('../netlify/functions/_supabase.js', import.meta.url).href, { namedExports: { getSupabaseAdmin: () => supabase } });
mock.module(new URL('../netlify/functions/_ledger.js', import.meta.url).href, { namedExports: { recordEvent: async (_s, e) => { db.events.push(e); return { error: null }; } } });
const { handler } = await import('../netlify/functions/vaults-rotate.js');
const call = async (body) => { const r = await handler({ httpMethod: 'POST', body: JSON.stringify(body) }); return { status: r.statusCode, ...JSON.parse(r.body) }; };

const leafVault = {
  id: 'v-leaf', user_id: OWNER, name: 'Family vault', network: 'bitcoin', address: 'bc1pold', address_type: 'tr_multileaf', status: 'compiled',
  founder_quorum: 2, heir_quorum: 2, recovery_quorum: null, recovery_after: 26_280, inheritance_after: 52_560, founder_keys: [], heir_keys: [],
  consent_keys: [K('f')], consent_quorum: 1, trust_doc: { purpose: 'x' }, predecessor_id: null, bloc_policy: null,
  key_labels: [{ pubkey: K('c'), label: 'Anna' }],
  leaves: [
    { id: 'everyday', label: 'Everyday signers', keys: [K('a'), K('b')], quorum: 2, unlock: { type: 'immediate' }, decay: null },
    { id: 'kids', label: 'The kids', keys: [K('c'), K('d')], quorum: 2, unlock: { type: 'after', blocks: ABS + 2 * YEAR }, decay: { step_blocks: 26_280, floor_quorum: 1 } },
    { id: 'stale', label: 'If untouched', keys: [K('a')], quorum: 1, unlock: { type: 'older', blocks: 30_000 }, decay: null },
  ],
};
const namedVault = {
  id: 'v-named', user_id: OWNER, name: 'Old shape', network: 'signet', address: 'tb1pold', address_type: 'tr_multileaf', status: 'compiled',
  founder_quorum: 2, heir_quorum: 1, recovery_quorum: 1, recovery_after: ABS + 100, inheritance_after: ABS + 200, founder_keys: [K('a'), K('b')], heir_keys: [K('c')],
  consent_keys: [], consent_quorum: null, trust_doc: null, predecessor_id: null, bloc_policy: null, leaves: null, planned_founder_count: 2, planned_heir_count: 1,
};
db.vaults.push(leafVault, namedVault, { ...leafVault, id: 'v-bloc', leaves: null, bloc_policy: { parent_pubkeys: [] } }, { ...leafVault, id: 'v-draft', status: 'draft' });
db.members.push({ vault_id: 'v-leaf', user_id: OWNER, role: 'owner', label: 'Dad', status: 'active' });

// 1. A path-builder vault becomes a leaves draft: keys carried, only the dated wait changed.
let r = await call({ vault_id: 'v-leaf', overrides: { name: 'Family vault 2031', leaf_offsets: { kids: 5 * YEAR } } });
assert.equal(r.status, 201, JSON.stringify(r));
const row = db.inserted[0];
assert.deepEqual(Object.keys(row).sort(), ['address', 'address_type', 'consent_keys', 'consent_quorum', 'descriptor', 'id', 'key_labels', 'leaves', 'miniscript_policy', 'name', 'network', 'predecessor_id', 'status', 'trust_doc', 'user_id'].sort());
assert.equal(row.status, 'draft'); assert.equal(row.address, null); assert.equal(row.descriptor, null);
assert.equal(row.predecessor_id, 'v-leaf'); assert.equal(row.network, 'bitcoin'); assert.equal(row.name, 'Family vault 2031'); assert.equal(row.user_id, OWNER);
assert.deepEqual(row.consent_keys, [K('f')]); assert.equal(row.consent_quorum, 1);
assert.deepEqual(row.key_labels, leafVault.key_labels); assert.deepEqual(row.trust_doc, { purpose: 'x' });
assert.deepEqual(row.leaves, [
  { ...leafVault.leaves[0] },
  { ...leafVault.leaves[1], unlock: { type: 'after', blocks: 5 * YEAR } },
  { ...leafVault.leaves[2] },
]);
assert.deepEqual(db.upserts.map(m => [m.vault_id, m.user_id, m.role]), [['new-1', OWNER, 'owner']]);
assert.deepEqual(db.events.map(e => [e.vault_id, e.event_type]), [['new-1', 'rotated_from_predecessor'], ['v-leaf', 'rotated_to_successor']]);
assert.deepEqual(db.events[0].metadata.leaf_offsets, { kids: 5 * YEAR });
pass('a path-builder vault rotates into a leaves draft with every key, quorum and rule carried, and both vaults get a ledger entry');

// 2. Refusals write nothing.
const before = () => [db.inserted.length, db.events.length];
const refused = async (body, status, re) => { const b = before(); const x = await call(body); assert.equal(x.status, status, JSON.stringify(x)); assert.match(x.error, re); assert.deepEqual(before(), b, 'a refusal must write nothing'); };
await refused({ vault_id: 'v-leaf', overrides: {} }, 400, /Missing: the new date/);
await refused({ vault_id: 'v-leaf', overrides: { leaf_offsets: { kids: 100 } } }, 400, /must be >= 26000 blocks/);
await refused({ vault_id: 'v-leaf', overrides: { leaf_offsets: { kids: 0 } } }, 400, /must keep a waiting period/);
await refused({ vault_id: 'v-leaf', overrides: { leaf_offsets: { kids: 5 * YEAR, everyday: YEAR } } }, 400, /not a dated path/);
await refused({ vault_id: 'v-bloc', overrides: {} }, 400, /Dynasty Bloc vault isn't supported/);
await refused({ vault_id: 'v-draft', overrides: {} }, 400, /Only compiled vaults/);
await refused({ vault_id: 'nope' }, 404, /not found/);
await refused({}, 400, /Missing: vault_id/);
caller = 'someone-else';
await refused({ vault_id: 'v-leaf', overrides: { leaf_offsets: { kids: 5 * YEAR } } }, 403, /Only the primary trustee/);
caller = null;
await refused({ vault_id: 'v-leaf' }, 401, /Not signed in/);
caller = OWNER;
pass('missing, short, zero or stray dates, a Bloc vault, a draft, a stranger and a signed-out caller are refused with nothing written');

// 3. The older vault shape still rotates exactly as before.
r = await call({ vault_id: 'v-named', overrides: { recovery_after: 30_000, inheritance_after: 60_000 } });
assert.equal(r.status, 201, JSON.stringify(r));
const named = db.inserted.at(-1);
assert.equal(named.leaves, undefined, 'a named-field successor has no leaf list');
assert.deepEqual([named.recovery_after, named.inheritance_after, named.founder_quorum, named.heir_quorum, named.recovery_quorum], [30_000, 60_000, 2, 1, 1]);
assert.deepEqual([named.founder_keys, named.heir_keys, named.status, named.predecessor_id, named.planned_founder_count, named.planned_heir_count], [[], [], 'draft', 'v-named', 2, 1]);
pass('a named-field vault still rotates into the same draft it always did');

console.log(`rotate-handler tests passed (${n} cases)`);
