// Shared mock backend for the DynastyTrust walk. Everything faked; logs unhandled.
const fs = require('fs');
const path = require('path');
const FX = JSON.parse(fs.readFileSync(process.env.WALK_FIXTURE, 'utf8'));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const VAULT_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const TIP = 332480;
const NOW = Math.floor(Date.now() / 1000);

function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
const JWT = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: USER_ID, aud: 'authenticated', role: 'authenticated', exp: NOW + 86400, iat: NOW, aal: 'aal1', amr: [{ method: 'password', timestamp: NOW }], email: 'walker@example.test', session_id: 'sess-1' })}.c2ln`;
const USER = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'walker@example.test',
  email_confirmed_at: '2026-11-01T00:00:00Z', phone: '', confirmed_at: '2026-11-01T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], factors: [],
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
};
const SESSION = { access_token: JWT, token_type: 'bearer', expires_in: 86400, expires_at: NOW + 86400, refresh_token: 'fake-refresh', user: USER };

const addrs = FX.addrs;
const LEAVES = FX.leaves.map(l => ({ ...l, required_keys: [] }));
const VAULT = {
  id: VAULT_ID, created_at: '2026-11-20T12:00:00Z', updated_at: '2026-11-24T12:00:00Z', user_id: USER_ID,
  name: 'Walk test vault', network: 'signet',
  address: FX.compiled.address, descriptor: FX.compiled.descriptor, miniscript_policy: FX.compiled.miniscript_policy,
  address_type: 'tr_multileaf', founder_quorum: 1, heir_quorum: 1, recovery_quorum: null,
  recovery_after: 0, inheritance_after: 0, founder_keys: [], heir_keys: [], consent_keys: [], consent_quorum: null,
  backup_keys: [], backup_quorum: null, second_heir_keys: [], second_heir_quorum: null, second_inheritance_after: null,
  archived: false, status: 'compiled', my_role: 'owner', predecessor_id: null,
  planned_founder_count: null, planned_heir_count: null, trust_doc: {}, duress: false, bloc_policy: null,
  leaf_scripts: FX.compiled.leaf_scripts, key_labels: [], leaves: LEAVES, key_origins: FX.keyOrigins,
  descriptor_version: 2, descriptor_multipath: FX.ranged.multipath, descriptor_receive: FX.ranged.receive,
  descriptor_change: FX.ranged.change, ranged_format: 1,
};

const COIN_TXID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';
const COIN = { txid: COIN_TXID, vout: 0, value_sats: 9071, confirmed: true, block_height: 332478, block_time: NOW - 1800, confirmations: TIP - 332478 + 1, address: addrs[2], branch: 0, index: 2 };
const BALANCE = {
  ok: true, address: VAULT.address, network: 'signet', confirmed_sats: 9071, unconfirmed_sats: 0, total_sats: 9071,
  btc_amount: 0.00009071, btc_price_usd: null, usd_value: null, utxo_count: 1, confirmed_utxos: 1,
  mempool_url: `https://mempool.space/signet/address/${VAULT.address}`, tx_count: 1, tip: TIP, source: 'mempool.space', coins: [COIN],
};

const MEMBERS = [
  { id: 'm-owner', created_at: '2026-11-20T12:00:00Z', vault_id: VAULT_ID, user_id: USER_ID, role: 'owner', label: 'Me', xpub: FX.origins[0].xpub, fingerprint: FX.origins[0].fingerprint, pubkey: FX.pk[0], derivation_path: FX.keyOrigins[0].derivation_path, key_label: null, status: 'active', messaging_pubkey: null, leaf_id: null },
];

