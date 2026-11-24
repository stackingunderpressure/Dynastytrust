/**
 * test-api-sealing.mjs -- zero-knowledge storage (Z1 slices 2-3): drives the
 * REAL lib/api.ts with a fake network and checks what leaves the device.
 * No request body may carry a plain name, label, memo or trust document;
 * every row that comes back is opened before a page sees it.
 * Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --experimental-test-module-mocks --import ./scripts/register-ts-resolver.mjs scripts/test-api-sealing.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { location: { origin: 'https://dynastytrust.family', hash: '' } };

const ME = 'u-dad';
mock.module(new URL('../apps/web/src/lib/supabase.ts', import.meta.url).href, { namedExports: {
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'tok', user: { id: ME } } } }) } },
} });

const ring = await import('../apps/web/src/lib/vault-keyring.ts');
const vk = await import('../apps/web/src/lib/vault-key.ts');
const KEYS = new Map();
// The owner's device makes a vault's key the first time it is needed.
mock.module(new URL('../apps/web/src/lib/use-vault-key.ts', import.meta.url).href, { namedExports: {
  ensureVaultKey: async (vaultId) => {
    if (!KEYS.has(vaultId)) KEYS.set(vaultId, vk.newVaultKey());
    ring.setVaultKeys(vaultId, new Map([[1, KEYS.get(vaultId)]]), 1);
    return { keys: new Map([[1, KEYS.get(vaultId)]]), version: 1, status: 'ready' };
  },
} });

// Fake server: echoes what it was sent back as the stored row.
const sent = [];
let nextVaultId = 1;
const rows = { vaults: new Map() };
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  sent.push({ url, method: init.method ?? 'GET', body });
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ...o }), json: async () => ({ ok: true, ...o }) });
  const path = url.replace(/^\/api/, '');
  if (path === '/vault-keys' && !init.method) return ok({ vaults: [] });
  if (path === '/vaults' && init.method === 'POST') {
    const v = { id: `v${nextVaultId++}`, user_id: ME, name: body.name, trust_doc: {}, key_labels: [] };
    rows.vaults.set(v.id, v); return ok({ vault: v });
  }
  if (path.startsWith('/vaults?id=') && init.method === 'PATCH') {
    const v = rows.vaults.get(path.split('=')[1]);
    if (body.name !== undefined) v.name = body.name;
    if (body.trust_doc !== undefined) v.trust_doc = body.trust_doc;
    if (body.key_label) v.key_labels = [body.key_label];
    return ok({ vault: v });
  }
  if (path.startsWith('/vaults')) return ok({ vaults: [...rows.vaults.values()] });
  const echo = (k, extra = {}) => ok({ [k]: { id: 'x1', ...extra, ...body } });
  if (path === '/stipends') return echo('stipend');
  if (path === '/vault-requests') return echo('request');
  if (path === '/distribution-wallets') return echo('wallet');
  if (path === '/sent-secrets') return echo('secret');
  if (path === '/vault-attestations') return echo('attestation');
  if (path === '/invites') return echo('invite');
  if (path === '/proposals') return echo('proposal');
  if (path === '/signer-sessions') return ok({ session: { id: 's1' } });
  if (path.startsWith('/members?id=')) return ok({ member: { id: 'm1', vault_id: 'v1', ...body } });
  if (path === '/invites-claim') return ok({ member_id: 'm2', vault_id: 'v9' });
  throw new Error('unexpected request ' + url);
};

const { api } = await import('../apps/web/src/lib/api.ts');
const PLAIN = ['Winchester Family Trust', 'College for the kids', 'Allowance', 'Sam', 'Spring term', 'State U', 'Sam at 25', 'Circle phrase', 'Anna', 'Roof repair', 'Passed March 3', "Dad's Jade", 'Phone key', 'Uncle Bob'];
const leaks = () => sent.filter(r => r.body && PLAIN.some(p => JSON.stringify(r.body).includes(p)));

// 1. A new vault: created under the placeholder, renamed sealed.
const { vault } = await api.vaults.createDraft({ name: 'Winchester Family Trust', network: 'signet', planned_founder_count: 2, planned_heir_count: 1 });
assert.equal(vault.name, 'Winchester Family Trust', 'the page sees the real name');
assert.equal(sent.find(r => r.method === 'POST' && r.url === '/api/vaults').body.name, 'Vault');
assert.ok(rows.vaults.get(vault.id).name.startsWith('zk1:'), 'the server holds the name sealed');
const listed = await api.vaults.list();
assert.equal(listed.vaults[0].name, 'Winchester Family Trust', 'and lists open it');
pass('a new vault is created under a placeholder and its real name is stored sealed; lists open it');

// 2. Every write that carries words.
const V = vault.id;
await api.vaults.updateTrustDoc(V, { purpose: 'College for the kids' });
assert.ok(rows.vaults.get(V).trust_doc.zk?.startsWith('zk1:'));
await api.vaults.setKeyLabel(V, '02' + 'ab'.repeat(32), "Dad's Jade");
await api.stipends.create({ vault_id: V, name: 'Allowance', recipient_name: 'Sam', amount_sats: 1000, interval_kind: 'monthly' });
const rq = await api.vaultRequests.create({ vault_id: V, amount_sats: 5, recipient_name: 'State U', reason: 'Spring term' });
assert.equal(rq.request.reason, 'Spring term', 'the response row is opened for the page');
await api.distributionWallets.create({ vault_id: V, name: 'Sam at 25', beneficiary_name: 'Sam', beneficiary_xpub: 'x', beneficiary_pubkey: 'p', trustee_keys: [], trustee_quorum: 1, network: 'signet', tranches: [] });
await api.sentSecrets.create({ vault_id: V, kind: 'circle', label: 'Circle phrase', recipients: [{ label: 'Anna', persona: 'heir' }], blob: { ciphertextB64: 'c', saltB64: 's', nonceB64: 'n' } });
await api.attestations.create({ vault_id: V, attestation_type: 'death_declaration', target_hash: 'h', target_data: { notes: 'Passed March 3' }, signature: 'sig', pubkey: 'pk' });
const inv = await api.invites.create({ vault_id: V, invited_role: 'heir', invited_label: 'Uncle Bob' });
assert.equal(inv.invite.invited_label, 'Uncle Bob');
assert.ok(!('invited_email' in sent.at(-1).body), 'no email is sent with an invite');
await api.proposals.create({ vault_id: V, destination: 'tb1q', amount_sats: 10, memo: 'Roof repair' });
await api.signerSessions.submit({ proposal_id: 'p1', psbt_partial_hex: '00', label: 'Phone key' }, V);
await api.members.update('m1', { label: 'Anna' }, V);
await api.vaults.rename(V, 'Winchester Family Trust');
assert.deepEqual(leaks().map(r => r.url), [], 'no request body carries a plain name, label, memo or trust document');
pass('names, labels, the trust document, memos, notes and signer labels leave the device sealed only');

// 3. A sealed field without a vault to seal it is refused, never sent plain.
const before = sent.length;
await assert.rejects(() => api.stipends.update('s1', { name: 'Allowance' }), /needs its vault/);
await assert.rejects(() => api.signerSessions.submit({ proposal_id: 'p1', psbt_partial_hex: '00', label: 'Phone key' }), /needs its vault/);
assert.equal(sent.length, before, 'nothing was sent');
pass('a change that cannot be sealed is refused before anything is sent');

// 4. Joining: my own label waits on this device for the key.
await api.invites.claim({ token: 't', label: 'Anna', key_label: 'Phone key' });
assert.ok(!JSON.stringify(sent.at(-1).body).includes('Anna'));
assert.deepEqual(JSON.parse(store.get('dt-zk-pending:v9')), { label: 'Anna', key_label: 'Phone key' });
pass("a new member's own label is not sent before they hold the key; it waits on their device");

console.log(`api sealing: ${n} checks passed`);
