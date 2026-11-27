// The four low findings of the 2026-11-27 outside review
// (docs/audits/2026-11-27-outside-review.md), each pinned here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const { callWasm } = await import(F('_ranged-wasm.js'));
const { buildRangedSpend } = await import(F('_ranged-spend.js'));
const { watchedAddresses, vaultCoins, LOOK_AHEAD, ELECTRUM_LOOK_AHEAD } = await import(F('_vault-coins.js'));
const { parsePsbt, toHex } = await import('../packages/bip341-psbt-signer/dist/index.js');
const { vaultBackupText } = await import('../apps/web/src/lib/descriptor-backup.ts');

const shape = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(s => s.name === 'untouched');
const compiled = callWasm('/compile-leaves', { network: 'signet', leaves: shape.policy.leaves }).body;
const V = { id: '66666666-6666-6666-6666-666666666666', name: 'Test', status: 'compiled', network: 'signet', address: compiled.address, leaf_scripts: compiled.leaf_scripts,
  leaves: shape.policy.leaves.map(l => ({ id: l.id, unlock: l.unlock })), descriptor_version: 2,
  descriptor_multipath: shape.multipath_descriptor, descriptor_receive: shape.receive_descriptor, descriptor_change: shape.change_descriptor };
const ranged = (b, i) => callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch: b, index: i }).body;
const TIP = 300_000;
const w0 = watchedAddresses(V, { 0: 5, 1: 3 }).find(w => w.branch === 0 && w.index === 0);
const coins = [{ txid: '1'.padStart(64, '0'), vout: 0, value: 80_000, status: { confirmed: true, block_height: TIP - 10 }, address: w0.address, branch: 0, index: 0 }];
const dest = ranged(0, 40).address;

// L1: two spends open at once must not share a change address.
const db = { change: [], proposals: [], next: 4 };
const supabase = {
  from: (t) => { const o = { select: () => o, eq: () => o, in: () => o, order: () => o, limit: () => o,
    then: (res) => res({ data: t === 'proposals' ? db.proposals : t === 'vault_addresses' ? db.change : [{ branch: 0, next_index: 5 }, { branch: 1, next_index: db.next }], error: null }),
    insert: async (row) => { if (t === 'vault_addresses') db.change.push({ idx: row.idx, address: row.address, script_pubkey: row.script_pubkey }); return { error: null }; } }; return o; },
  rpc: async () => ({ data: db.next++, error: null }),
};
const build = async () => (await buildRangedSpend({ supabase, vault: V, userId: 'u', body: { destination: dest, amount_sats: 30_000, path: 'everyday', fee_rate: 2 } },
  { coinsAt: async () => coins, fetchTipHeight: async () => TIP, getFeeRate: async () => 2, vaultUsed: async () => new Set() })).body;
const changeIdx = (hex) => { const p = parsePsbt(hex); const s = toHex(p.tx.outputs[1].scriptPubkey); return db.change.find(c => c.script_pubkey === s)?.idx; };
const first = await build();
assert.equal(changeIdx(first.psbt_hex), 4);
db.proposals = [{ psbt_hex: first.psbt_hex }];
const second = await build();
assert.notEqual(changeIdx(second.psbt_hex), 4, 'a second open spend reused the first one\'s change address');
db.proposals = [];
const third = await build();
assert.equal(changeIdx(third.psbt_hex), 4, 'once nothing open uses it, the unpaid change address is reused again');
pass('two spends open at once get different change addresses; an abandoned one is still reused once nothing open holds it');

// L2: the backup also carries the two single-branch descriptors, for Core 28 and older.
const text = vaultBackupText({ ...V, miniscript_policy: null, address_type: 'tr_multileaf', founder_quorum: 1, founder_keys: [], heir_quorum: 1, heir_keys: [],
  recovery_after: 0, inheritance_after: 0, leaves: shape.policy.leaves, descriptor: compiled.descriptor });
assert.ok(text.includes(V.descriptor_receive), 'receive descriptor missing');
assert.ok(text.includes(V.descriptor_change), 'change descriptor missing');
assert.match(text, /Bitcoin Core 28 or older/);
assert.match(text, /"internal":true/);
pass('the backup carries the receive and change descriptors and how to load them into Bitcoin Core 28 or older');

// L3: wider look-ahead where lookups are batched (Electrum); the website keeps the small one.
assert.ok(ELECTRUM_LOOK_AHEAD[0] >= 20 && ELECTRUM_LOOK_AHEAD[1] >= 20);
const wide = watchedAddresses(V, { 0: 5, 1: 3 }, undefined, { wide: true });
assert.equal(wide.filter(a => a.branch === 0).length, 5 + ELECTRUM_LOOK_AHEAD[0]);
let asked = null;
await vaultCoins('signet', wide, {}, { serverFor: async () => null, coinsAt: async (_n, w) => { asked = w; return []; }, fetchJson: async () => TIP });
assert.equal(asked.filter(a => a.branch === 0).length, 5 + LOOK_AHEAD[0]);
assert.equal(asked.filter(a => a.branch === 1).length, 3 + LOOK_AHEAD[1]);
pass(`Electrum watches ${ELECTRUM_LOOK_AHEAD[0]} past the last address handed out; the website fallback is trimmed back to ${LOOK_AHEAD[0]}/${LOOK_AHEAD[1]}`);

// L4: the spend builder that skips the path's own locks is not public.
const rs = readFileSync(new URL('../protocol/src/ranged.rs', import.meta.url), 'utf8');
assert.doesNotMatch(rs, /pub fn build_spend_psbt\(/);
pass('RangedVault::build_spend_psbt is no longer public; only build_path_spend_psbt is');

console.log(`review-lows tests passed (${n} cases)`);
