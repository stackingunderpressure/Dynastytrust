/**
 * POST /api/psbt-binary-bloc
 *
 * Builds an unsigned PSBT that spends a Dynasty Bloc UTXO via a chosen
 * leaf. Mirrors psbt-binary.js. Two calling conventions:
 *
 *   1. vault_id -- the Bloc vault is now persisted (023_bloc_vaults.sql's
 *      bloc_policy column, wired up to a save path 2026-08-06). Policy +
 *      address + key_origins are looked up server-side from the vaults
 *      table, the same way psbt-binary.js works for standard vaults --
 *      the caller doesn't need to resend the whole policy on every spend.
 *   2. address + raw policy fields -- the original client-holds-the-policy
 *      form BlocBuilder.tsx used before persistence existed. Kept working
 *      underneath so this stays additive, not a breaking rewrite.
 *
 * Parent/kid keys are 66-char compressed pubkey hex (the same values sent
 * to /compile-bloc), so no xpub derivation is needed here.
 *
 * Timelock fields (parent_solo_after, kids_decay_start_after) are
 * ABSOLUTE CLTV heights -- the values the compiler baked into the
 * address. They are passed straight through; unlike /compile-bloc there
 * is no tip conversion at spend time.
 */

import { requireUser, json } from './_auth.js';
import { getSupabaseAdmin } from './_supabase.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

const MEMPOOL = {
  testnet: 'https://mempool.space/testnet/api',
  signet:  'https://mempool.space/signet/api',
  bitcoin: 'https://mempool.space/api',
};

// Taproot input: 57.5 vbytes, output: 43 vbytes, overhead: 10.5.
const TR_INPUT_VBYTES  = 57.5;
const TR_OUTPUT_VBYTES = 43;
const TX_OVERHEAD      = 10.5;