const state = { prop: null, vk: { version: 0, checks: {}, wraps: [] }, messagingPub: null, proposalSigned: false, psbtHex: FX.proposalPsbt.psbt_hex, psbtB64: FX.proposalPsbt.psbt_b64 };
function resetProposal() {
  state.prop = { hex: FX.proposalPsbt.psbt_hex, merged: FX.merged, destination: FX.proposalPsbt.summary.destination, amount: 5000, fee: FX.proposalPsbt.summary.fee_sats };
  state.proposalSigned = false; state.submittedPartial = null;
}
resetProposal();
function b64(hex) { return Buffer.from(hex, 'hex').toString('base64'); }
function sessions() {
  if (!state.proposalSigned) return [];
  return [{ id: 'ss-1', created_at: '2026-11-25T10:05:00Z', proposal_id: PROPOSAL_ID, signer_index: 0, signer_role: 'owner', label: 'My key',
    signed: true, signed_at: '2026-11-25T10:05:00Z', fingerprint: FX.origins[0].fingerprint, member_id: 'm-owner', psbt_partial_hex: state.submittedPartial || FX.signed1.psbt_hex }];
}
function proposal() {
  const P = state.prop;
  const hex = state.proposalSigned ? (state.submittedPartial || P.merged || P.hex) : P.hex;
  return {
    id: PROPOSAL_ID, created_at: '2026-11-25T10:00:00Z', vault_id: VAULT_ID, path: 'everyday',
    destination: P.destination, amount_sats: P.amount, fee_sats: P.fee, status: 'pending',
    psbt_hex: hex, psbt_b64: b64(hex), memo: 'Walk test send',
    signer_sessions: sessions().map(({ psbt_partial_hex, created_at, proposal_id, ...rest }) => rest),
  };
}

const unhandled = [];
const handledLog = [];

function apiHandle(u, method, body) {
  const p = u.pathname.replace(/^\/api/, '');
  const q = u.searchParams;
  if (p === '/vaults' && method === 'GET') {
    if (q.get('id')) return { ok: true, vault: VAULT };
    return { ok: true, vaults: [VAULT] };
  }
  if (p === '/vaults' && method === 'PATCH') return { ok: true, vault: VAULT };
  if (p === '/vault-keys' && method === 'GET') {
    const mine = state.vk.wraps.filter(w => w.recipient_user_id === USER_ID).map(w => ({ version: w.version, wrap: w.wrap }));
    if (!q.get('vault_id')) return { ok: true, vaults: state.vk.version ? [{ vault_id: VAULT_ID, version: state.vk.version, checks: state.vk.checks, mine }] : [] };
    return { ok: true, version: state.vk.version, owner_user_id: USER_ID, checks: state.vk.checks, mine,
      current_holders: state.vk.wraps.filter(w => w.version === state.vk.version).map(w => ({ user_id: w.recipient_user_id, pubkey: state.messagingPub })),
      members: [{ user_id: USER_ID, messaging_pubkey: state.messagingPub }] };
  }
  if (p === '/vault-keys' && method === 'POST') {
    const b = JSON.parse(body || '{}');
    state.vk.version = b.version; if (b.check) state.vk.checks[String(b.version)] = b.check;
    for (const w of b.wraps || []) state.vk.wraps.push({ version: b.version, recipient_user_id: w.recipient_user_id, wrap: w.wrap });
    return { ok: true, version: b.version };
  }
  if (p === '/members' && method === 'PATCH') {
    const b = JSON.parse(body || '{}');
    if (b.messaging_pubkey !== undefined) state.messagingPub = b.messaging_pubkey;
    return { ok: true, member: { ...MEMBERS[0], messaging_pubkey: state.messagingPub } };
  }
  if (p === '/members' && method === 'GET') return { ok: true, members: MEMBERS.map(m => ({ ...m, messaging_pubkey: state.messagingPub })) };
  if (p === '/balance') return BALANCE;
  if (p === '/vault-addresses' && method === 'GET') {
    if (q.get('list')) return { ok: true, unpaid_run: 1, gap_limit: 20, addresses: [3, 2, 1, 0].map(i => ({ index: i, address: addrs[i], label: null, paid: i !== 3 })) };
    return { ok: true, next: { 0: 4, 1: 0 }, change_from: 0 };
  }
  if (p === '/vault-addresses' && method === 'POST') {
    const b = body ? JSON.parse(body) : {};
    if (b.mode === 'new') return { ok: true, index: 4, address: addrs[4], label: null, reused: false, unpaid_run: 2 };
    return { ok: true, index: 3, address: addrs[3], label: null, reused: true, unpaid_run: 1 };
  }
  if (p === '/proposals' && method === 'GET') {
    if (q.get('id')) return { ok: true, proposal: proposal() };
    return { ok: true, proposals: [proposal()] };
  }
  if (p === '/proposals' && method === 'POST') { const b = JSON.parse(body || '{}'); return { ok: true, proposal: { ...proposal(), ...b, id: PROPOSAL_ID, status: 'pending' } }; }
  if (p === '/proposals' && method === 'PATCH') return { ok: true, proposal: proposal() };
  if (p === '/utxos') return { ok: true, vault_address: VAULT.address, network: 'signet', tip: TIP, utxos: [COIN], source: 'mempool.space' };
  if (p === '/signer-sessions' && method === 'POST') {
    const b = JSON.parse(body || '{}'); state.proposalSigned = true; state.submittedPartial = b.psbt_partial_hex;
    return { ok: true, session: { id: 'ss-1', member_id: 'm-owner', fingerprint: b.fingerprint || FX.origins[0].fingerprint, signed: true, signed_at: new Date().toISOString(), psbt_partial_hex: b.psbt_partial_hex } };
  }
  if (p === '/psbt-merge') { const h = state.submittedPartial || state.prop.merged || state.prop.hex; return { ok: true, psbt_hex: h, psbt_b64: b64(h), signature_count: state.proposalSigned ? 1 : 0, fully_signed: state.proposalSigned }; }
  if (p === '/signer-sessions' && method === 'GET') return { ok: true, sessions: sessions() };
  if (p === '/members') return { ok: true, members: MEMBERS };
  if (p === '/liveness' && method === 'GET') return { ok: true, proofs: {}, redFlags: [], config: null };
  if (p === '/invites') return { ok: true, invites: [] };
  if (p === '/vault-messages') return { ok: true, messages: [] };
  if (p === '/sent-secrets') return { ok: true, secrets: [] };
  if (p === '/vault-membership-grants') return { ok: true, grants: [] };
  if (p === '/circle-phrase-deliveries') return { ok: true, deliveries: [] };
  if (p === '/vault-attestations') return { ok: true, attestations: [] };
  if (p === '/distribution-wallets') return { ok: true, wallets: [] };
  if (p === '/stipends') return { ok: true, stipends: [] };
  if (p === '/vault-requests') return { ok: true, requests: [] };
  if (p === '/proposal-comments') return { ok: true, comments: [] };
  if (p === '/wallet-link') return { ok: true, pubkey: null, bound_at: null, device_keys: 0 };
  return undefined;
}

