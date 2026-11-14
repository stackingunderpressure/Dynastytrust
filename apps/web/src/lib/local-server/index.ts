// The download build's stand-in for our server (docs/download-and-run-
// build-note.md): answers the calls one person needs to build, hold and
// spend their own vault, in the SAME request and answer shapes as the
// Netlify functions, so no page changes. It runs the SAME vault rules as
// the server (packages/vault-rules), the SAME compiler (compiler-wasm, on
// this device), and Bitcoin Core on this computer instead of mempool.space.
//
// What it deliberately does not do: anything that needs another person or
// an account (invites, members, messages, sign-in) -- those calls answer
// "not in the download" or an empty list, so the pages stay calm.

import {
  standardKeys, standardCompilePayload, standardCompiledRow,
  spendKeys, inputVbytesFor, selectCoins, spendCompilerRequest, spendSummary,
  checkNumberBounds, MIN_FEE_RATE_SAT_VB, MAX_FEE_RATE_SAT_VB, TIP_FLOOR, pubkeyFromXpub,
  leavesKeyOrigins, leavesCheck, leavesNeedTip, leavesWire, leavesCompilePayload, leavesCompiledProblem, leavesCompiledRow,
} from '../../../../../packages/vault-rules/src/index.js';
import { compileOnDevice } from '../browser-compiler';
import * as core from './core';
import * as store from './store';