async function mempoolFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mempool.space ${res.status}: ${url}`);
  return res.json();
}

async function getFeeRate(network) {
  try {
    const base = MEMPOOL[network] || MEMPOOL.testnet;
    const fees = await mempoolFetch(`${base}/v1/fees/recommended`);
    return fees.halfHourFee || fees.economyFee || 5;
  } catch { return 5; }
}

function estimateFee(numInputs, numOutputs, feeRate) {
  return Math.ceil((TX_OVERHEAD + numInputs * TR_INPUT_VBYTES + numOutputs * TR_OUTPUT_VBYTES) * feeRate);
}

const BLOC_PATHS = new Set(['parents_now', 'coparent_kids', 'parent_solo', 'kids_decay']);

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  let {
    vault_id,
    address,
    network = 'testnet',
    destination,
    amount_sats,
    fee_rate,
    path = 'parents_now',
    quorum = 0,
    change_address,
    parent_keys = [],
    kid_keys = [],
    parents_together_quorum,
    coparent_quorum,
    kids_with_parent_quorum,
    parent_solo_quorum,
    kids_decay_start_quorum,
    kids_decay_floor_quorum,
    parent_solo_after,
    kids_decay_start_after,
    kids_decay_step_blocks,
    // BIP32 origins for hardware-wallet compatibility (2026-08-06 fix).
    // For a persisted vault (vault_id given) these come from the stored
    // bloc_policy instead -- see the lookup block below.
    key_origins = [],
  } = body;

  // Persisted-vault path: pull address + the whole policy from the
  // vaults row instead of requiring the caller to resend it. Mirrors
  // psbt-binary.js's vault.address lookup. Bloc vaults are single-owner
  // (no vault_members row per signer), so ownership is just user_id.
  if (vault_id) {
    const supabase = getSupabaseAdmin();
    const { data: vault, error } = await supabase
      .from('vaults')
      .select('id, user_id, address, network, bloc_policy')
      .eq('id', vault_id)
      .maybeSingle();
    if (error || !vault) return json(404, { error: 'Vault not found' });
    if (vault.user_id !== u.userId) return json(403, { error: 'Not the owner of this vault' });
    if (!vault.bloc_policy) return json(400, { error: 'Vault has no bloc_policy -- not a Bloc vault' });

    const bp = vault.bloc_policy;
    address = vault.address;
    network = vault.network;
    // 2026-08-12 fix: change must always return to the vault's OWN address
    // when the policy itself is trusted/server-derived -- a caller-supplied
    // change_address surviving this lookup let any request redirect a
    // spend's change to an address of its choosing. Mirrors psbt-binary.js's
    // hardcoded `change_address: vault.address` for the standard vault.
    change_address = vault.address;
    parent_keys = bp.parent_pubkeys ?? [];
    kid_keys = bp.kid_pubkeys ?? [];
    parents_together_quorum = bp.parents_together_quorum;
    coparent_quorum = bp.coparent_quorum;
    kids_with_parent_quorum = bp.kids_with_parent_quorum;
    parent_solo_quorum = bp.parent_solo_quorum;
    kids_decay_start_quorum = bp.kids_decay_start_quorum;
    kids_decay_floor_quorum = bp.kids_decay_floor_quorum;
    parent_solo_after = bp.parent_solo_after;
    kids_decay_start_after = bp.kids_decay_start_after;
    kids_decay_step_blocks = bp.kids_decay_step_blocks;
    key_origins = bp.key_origins ?? [];
  }

  if (!address)     return json(400, { error: 'Missing: address' });
  if (!destination) return json(400, { error: 'Missing: destination' });
  if (!amount_sats || amount_sats < 546) return json(400, { error: 'amount_sats must be >= 546' });
  if (!BLOC_PATHS.has(path)) return json(400, { error: `Unknown path: ${path}` });
  if (path === 'kids_decay' && !quorum) {
    return json(400, { error: 'kids_decay requires a quorum (which decay rung to spend)' });
  }
  if (!parent_keys.length) return json(400, { error: 'Missing: parent_keys' });
  if (!kid_keys.length)    return json(400, { error: 'Missing: kid_keys' });

  if (!COMPILER_URL) {
    return json(503, {
      error: 'Compiler service not configured. Set COMPILER_URL in Netlify environment variables.',
    });
  }

  const base = MEMPOOL[network] || MEMPOOL.testnet;

  // Fetch confirmed UTXOs for the vault address.
  let utxos;
  try {
    utxos = await mempoolFetch(`${base}/address/${address}/utxo`);
  } catch (err) {
    return json(502, { error: 'Could not fetch UTXOs: ' + err.message });
  }
  const confirmed = (utxos || []).filter(u => u.status?.confirmed);
  if (!confirmed.length) {
    return json(200, {
      ok: true, status: 'no_utxos',
      message: 'No confirmed UTXOs. Fund the vault and wait for a confirmation.',
      address,
    });
  }

  // Fee + greedy largest-first coin selection (matches psbt-binary.js).
  const rate   = fee_rate || await getFeeRate(network);
  const estFee = estimateFee(1, 2, rate);
  const sorted = [...confirmed].sort((a, b) => b.value - a.value);
  const selected = [];
  let totalIn = 0;
  for (const utxo of sorted) {
    selected.push(utxo);
    totalIn += utxo.value;
    if (totalIn >= amount_sats + estFee) break;
  }

  const finalFee  = estimateFee(selected.length, 2, rate);
  const changeVal = totalIn - amount_sats - finalFee;
  const hasChange = changeVal >= 546;

  if (totalIn < amount_sats + finalFee) {
    return json(400, {
      ok: false,
      error: `Insufficient funds. Need ${amount_sats + finalFee} sats confirmed, have ${totalIn}.`,
      confirmed_sats: totalIn,
    });
  }

  // scriptPubKey per selected UTXO (required for the PSBT witness_utxo).
  const inputs = await Promise.all(selected.map(async (utxo) => {
    try {
      const tx = await mempoolFetch(`${base}/tx/${utxo.txid}`);
      const vout = tx.vout[utxo.vout];
      return { txid: utxo.txid, vout: utxo.vout, value_sats: utxo.value, script_pubkey: vout?.scriptpubkey || '' };
    } catch {
      return { txid: utxo.txid, vout: utxo.vout, value_sats: utxo.value, script_pubkey: '' };
    }
  }));

  // Bail loudly if any prevout scriptPubKey could not be fetched -- an
  // empty one yields a malformed witness_utxo that only fails later at
  // sign/finalize with an opaque error.
  const missingSpk = inputs.find((i) => !i.script_pubkey);
  if (missingSpk) {
    return json(502, {
      error: `Could not fetch the scriptPubKey for input ${missingSpk.txid}:${missingSpk.vout}. Try again in a moment.`,
    });
  }

  try {
    const compilerRes = await fetch(`${COMPILER_URL.replace(/\/$/, '')}/psbt-binary-bloc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
      },
      body: JSON.stringify({
        inputs,
        destination,
        amount_sats,
        fee_sats: finalFee,
        change_address: change_address || address,
        network,
        path,
        quorum,
        parent_keys,
        kid_keys,
        parents_together_quorum,
        coparent_quorum,
        kids_with_parent_quorum,
        parent_solo_quorum,
        kids_decay_start_quorum,
        kids_decay_floor_quorum,
        parent_solo_after,
        kids_decay_start_after,
        kids_decay_step_blocks,
        key_origins,
      }),
    });

    const rawText = await compilerRes.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch {
      return json(502, {
        error: `Compiler returned non-JSON (status ${compilerRes.status}): ${rawText.slice(0, 200)}`,
        hint: 'Check COMPILER_SECRET matches between Netlify and Fly.io',
      });
    }
    if (!compilerRes.ok || !data.ok) {
      return json(400, { error: data.error || 'Compiler returned an error', detail: `status ${compilerRes.status}` });
    }

    return json(200, {
      ok: true,
      psbt_hex: data.psbt_hex,
      psbt_b64: data.psbt_b64,
      summary: {
        amount_sats,
        fee_sats: finalFee,
        change_sats: hasChange ? changeVal : 0,
        input_count: data.input_count,
        output_count: data.output_count,
        path,
      },
    });
  } catch (err) {
    return json(502, { error: 'Compiler unreachable: ' + err.message });
  }
}