function guessEmpty(u) {
  const last = u.pathname.split('/').filter(Boolean).pop() || 'items';
  const key = last.replace(/-/g, '_');
  return { ok: true, [key]: [], items: [] };
}

function mempoolHandle(u) {
  const p = u.pathname.replace(/^\/(signet|testnet)/, '').replace(/^\/api/, '');
  if (p === '/blocks/tip/height') return { text: String(TIP) };
  if (p === '/blocks/tip/hash') return { text: '00000000000000000000000000000000000000000000000000000000000000aa' };
  if (p.startsWith('/v1/fees/recommended')) return { json: { fastestFee: 3, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 } };
  if (p.startsWith('/v1/prices')) return { json: { time: NOW, USD: 95000 } };
  if (p === '/fee-estimates') return { json: { 1: 3.2, 2: 3.0, 3: 2.5, 6: 2.0, 12: 1.5, 144: 1.0 } };
  let m;
  if ((m = p.match(/^\/address\/([^/]+)\/utxo$/))) {
    return { json: m[1] === addrs[2] ? [{ txid: COIN_TXID, vout: 0, value: 9071, status: { confirmed: true, block_height: 332478, block_time: NOW - 1800 } }] : [] };
  }
  if ((m = p.match(/^\/address\/([^/]+)\/txs/))) {
    const paid = [addrs[0], addrs[1], addrs[2]].includes(m[1]);
    return { json: paid ? [{ txid: COIN_TXID, status: { confirmed: true, block_height: 332478 }, vin: [], vout: [{ scriptpubkey_address: m[1], value: 9071 }] }] : [] };
  }
  if ((m = p.match(/^\/address\/([^/]+)$/))) {
    const paid = [addrs[0], addrs[1], addrs[2]].includes(m[1]);
    const fund = m[1] === addrs[2] ? 9071 : 0;
    return { json: { address: m[1], chain_stats: { funded_txo_count: paid ? 1 : 0, funded_txo_sum: fund, spent_txo_count: 0, spent_txo_sum: 0, tx_count: paid ? 1 : 0 }, mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 } } };
  }
  if ((m = p.match(/^\/tx\/([0-9a-f]+)\/status$/))) return { json: { confirmed: true, block_height: 332478 } };
  if ((m = p.match(/^\/tx\/([0-9a-f]+)\/hex$/))) return { text: state.coinTxHex || '' };
  return undefined;
}