export interface LocalAnswer { status: number; payload: Record<string, unknown> }
const ok = (payload: Record<string, unknown>): LocalAnswer => ({ status: 200, payload: { ok: true, ...payload } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LocalAnswer => ({ status, payload: { ok: false, error, ...extra } });

const VALID_NETWORKS = ['testnet', 'signet', 'bitcoin'];
const VALID_ADDRESS_TYPES = ['tr', 'tr_multileaf', 'wsh'];
const NOT_HERE = 'This is not part of the downloaded DynastyTrust yet: it needs other people or our server.';

type Vault = store.Row & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function vaultView(v: store.Row): store.Row {
  return { ...v, my_role: 'owner' };
}

async function compiler(endpoint: Parameters<typeof compileOnDevice>[0], request: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; answer: LocalAnswer }> {
  const out = await compileOnDevice(endpoint, request);
  let data: Record<string, unknown>;
  try { data = JSON.parse(out.body); } catch { return { ok: false, answer: fail(502, 'The compiler gave an unreadable answer.') }; }
  if (out.status !== 200 || data.ok === false) return { ok: false, answer: fail(400, String(data.error ?? 'Compiler returned an error')) };
  return { ok: true, data };
}

/** The tip from YOUR node. One source, but a fully validating one. */
async function verifiedTip(network: string): Promise<number> {
  const conn = core.coreConnFor(network);
  const tip = await core.tipHeight(conn);
  const floor = conn.network === 'regtest' ? 0 : (TIP_FLOOR as Record<string, number>)[network] ?? 0;
  if (!Number.isSafeInteger(tip) || tip < floor) throw new Error(`implausible ${network} tip height ${tip} from Bitcoin Core (the real chain is past ${floor})`);
  return tip;
}

// --- /vaults -------------------------------------------------------------
async function vaults(method: string, q: URLSearchParams, body: Record<string, unknown>): Promise<LocalAnswer> {
  if (method === 'GET') {
    const showArchived = q.get('archived') === 'true';
    const rows = store.list('vaults')
      .filter(v => showArchived || !v.archived)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return ok({ vaults: rows.map(vaultView) });
  }
  if (method === 'POST') {
    const network = String(body.network ?? 'testnet');
    const address_type = String(body.address_type ?? 'tr_multileaf');
    if (!VALID_NETWORKS.includes(network)) return fail(400, `network must be one of ${VALID_NETWORKS.join(', ')}`);
    if (!VALID_ADDRESS_TYPES.includes(address_type)) return fail(400, `address_type must be one of ${VALID_ADDRESS_TYPES.join(', ')}`);
    if (body.mode === 'leaves-draft') {
      // The path builder's draft (vaults.js "leaves-draft"): the path list
      // as configured so far, partial or empty; compile-leaves checks it.
      const row = store.insert('vaults', {
        user_id: store.LOCAL_USER, name: body.name || 'Vault', network, address_type,
        address: null, descriptor: null, miniscript_policy: null,
        leaves: Array.isArray(body.leaves) ? body.leaves : [],
        consent_keys: body.consent_keys ?? [], consent_quorum: body.consent_quorum ?? null,
        status: 'draft', archived: false, trust_doc: null, key_origins: [],
      });
      store.recordEvent(row.id, 'draft_created', { address_type, network, shape: 'leaves' });
      return ok({ vault: vaultView(row) });
    }
    if (body.mode !== 'draft') return fail(400, 'This vault shape is not in the downloaded DynastyTrust yet.');
    const planned_founder_count = Number(body.planned_founder_count);
    const planned_heir_count = Number(body.planned_heir_count ?? 0);
    if (!planned_founder_count || planned_founder_count < 1) return fail(400, 'planned_founder_count must be >= 1');
    if (planned_heir_count < 0) return fail(400, 'planned_heir_count cannot be negative');
    const row = store.insert('vaults', {
      user_id: store.LOCAL_USER, name: body.name || 'Vault', network, address_type,
      address: null, descriptor: null, miniscript_policy: null,
      founder_quorum: body.founder_quorum ?? planned_founder_count,
      heir_quorum: body.heir_quorum ?? Math.max(1, planned_heir_count),
      recovery_quorum: body.recovery_quorum ?? null,
      recovery_after: body.recovery_after ?? 26000,
      inheritance_after: body.inheritance_after ?? 52560,
      consent_keys: [], consent_quorum: body.consent_quorum ?? null,
      backup_keys: [], backup_quorum: body.backup_quorum ?? null,
      second_heir_keys: [], second_heir_quorum: body.second_heir_quorum ?? null,
      second_inheritance_after: body.second_inheritance_after ?? null,
      founder_keys: [], heir_keys: [], status: 'draft', archived: false,
      planned_founder_count, planned_heir_count, trust_doc: null, key_origins: [],
    });
    store.recordEvent(row.id, 'draft_created', { address_type, network, planned_founder_count, planned_heir_count });
    return ok({ vault: vaultView(row) });
  }
  const id = q.get('id') ?? '';
  const v = store.get('vaults', id) as Vault | null;
  if (!v) return fail(404, 'Vault not found');
  if (method === 'DELETE') {
    store.remove('vaults', id);
    return ok({});
  }
  if (method === 'PATCH') {
    const patch: Record<string, unknown> = {};
    if ('network' in body) {
      if (v.status !== 'draft') return fail(400, 'The network can only change while the vault is a draft.');
      if (!VALID_NETWORKS.includes(String(body.network))) return fail(400, `network must be one of ${VALID_NETWORKS.join(', ')}`);
      patch.network = body.network;
    }
    if ('name' in body) patch.name = String(body.name).slice(0, 120);
    if ('trust_doc' in body) patch.trust_doc = body.trust_doc;
    if ('archived' in body) patch.archived = Boolean(body.archived);
    if ('key_origins' in body && Array.isArray(body.key_origins)) patch.key_origins = body.key_origins;
    // The path list and consent describe the policy compile-leaves turns
    // into an address: only while it is still a draft (vaults.js).
    if ('leaves' in body || 'consent_keys' in body || 'consent_quorum' in body) {
      if (v.status !== 'draft') return fail(400, "Leaves can only be changed while the vault is still a draft, before it's compiled.");
      if ('leaves' in body) patch.leaves = body.leaves;
      if ('consent_keys' in body) patch.consent_keys = body.consent_keys;
      if ('consent_quorum' in body) patch.consent_quorum = body.consent_quorum;
    }
    if (Object.keys(patch).length === 0) return fail(400, NOT_HERE);
    return ok({ vault: vaultView(store.update('vaults', id, patch)!) });
  }
  return fail(405, 'Method not allowed');
}

// --- /vaults-compile (the standard vault) -----------------------------------
async function vaultsCompile(body: Record<string, unknown>): Promise<LocalAnswer> {
  const v = store.get('vaults', String(body.vault_id ?? '')) as Vault | null;
  if (!v) return fail(404, 'Vault not found');
  if (v.status !== 'draft') return fail(400, 'Vault is not in draft status');
  if (!(body.direct_keys && typeof body.direct_keys === 'object')) return fail(400, 'Every key must be on this computer or a hardware wallet in the download.');
  const keys = standardKeys(v, body.direct_keys, undefined);
  if (keys.ok === false) return fail(keys.status, keys.error);
  let tip = 0;
  if (keys.needsTip) {
    try { tip = await verifiedTip(String(v.network)); } catch (e) { return fail(502, `Could not get the chain tip from Bitcoin Core: ${e instanceof Error ? e.message : e}`); }
  }
  const c = await compiler('/compile', standardCompilePayload(v, keys, tip, pubkeyFromXpub));
  if (!c.ok) return c.answer;
  const saved = store.update('vaults', v.id, standardCompiledRow(v, keys, c.data, tip))!;
  // Start watching it in Core now, from this moment on (a brand-new
  // address has no history to scan).
  try { await core.ensureWatched(core.coreConnFor(String(v.network)), String(saved.descriptor), 'now'); } catch { /* the balance screen will say what is wrong */ }
  store.recordEvent(v.id, 'draft_compiled', { address_type: v.address_type, network: v.network, founder_count: keys.founders.length, heir_count: keys.heirs.length });
  return ok({ vault: vaultView(saved) });
}

// --- /compile-leaves (the path builder) ------------------------------------
async function compileLeaves(body: Record<string, unknown>): Promise<LocalAnswer> {
  const v = store.get('vaults', String(body.vault_id ?? '')) as Vault | null;
  if (!body.vault_id) return fail(400, 'Missing: vault_id');
  if (!v) return fail(404, 'Vault not found');
  if (v.status !== 'draft') return fail(400, 'Vault is not in draft status');
  const keyOrigins = leavesKeyOrigins(body.key_origins);
  const checked = leavesCheck(v);
  if (checked.ok === false) return fail(checked.status, checked.error);
  let tip = 0;
  if (leavesNeedTip(checked.leaves)) {
    try { tip = await verifiedTip(String(v.network)); } catch (e) { return fail(502, `Could not get the chain tip from Bitcoin Core: ${e instanceof Error ? e.message : e}`); }
  }
  const wire = leavesWire(checked.leaves, tip);
  const c = await compiler('/compile-leaves', leavesCompilePayload(v, wire));
  if (!c.ok) return c.answer;
  const problem = leavesCompiledProblem(wire, c.data);
  if (problem) return fail(problem.status, problem.error);
  const saved = store.update('vaults', v.id, leavesCompiledRow(c.data, wire, keyOrigins))!;
  try { await core.ensureWatched(core.coreConnFor(String(v.network)), String(saved.descriptor), 'now'); } catch { /* the balance screen will say what is wrong */ }
  store.recordEvent(v.id, 'draft_compiled', { address_type: 'tr_multileaf', network: v.network, shape: 'leaves' });
  return ok({ vault: vaultView(saved) });
}

// --- balances and coins ------------------------------------------------------
function vaultByAddress(address: string): Vault | null {
  return (store.list('vaults').find(v => v.address === address) as Vault | undefined) ?? null;
}
async function balance(q: URLSearchParams): Promise<LocalAnswer> {
  const address = q.get('address') ?? '';
  const v = vaultByAddress(address);
  if (!v?.descriptor) return fail(404, 'That address is not one of the vaults on this computer.');
  let coins: core.CoreCoin[];
  try { coins = await core.vaultCoins(core.coreConnFor(String(v.network)), String(v.descriptor)); } catch (e) { return fail(502, `Bitcoin Core: ${e instanceof Error ? e.message : e}`); }
  const confirmed = coins.filter(c => c.confirmed);
  const confirmed_sats = confirmed.reduce((n, c) => n + c.value, 0);
  const unconfirmed_sats = coins.filter(c => !c.confirmed).reduce((n, c) => n + c.value, 0);
  return ok({
    address, network: v.network, confirmed_sats, unconfirmed_sats, total_sats: confirmed_sats + unconfirmed_sats,
    btc_amount: (confirmed_sats + unconfirmed_sats) / 1e8, btc_price_usd: null, usd_value: null,
    utxo_count: coins.length, confirmed_utxos: confirmed.length, mempool_url: '', tx_count: coins.length,
  });
}
async function utxos(q: URLSearchParams): Promise<LocalAnswer> {
  const v = store.get('vaults', q.get('vault_id') ?? '') as Vault | null;
  if (!v?.descriptor) return fail(404, 'Vault not found');
  const conn = core.coreConnFor(String(v.network));
  try {
    const [coins, tip] = await Promise.all([core.vaultCoins(conn, String(v.descriptor)), core.tipHeight(conn)]);
    return ok({
      vault_address: v.address, network: v.network, tip,
      utxos: coins.map(c => ({
        txid: c.txid, vout: c.vout, value_sats: c.value, confirmed: c.confirmed,
        block_height: c.confirmed ? tip - c.confirmations + 1 : null, block_time: null, confirmations: c.confirmations,
      })),
    });
  } catch (e) { return fail(502, `Bitcoin Core: ${e instanceof Error ? e.message : e}`); }
}

// --- building and finishing a spend ------------------------------------------
async function psbtBinary(body: Record<string, unknown>): Promise<LocalAnswer> {
  const { vault_id, destination, amount_sats, fee_rate, path = 'founders_now', selected_utxos, sweep } = body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!vault_id) return fail(400, 'Missing: vault_id');
  if (!destination) return fail(400, 'Missing: destination');
  if (!sweep) {
    const e = checkNumberBounds(amount_sats, { field: 'amount_sats', min: 546, max: Number.MAX_SAFE_INTEGER, integer: true });
    if (e) return fail(400, e);
  }
  if (fee_rate != null) {
    const e = checkNumberBounds(fee_rate, { field: 'fee_rate', min: MIN_FEE_RATE_SAT_VB, max: MAX_FEE_RATE_SAT_VB });
    if (e) return fail(400, e);
  }
  const v = store.get('vaults', String(vault_id)) as Vault | null;
  if (!v?.descriptor) return fail(404, 'Vault not found');
  let keys;
  try { keys = spendKeys(v, pubkeyFromXpub); } catch (e) { return fail(500, 'Could not derive /0/0 pubkey from vault xpubs: ' + (e instanceof Error ? e.message : e)); }
  const network = String(v.network || 'testnet');
  const conn = core.coreConnFor(network);
  let coins: core.CoreCoin[];
  try { coins = await core.vaultCoins(conn, String(v.descriptor)); } catch (e) { return fail(502, 'Could not read the vault\'s coins from Bitcoin Core: ' + (e instanceof Error ? e.message : e)); }
  const confirmed = coins.filter(c => c.confirmed);
  if (!confirmed.length) return ok({ status: 'no_utxos', message: 'No confirmed UTXOs. Fund the vault and wait for confirmation.', address: v.address });
  // Never a silent made-up rate: Core's estimate, or the one you chose.
  let rate = fee_rate as number | undefined;
  if (rate == null) {
    try { rate = (await core.feeRate(conn)) ?? undefined; } catch { rate = undefined; }
    if (rate == null) return fail(400, 'Bitcoin Core has no fee estimate yet (it needs to see some blocks first). Choose a fee rate for this spend.');
  }
  const picked = selectCoins({ confirmed, amount_sats, sweep, selected_utxos, rate, inputVbytes: inputVbytesFor(v, String(path)) });
  if (picked.ok === false) return { status: picked.status, payload: picked.body };
  // Core already told us each coin's script: no second lookup.
  const inputs = picked.selected.map(u => ({ txid: u.txid, vout: u.vout, value_sats: u.value, script_pubkey: u.scriptPubKey }));
  const c = await compiler('/psbt-binary', spendCompilerRequest(v, keys, {
    inputs, destination: String(destination), amountSatsFinal: picked.amountSatsFinal, finalFee: picked.finalFee, network, path: String(path), keyOrigins: v.key_origins || [],
  }));
  if (!c.ok) return c.answer;
  store.recordEvent(v.id, 'psbt_generated', { destination, amount_sats: picked.amountSatsFinal, fee_sats: picked.finalFee, fee_rate: rate, input_count: picked.selected.length, binary: true, path, sweep: !!sweep });
  return ok({ psbt_hex: c.data.psbt_hex, psbt_b64: c.data.psbt_b64, summary: spendSummary(v, picked, { destination, rate, network, path }) });
}

async function psbtFinalize(body: Record<string, unknown>): Promise<LocalAnswer> {
  const psbt = String(body.psbt_hex ?? body.psbt ?? '');
  if (!psbt.startsWith('70736274ff')) return fail(400, 'Not a PSBT (missing magic bytes)');
  const c = await compiler('/psbt-finalize', { psbt_hex: psbt });
  if (!c.ok) return c.answer;
  return ok(c.data);
}

// --- the spend's own record ----------------------------------------------------
async function proposals(method: string, q: URLSearchParams, body: Record<string, unknown>): Promise<LocalAnswer> {
  if (method === 'GET') {
    const vid = q.get('vault_id');
    const rows = store.list('proposals').filter(p => !vid || p.vault_id === vid)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return ok({ proposals: rows.map(p => ({ ...p, signer_sessions: [] })) });
  }
  if (method === 'POST') {
    if (!store.get('vaults', String(body.vault_id ?? ''))) return fail(404, 'Vault not found');
    const amount = checkNumberBounds(body.amount_sats, { field: 'amount_sats', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });
    if (amount) return fail(400, amount);
    const row = store.insert('proposals', {
      vault_id: body.vault_id, user_id: store.LOCAL_USER, path: body.path ?? 'founders_now', destination: body.destination,
      amount_sats: body.amount_sats, fee_sats: body.fee_sats ?? null, memo: body.memo ?? null,
      psbt_hex: body.psbt_hex ?? null, psbt_b64: body.psbt_b64 ?? null, txid: null,
      status: body.psbt_hex ? 'pending' : 'draft', governance_audit: null,
    });
    return ok({ proposal: row });
  }
  if (method === 'PATCH') {
    const p = store.get('proposals', q.get('id') ?? '');
    if (!p) return fail(404, 'Proposal not found');
    if (body.status !== undefined && body.status !== 'broadcast' && body.status !== 'cancelled') return fail(400, 'status may only be set to broadcast or cancelled');
    if ((p.status === 'broadcast' || p.status === 'cancelled') && Object.keys(body).some(k => k !== 'memo')) return fail(400, 'This spend is finished; only its memo can change.');
    if (body.txid !== undefined && body.status !== 'broadcast') return fail(400, 'A txid is only accepted with status broadcast');
    if (body.txid !== undefined && !/^[0-9a-f]{64}$/.test(String(body.txid))) return fail(400, 'txid must be 64 hex characters');
    const saved = store.update('proposals', p.id, body)!;
    if (body.status) store.recordEvent(String(p.vault_id), String(body.status), { proposal_id: p.id, txid: body.txid ?? null });
    return ok({ proposal: saved });
  }
  return fail(405, 'Method not allowed');
}

/**
 * Answer one server call locally. `path` is what api.ts would have put
 * after /api (with its query string); `init` its method and body.
 */
export async function handleLocal(path: string, init?: RequestInit): Promise<LocalAnswer> {
  const url = new URL(path, 'http://local');
  const method = (init?.method ?? 'GET').toUpperCase();
  let body: Record<string, unknown> = {};
  if (init?.body) {
    try { body = JSON.parse(String(init.body)); } catch { return fail(400, 'Invalid JSON body'); }
  }
  const q = url.searchParams;
  switch (url.pathname) {
    case '/vaults': return vaults(method, q, body);
    case '/vaults-compile': return vaultsCompile(body);
    case '/compile-leaves': return compileLeaves(body);
    case '/balance': return balance(q);
    case '/utxos': return utxos(q);
    case '/psbt-binary': return psbtBinary(body);
    case '/psbt-finalize': return psbtFinalize(body);
    case '/proposals': return proposals(method, q, body);
    case '/proposals-mine': return ok({ proposals: [] });
    case '/members':
      if (method !== 'GET') return fail(400, NOT_HERE);
      return ok({ members: [{ id: 'local-owner', vault_id: q.get('vault_id'), user_id: store.LOCAL_USER, role: 'owner', status: 'active', label: 'You' }] });
    case '/vault-events': {
      const vid = q.get('vault_id');
      const limit = Number(q.get('limit') ?? 50);
      const events = store.list('events').filter(e => e.vault_id === vid).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
      return ok({ events });
    }
    case '/liveness': return ok({ proofs: {}, redFlags: [], config: null });
    case '/signer-sessions': return method === 'GET' ? ok({ sessions: [] }) : ok({});
    case '/invites': case '/stipends': case '/vault-requests': case '/distribution-wallets':
    case '/circle-phrase-deliveries': case '/sent-secrets': case '/vault-messages': case '/proposal-comments':
      return method === 'GET' ? ok({ invites: [], stipends: [], requests: [], wallets: [], deliveries: [], secrets: [], messages: [], comments: [] }) : fail(400, NOT_HERE);
    default:
      return fail(404, NOT_HERE);
  }
}
