// Change on a fresh-address vault must go to a change address this vault
// actually handed out (blind review 2026-11-25, finding 3:
// docs/audits/2026-11-25-blind-review-new-code.md). A member could file a
// spend whose change sits at change/1000000: co-signers' checks passed it,
// the app watches only a few past the counter, and a restoring wallet
// (gap limit 20) never finds it. Operator's chip: recorded addresses only on
// the server; signing devices refuse change past the first 1,000 as a
// backstop.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const { callWasm } = await import(F('_ranged-wasm.js'));
const { buildRangedSpend } = await import(F('_ranged-spend.js'));
const { watchedAddresses } = await import(F('_vault-coins.js'));
const { changeProblem } = await import(F('_change-check.js'));
const { checkFreshSpendAddresses, CHANGE_INDEX_LIMIT } = await import('../apps/web/src/lib/fresh-addresses.ts');

const shape = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(s => s.name === 'untouched');
const compiled = callWasm('/compile-leaves', { network: 'signet', leaves: shape.policy.leaves }).body;
const V = {
  id: '66666666-6666-6666-6666-666666666666', name: 'Test', status: 'compiled', network: 'signet',
  address: compiled.address, leaf_scripts: compiled.leaf_scripts,
  leaves: shape.policy.leaves.map(l => ({ id: l.id, unlock: l.unlock })),
  descriptor_version: 2, descriptor_multipath: shape.multipath_descriptor, descriptor_receive: shape.receive_descriptor, descriptor_change: shape.change_descriptor,
};
const ranged = (b, i) => callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch: b, index: i }).body;
const watched = watchedAddresses(V, { 0: 5, 1: 3 });
const TIP = 300_000;
const w0 = watched.find(w => w.branch === 0 && w.index === 0);
const coins = [{ txid: '1'.padStart(64, '0'), vout: 0, value: 80_000, status: { confirmed: true, block_height: TIP - 10 }, address: w0.address, branch: 0, index: 0 }];
const dest = ranged(0, 40).address;

// A spend built with change at `idx`, and the change rows the vault has.
async function spendWithChange(idx) {
  const supabase = { from: () => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, then: (res) => res({ data: [], error: null }), insert: async () => ({ error: null }) }; return o; },
    rpc: async () => ({ data: idx, error: null }) };
  const r = await buildRangedSpend({ supabase, vault: V, userId: 'u', body: { destination: dest, amount_sats: 30_000, path: 'everyday', fee_rate: 2 } },
    { coinsAt: async () => coins, fetchTipHeight: async () => TIP, getFeeRate: async () => 2, vaultUsed: async () => new Set() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.psbt_hex;
}
const rows = (list) => ({ from: () => { const o = { select: () => o, eq: () => o, in: () => o, then: (res) => res({ data: list, error: null }) }; return o; } });
const row = (i) => ({ idx: i, script_pubkey: ranged(1, i).script_pubkey });

// Server: recorded change passes; far-off unrecorded change is refused.
const near = await spendWithChange(4);
assert.equal(await changeProblem(rows([row(4)]), V, near), null);
pass('change to a change address the vault handed out (recorded) is accepted');
const far = await spendWithChange(1_000_000);
const p = await changeProblem(rows([row(4)]), V, far);
assert.ok(p && /handed out/i.test(p), String(p));
pass('change to change address 1,000,000, never handed out, is refused by the server');
assert.ok(await changeProblem(rows([{ idx: 1_000_000, script_pubkey: '5120' + '00'.repeat(32) }]), V, far));
pass('a recorded row with the wrong script does not let it through');
assert.equal(await changeProblem(rows([]), { ...V, descriptor_version: 1 }, far), null);
pass('one-address vaults are not affected (their change is the vault address, checked elsewhere)');

// Signing devices: the backstop.
assert.equal(CHANGE_INDEX_LIMIT, 1000);
assert.deepEqual(await checkFreshSpendAddresses(V, near, async (b, i) => ranged(b, i)), { ok: true });
const dev = await checkFreshSpendAddresses(V, far, async (b, i) => ranged(b, i));
assert.equal(dev.ok, false); assert.match(dev.reason, /1,000/);
pass('a signing device refuses change past the first 1,000 change addresses');

console.log(`change-recorded tests passed (${n} cases)`);