const ROOT = path.resolve(__dirname, '../..');
async function psbtBinary(body) {
  const b = JSON.parse(body || '{}');
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
  const cwd = process.cwd(); process.chdir(ROOT);
  try {
    const { buildRangedSpend } = await import(ROOT + '/netlify/functions/_ranged-spend.js');
    let nextChange = 0;
    const sb = { from: () => { const o = { select: () => o, eq: () => o, in: () => o, order: () => o, limit: () => o,
        then: (res) => res({ data: [], error: null }), insert: async () => ({ error: null }) }; return o; },
      rpc: async () => ({ data: nextChange++, error: null }) };
    const coins = [{ txid: COIN_TXID, vout: 0, value: 9071, status: { confirmed: true, block_height: 332478 }, address: addrs[2], branch: 0, index: 2 }];
    const deps = { coinsAt: async () => coins, fetchTipHeight: async () => TIP, getFeeRate: async () => b.fee_rate || 2, vaultUsed: async () => new Set([addrs[0], addrs[1], addrs[2]]) };
    const r = await buildRangedSpend({ supabase: sb, vault: { ...VAULT, leaves: LEAVES }, userId: USER_ID, body: b }, deps);
    psbtLog.push({ status: r.status, error: r.body && r.body.error, summary: r.body && r.body.summary });
    if (r.status === 200 && r.body.psbt_hex) { const sm = r.body.summary; state.prop = { hex: r.body.psbt_hex, merged: null, destination: sm.destination, amount: sm.amount_sats, fee: sm.fee_sats }; state.proposalSigned = false; state.submittedPartial = null; }
    return { status: r.status, body: r.body };
  } finally { process.chdir(cwd); }
}
const psbtLog = [];

async function install(context, opts = {}) {
  if (context.routeWebSocket) {
    await context.routeWebSocket(/fakeproj\.supabase\.co/, ws => { unhandled.push('WS ' + ws.url().split('?')[0] + ' (accepted, no messages)'); ws.onMessage(() => {}); });
  }
  await context.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const method = req.method();
    // local app + vite
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      if (u.pathname.startsWith('/api/')) {
        if (u.pathname === '/api/psbt-finalize' && method === 'POST') {
          const cwd = process.cwd(); process.chdir(ROOT);
          let r; try { const { callWasm } = await import(ROOT + '/netlify/functions/_ranged-wasm.js'); r = callWasm('/psbt-finalize', JSON.parse(req.postData() || '{}')); } finally { process.chdir(cwd); }
          handledLog.push('POST /api/psbt-finalize -> ' + r.status);
          return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
        }
        if (u.pathname === '/api/psbt-binary' && method === 'POST') {
          const r = await psbtBinary(req.postData());
          handledLog.push('POST /api/psbt-binary -> ' + r.status);
          return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
        }
        let body = apiHandle(u, method, req.postData());
        if (opts.apiOverride) { const o = await opts.apiOverride(u, method, req.postData()); if (o !== undefined) body = o; }
        if (body === undefined) { unhandled.push(`${method} ${u.pathname}${u.search}`); body = guessEmpty(u); }
        else handledLog.push(`${method} ${u.pathname}${u.search}`);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.continue();
    }
    if (u.hostname === 'fakeproj.supabase.co') {
      handledLog.push(`${method} supabase ${u.pathname}`);
      if (u.pathname === '/auth/v1/user') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USER) });
      if (u.pathname === '/auth/v1/token') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SESSION) });
      if (u.pathname.startsWith('/rest/v1/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      unhandled.push(`${method} ${u.href}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (u.hostname === 'mempool.space') {
      const r = mempoolHandle(u);
      if (r) {
        handledLog.push(`${method} mempool ${u.pathname}`);
        if (r.text !== undefined) return route.fulfill({ status: 200, contentType: 'text/plain', body: r.text });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r.json) });
      }
      unhandled.push(`${method} ${u.href}`);
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not mocked' });
    }
    if (u.hostname.endsWith('fonts.googleapis.com') || u.hostname.endsWith('fonts.gstatic.com')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    unhandled.push(`${method} ${u.href}`);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.addInitScript(([s]) => {
    try { localStorage.setItem('sb-fakeproj-auth-token', s); } catch { /* ignore */ }
  }, [JSON.stringify(SESSION)]);
}

function resetVk() { state.vk = { version: 0, checks: {}, wraps: [] }; state.messagingPub = null; }
module.exports = { resetVk, resetProposal, psbtLog, install, unhandled, handledLog, VAULT_ID, PROPOSAL_ID, VAULT, FX, state, addrs, TIP };
