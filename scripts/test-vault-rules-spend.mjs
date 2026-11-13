/**
 * test-vault-rules-spend.mjs -- the rules for building a spend, as
 * psbt-binary.js applies them (download slice: one copy shared by the
 * website's server and the downloaded app, docs/download-and-run-build-note.md).
 *
 * Runs the REAL psbt-binary.js handler over a fixed set of cases with the
 * database, account check, activity log, mempool.space and the compiler
 * stood in, and records: the status and body it answers, the exact request
 * it sends the compiler, and every mempool.space URL it asked for.
 *
 *   RECORD=1  write scripts/fixtures/vault-rules-spend.json (ONCE, against
 *             the code BEFORE the rules moved into packages/)
 *   (default) replay and require identical behaviour.
 *
 * Run:  node --experimental-test-module-mocks scripts/test-vault-rules-spend.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
process.env.COMPILER_URL = 'https://compiler.invalid';
process.env.COMPILER_SECRET = 'test';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const FIXTURE = new URL('./fixtures/vault-rules-spend.json', import.meta.url);

const { HDKey } = await import('@scure/bip32');
const hex = (b) => Buffer.from(b).toString('hex');
const acct = (n) => HDKey.fromMasterSeed(new Uint8Array(32).fill(n), { private: 0x04358394, public: 0x043587cf }).derive("m/48'/1'/0'/2'");
const XPUB = (n) => acct(n).publicExtendedKey;
const PK = (n) => hex(acct(n).deriveChild(0).deriveChild(0).publicKey);

const STANDARD = {
  id: 'v1', name: 'Family', address: 'tb1p-vault', network: 'signet', descriptor: 'tr(...)', address_type: 'tr_multileaf',
  recovery_after: 280_000, inheritance_after: 300_000, recovery_quorum: null, founder_quorum: 2, heir_quorum: 1,
  founder_keys: [XPUB(1), XPUB(2), PK(3)], heir_keys: [XPUB(4)], consent_keys: [], consent_quorum: null,
  backup_keys: [], backup_quorum: null, second_heir_keys: [], second_heir_quorum: null, second_inheritance_after: null,
  key_origins: [{ pubkey: PK(1), fingerprint: '00000001', derivation_path: "m/48'/1'/0'/2'/0/0" }], leaves: null,
};
const LEAVES = {
  ...STANDARD, founder_keys: [], heir_keys: [], key_origins: [],
  leaves: [
    { id: 'everyday', label: 'Everyday', keys: [XPUB(1), XPUB(2)], quorum: 2, unlock: { type: 'immediate' } },
    { id: 'heirs', label: 'Heirs', keys: [XPUB(4), XPUB(5), XPUB(6)], quorum: 3, unlock: { type: 'after', blocks: 300_000 }, decay: { step_blocks: 26_000, floor_quorum: 1 } },
    { id: 'idle', label: 'Idle', keys: [PK(7)], quorum: 1, unlock: { type: 'older', blocks: 52_000 }, required_keys: [PK(8)] },
  ],
  consent_keys: [XPUB(9)], consent_quorum: 1,
};
const BACKUP = { ...STANDARD, recovery_after: 0, backup_keys: [XPUB(5)], backup_quorum: 1, second_heir_keys: [XPUB(6)], second_heir_quorum: 1, second_inheritance_after: 320_000 };
const coin = (i, value, confirmed = true) => ({ txid: String(i).repeat(64).slice(0, 64), vout: i % 3, value, status: { confirmed } });
const COINS = [coin(1, 50_000), coin(2, 120_000), coin(3, 7_000), coin(4, 30_000, false)];
const D = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

const CASES = [
  { label: 'standard, founders, fixed amount', vault: STANDARD, body: { amount_sats: 60_000 } },
  { label: 'standard, explicit fee rate', vault: STANDARD, body: { amount_sats: 60_000, fee_rate: 7 } },
  { label: 'standard, recovery path', vault: STANDARD, body: { amount_sats: 10_000, path: 'recovery' } },
  { label: 'standard, inheritance path', vault: STANDARD, body: { amount_sats: 10_000, path: 'inheritance' } },
  { label: 'standard, sweep', vault: STANDARD, body: { sweep: true } },
  { label: 'standard, coin control', vault: STANDARD, body: { amount_sats: 5_000, selected_utxos: [{ txid: coin(3, 0).txid, vout: 0 }] } },
  { label: 'standard, coin control names an unconfirmed coin', vault: STANDARD, body: { amount_sats: 5_000, selected_utxos: [{ txid: coin(4, 0).txid, vout: 1 }] } },
  { label: 'standard, sweep with coin control', vault: STANDARD, body: { sweep: true, selected_utxos: [{ txid: coin(1, 0).txid, vout: 1 }, { txid: coin(3, 0).txid, vout: 0 }] } },
  { label: 'standard, change just under the floor', vault: STANDARD, body: { amount_sats: 120_000 - 1000, fee_rate: 2 } },
  { label: 'standard, more than the balance', vault: STANDARD, body: { amount_sats: 500_000 } },
  { label: 'standard, below dust', vault: STANDARD, body: { amount_sats: 100 } },
  { label: 'standard, fee rate out of range', vault: STANDARD, body: { amount_sats: 10_000, fee_rate: 5000 } },
  { label: 'backup + second inheritance vault, backup path', vault: BACKUP, body: { amount_sats: 10_000, path: 'backup' } },
  { label: 'backup + second inheritance vault, second inheritance', vault: BACKUP, body: { amount_sats: 10_000, path: 'second_inheritance' } },
  { label: 'path-builder, immediate leaf', vault: LEAVES, body: { amount_sats: 20_000, path: 'everyday' } },
  { label: 'path-builder, a decay rung', vault: LEAVES, body: { amount_sats: 20_000, path: 'heirs_2' } },
  { label: 'path-builder, leaf with a must-sign key', vault: LEAVES, body: { amount_sats: 20_000, path: 'idle' } },
  { label: 'no confirmed coins', vault: STANDARD, body: { amount_sats: 10_000 }, coins: [coin(4, 30_000, false)] },
  { label: 'a coin whose transaction cannot be read', vault: STANDARD, body: { amount_sats: 10_000 }, brokenTx: true },
  { label: 'fee lookup fails (falls back)', vault: STANDARD, body: { amount_sats: 10_000 }, feesDown: true },
  { label: 'key origins from members (older vault)', vault: { ...STANDARD, key_origins: null }, body: { amount_sats: 10_000 } },
];

let current, sentToCompiler, asked;
const table = (name) => {
  const o = {
    select: () => o, eq: () => o,
    maybeSingle: async () => ({ data: name === 'vaults' ? current.vault : { id: 'm1' }, error: null }),
    then: (r) => r({ data: name === 'vault_members' ? [{ pubkey: PK(2), fingerprint: '00000002', derivation_path: "m/48'/1'/0'/2'" }] : [], error: null }),
  };
  return o;
};
mock.module(F('_supabase.js'), { namedExports: { getSupabaseAdmin: () => ({ from: table }) } });
mock.module(F('_auth.js'), { namedExports: { requireUser: async () => ({ userId: 'u1' }), json: (statusCode, body) => ({ statusCode, body }) } });
mock.module(F('_ledger.js'), { namedExports: { recordEvent: async (_s, ev) => { current.event = ev; } } });

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (u.startsWith('https://compiler.invalid')) {
    sentToCompiler = JSON.parse(init.body);
    return ok({ ok: true, psbt_hex: '70736274ff' + sentToCompiler.inputs.length, psbt_b64: 'cHNidP8=' });
  }
  asked.push(u.replace(/^https:\/\/mempool\.space/, ''));
  if (u.endsWith('/utxo')) return ok(current.coins || COINS);
  if (u.includes('/v1/fees/recommended')) return current.feesDown ? new Response('down', { status: 503 }) : ok({ halfHourFee: 3, economyFee: 1 });
  const m = u.match(/\/tx\/([0-9a-f]{64})$/);
  if (m) return current.brokenTx ? new Response('nope', { status: 404 }) : ok({ txid: m[1], vout: [0, 1, 2].map(i => ({ scriptpubkey: '5120' + 'ab'.repeat(32), value: 1 })) });
  throw new Error('unexpected fetch ' + u);
};
const { handler } = await import(F('psbt-binary.js'));

const results = [];
for (const c of CASES) {
  current = { vault: c.vault, coins: c.coins, brokenTx: c.brokenTx, feesDown: c.feesDown };
  sentToCompiler = null; asked = [];
  const r = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ vault_id: 'v1', destination: D, ...c.body }) });
  results.push({ label: c.label, status: r.statusCode, body: r.body, sentToCompiler, asked, event: current.event ?? null });
}

if (process.env.RECORD) {
  writeFileSync(FIXTURE, JSON.stringify(results, null, 1) + '\n');
  console.log(`recorded ${results.length} cases`);
} else {
  const before = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(results.length, before.length);
  for (let i = 0; i < results.length; i++) assert.deepEqual(results[i], before[i], `case "${before[i].label}" behaves differently`);
  const ok = results.filter(r => r.status === 200 && r.body.psbt_hex).length;
  console.log(`  [ok] ${results.length} cases identical to the recording (${ok} built a spend, ${results.length - ok} refused or nothing to spend)`);
  console.log('vault-rules-spend tests passed (1 cases)');
}
