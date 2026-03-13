/**
 * POST /api/psbt-binary
 *
 * Fetches UTXOs from mempool.space, then calls the Fly.io Rust compiler
 * to build a proper binary PSBT (not JSON — actual Bitcoin PSBT format).
 *
 * Returns:
 *   psbt_hex  — hex-encoded binary PSBT for Sparrow/Nunchuk
 *   psbt_b64  — base64-encoded PSBT for QR display (UR encoding happens client-side)
 *   summary   — spend details for UI display
 */

import { requireUser, json } from './_auth.js';
import { getSupabaseAdmin } from './_supabase.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

const MEMPOOL = {
  testnet: 'https://mempool.space/testnet/api',
  bitcoin: 'https://mempool.space/api',
};

// Taproot input: 57.5 vbytes, output: 43 vbytes, overhead: 10.5
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

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { vault_id, destination, amount_sats, fee_rate, path = 'founders_now' } = body;
  if (!vault_id)    return json(400, { error: 'Missing: vault_id' });
  if (!destination) return json(400, { error: 'Missing: destination' });
  if (!amount_sats || amount_sats < 546) return json(400, { error: 'amount_sats must be >= 546' });

  // Load vault
  const supabase = getSupabaseAdmin();
  const { data: vault, error } = await supabase
    .from('vaults')
    .select('id, name, address, network, descriptor, address_type, recovery_after, inheritance_after, founder_quorum, heir_quorum, founder_keys, heir_keys')
    .eq('id', vault_id)
    .eq('user_id', u.userId)
    .single();

  if (error || !vault) return json(404, { error: 'Vault not found' });

  const network = vault.network || 'testnet';
  const base    = MEMPOOL[network] || MEMPOOL.testnet;

  // Fetch UTXOs
  let utxos;
  try {
    utxos = await mempoolFetch(`${base}/address/${vault.address}/utxo`);
  } catch (err) {
    return json(502, { error: 'Could not fetch UTXOs: ' + err.message });
  }

  const confirmed = (utxos || []).filter(u => u.status?.confirmed);
  if (!confirmed.length) {
    return json(200, { ok: true, status: 'no_utxos',
      message: 'No confirmed UTXOs. Fund the vault and wait for confirmation.',
      address: vault.address });
  }

  // Get fee rate and estimate
  const rate = fee_rate || await getFeeRate(network);
  const estFee = estimateFee(1, 2, rate);

  // Coin selection — greedy largest first
  const sorted = [...confirmed].sort((a, b) => b.value - a.value);
  const selected = [];
  let totalIn = 0;
  for (const u of sorted) {
    selected.push(u);
    totalIn += u.value;
    if (totalIn >= amount_sats + estFee) break;
  }

  const finalFee   = estimateFee(selected.length, 2, rate);
  const changeVal  = totalIn - amount_sats - finalFee;
  const hasChange  = changeVal >= 546;

  if (totalIn < amount_sats + finalFee) {
    return json(400, {
      ok: false,
      error: `Insufficient funds. Need ${amount_sats + finalFee} sats confirmed, have ${totalIn}.`,
      confirmed_sats: totalIn,
    });
  }

  // Fetch scriptPubKeys for each selected UTXO (needed for PSBT witness_utxo)
  const inputsWithScript = await Promise.all(selected.map(async (u) => {
    try {
      const tx = await mempoolFetch(`${base}/tx/${u.txid}`);
      const vout = tx.vout[u.vout];
      return {
        txid: u.txid,
        vout: u.vout,
        value_sats: u.value,
        script_pubkey: vout?.scriptpubkey || '',
      };
    } catch {
      return { txid: u.txid, vout: u.vout, value_sats: u.value, script_pubkey: '' };
    }
  }));

  // Build binary PSBT via Rust compiler
  if (!COMPILER_URL) {
    // Fallback: return JSON PSBT structure for manual import
    return json(200, {
      ok: true,
      fallback: true,
      message: 'COMPILER_URL not set — returning JSON PSBT. Deploy compiler for binary PSBT.',
      psbt_json: { inputs: inputsWithScript, destination, amount_sats, fee_sats: finalFee, change_sats: hasChange ? changeVal : 0 },
      summary: { vault_name: vault.name, vault_address: vault.address, destination, amount_sats, fee_sats: finalFee, fee_rate: rate, input_count: selected.length, total_in_sats: totalIn, network },
    });
  }

  try {
    const compilerRes = await fetch(`${COMPILER_URL.replace(/\/$/, '')}/psbt-binary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
      },
      body: JSON.stringify({
        inputs:            inputsWithScript,
        destination,
        amount_sats,
        fee_sats:          finalFee,
        change_address:    vault.address,
        network,
        // Pass vault policy params so compiler can attach tap_leaf_script
        // This is required for Coldcard/Passport/Keystone to sign correctly
        address_type:      vault.address_type || 'tr',
        founder_keys:      vault.founder_keys  || [],
        founder_quorum:    vault.founder_quorum,
        heir_keys:         vault.heir_keys     || [],
        heir_quorum:       vault.heir_quorum,
        recovery_after:    vault.recovery_after,
        inheritance_after: vault.inheritance_after,
      }),
    });

    const psbtData = await compilerRes.json();
    if (!compilerRes.ok || !psbtData.ok) {
      throw new Error(psbtData.error || `Compiler error: ${compilerRes.status}`);
    }

    // Log event
    await supabase.from('vault_events').insert({
      vault_id: vault.id,
      user_id:  u.userId,
      event_type: 'psbt_generated',
      metadata: { destination, amount_sats, fee_sats: finalFee, fee_rate: rate, input_count: selected.length, binary: true, path },
    });

    return json(200, {
      ok: true,
      psbt_hex: psbtData.psbt_hex,
      psbt_b64: psbtData.psbt_b64,
      summary: {
        vault_name:    vault.name,
        vault_address: vault.address,
        destination,
        amount_sats,
        fee_sats:      finalFee,
        change_sats:   hasChange ? changeVal : 0,
        fee_rate:      rate,
        input_count:   selected.length,
        total_in_sats: totalIn,
        network,
        path,
      },
    });

  } catch (err) {
    console.error('PSBT binary error:', err);
    return json(502, { error: 'Compiler error: ' + err.message });
  }
}
