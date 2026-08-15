/**
 * POST /api/psbt-binary-tranche
 *
 * Builds an unsigned PSBT spending a single distribution-wallet
 * tranche -- either the beneficiary claiming it after its timelock,
 * or a trustee using the escape hatch. Mirrors psbt-binary-bloc.js:
 * the tranche's own address is fetched fresh from mempool.space
 * (tranches are not tracked in the vault's own balance/UTXO view),
 * and the policy params needed to recompile the exact tree
 * (beneficiary_key, trustee_keys, trustee_quorum, unlock_block) come
 * from the distribution_wallets row + the specific tranche entry,
 * not from the request body -- a caller cannot claim against a leaf
 * they invented.
 *
 * Authorization mirrors the rest of the app: any active member of
 * the parent vault can build a PSBT (it contains no private key
 * material and reveals nothing a member can't already see). Who can
 * actually PRODUCE A VALID SIGNATURE for the chosen path is enforced
 * by the Taproot script itself, not by this endpoint -- the
 * beneficiary leaf requires the beneficiary's own key, the trustee
 * leaf requires trustee_quorum of the trustee keys.
 */

import { requireUser, json } from './_auth.js';
import { getSupabaseAdmin } from './_supabase.js';
import { MEMPOOL, mempoolFetch, getFeeRate, fetchTipHeight } from './_chain.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

// Taproot input: 57.5 vbytes, output: 43 vbytes, overhead: 10.5.
const TR_INPUT_VBYTES  = 57.5;
const TR_OUTPUT_VBYTES = 43;
const TX_OVERHEAD      = 10.5;

// See psbt-binary.js for why this bound exists: an unbounded
// caller-supplied fee_rate could drain most of a spend into fees --
// this endpoint defaults to sweeping the whole tranche, so it's an
// even bigger target than the standard vault's spend flow.
const MIN_FEE_RATE_SAT_VB = 1;
const MAX_FEE_RATE_SAT_VB = 1000;

function estimateFee(numInputs, numOutputs, feeRate) {
  return Math.ceil((TX_OVERHEAD + numInputs * TR_INPUT_VBYTES + numOutputs * TR_OUTPUT_VBYTES) * feeRate);
}

async function assertMember(supabase, vaultId, userId) {
  const { data } = await supabase
    .from('vault_members')
    .select('id')
    .eq('vault_id', vaultId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  return !!data;
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const {
    distribution_wallet_id,
    tranche_index,
    destination,
    amount_sats,
    fee_rate,
    path = 'beneficiary',
    // Caller-supplied key_origins is a legacy/manual fallback; the
    // 2026-08-12 fix stores key_origins on the distribution_wallets row
    // itself at creation time (mirrors bloc_policy.key_origins) and that
    // takes priority below, same as psbt-binary-bloc.js's pattern.
    key_origins: bodyKeyOrigins = [],
  } = body;

  if (!distribution_wallet_id) return json(400, { error: 'Missing: distribution_wallet_id' });
  if (typeof tranche_index !== 'number') return json(400, { error: 'Missing: tranche_index' });
  if (!destination) return json(400, { error: 'Missing: destination' });
  if (fee_rate != null && (fee_rate < MIN_FEE_RATE_SAT_VB || fee_rate > MAX_FEE_RATE_SAT_VB)) {
    return json(400, { error: `fee_rate must be between ${MIN_FEE_RATE_SAT_VB} and ${MAX_FEE_RATE_SAT_VB} sat/vB` });
  }
  if (path !== 'beneficiary' && path !== 'trustee') {
    return json(400, { error: `Unknown path: ${path}` });
  }
  if (!COMPILER_URL) {
    return json(503, {
      error: 'Compiler service not configured. Set COMPILER_URL in Netlify environment variables.',
    });
  }

  const supabase = getSupabaseAdmin();

  const { data: wallet, error: walletErr } = await supabase
    .from('distribution_wallets')
    .select('vault_id, trustee_keys, trustee_quorum, beneficiary_pubkey, tranches, network, key_origins')
    .eq('id', distribution_wallet_id)
    .maybeSingle();
  if (walletErr) return json(500, { error: walletErr.message });
  if (!wallet) return json(404, { error: 'Distribution wallet not found' });

  if (!(await assertMember(supabase, wallet.vault_id, u.userId))) {
    return json(403, { error: 'Not a member of this vault' });
  }

  const tranche = (wallet.tranches || [])[tranche_index];
  if (!tranche) return json(404, { error: `No tranche at index ${tranche_index}` });
  if (tranche.claimed_txid) {
    return json(400, { error: 'This tranche has already been claimed' });
  }

  if (path === 'beneficiary') {
    let tip;
    try {
      tip = await fetchTipHeight(wallet.network);
    } catch (err) {
      return json(502, { error: 'Could not fetch chain tip: ' + err.message });
    }
    if (tip < tranche.unlock_block) {
      return json(400, {
        error: `This tranche unlocks for the beneficiary at block ${tranche.unlock_block} (current tip ${tip}). Use the trustee escape hatch to move funds before then.`,
      });
    }
  }

  const network = wallet.network || 'testnet';
  const base = MEMPOOL[network] || MEMPOOL.testnet;

  let utxos;
  try {
    utxos = await mempoolFetch(`${base}/address/${tranche.address}/utxo`);
  } catch (err) {
    return json(502, { error: 'Could not fetch UTXOs: ' + err.message });
  }
  const confirmed = (utxos || []).filter((x) => x.status?.confirmed);
  if (!confirmed.length) {
    return json(200, {
      ok: true, status: 'no_utxos',
      message: 'No confirmed UTXOs at this tranche address yet.',
      address: tranche.address,
    });
  }

  const rate = fee_rate || await getFeeRate(network);

  // Default to sweeping the tranche: a claim takes everything sitting
  // there, not an arbitrary partial amount. The caller may still
  // override amount_sats (e.g. a trustee redirecting only part of it).
  //
  // 2026-08-15 fix (operator: "what about all the trenches and any
  // other specialty places where you can hide it" -- following up on
  // the standard/Bloc vault Max-spend fix) -- the sweep default here
  // computed its OWN target using a 1-output (no-change) fee estimate,
  // but the coin-selection loop and the actual fee charged below always
  // sized for 2 outputs regardless, as if a change output were coming.
  // For a genuine full sweep that mismatch doesn't leave stray change
  // (this endpoint's own insufficient-funds guard catches it first,
  // since totalIn can never exceed totalAvailable) -- it instead FALSE-
  // FAILED a real sweep claim by roughly one output's worth of fee,
  // right at the edge where the balance was exactly enough to sweep
  // cleanly. Same root cause as psbt-binary.js/-bloc.js: an amount and
  // a fee estimate computed on two different assumptions about how many
  // outputs the transaction has. Sweep and partial-amount claims are
  // now fully separate branches, each internally consistent.
  const isSweep = !(typeof amount_sats === 'number' && amount_sats > 0);
  let selected;
  let totalIn = 0;
  let finalFee;
  let targetAmount;
  let hasChange;
  let changeVal = 0;

  if (isSweep) {
    selected = confirmed;
    totalIn = selected.reduce((n, u) => n + u.value, 0);
    finalFee = estimateFee(selected.length, 1, rate); // 1 output: destination only, no change
    targetAmount = totalIn - finalFee;
    if (targetAmount < 546) {
      return json(400, { error: 'Not enough confirmed balance to cover a claim above the dust limit.' });
    }
    hasChange = false;
  } else {
    targetAmount = amount_sats;
    const sorted = [...confirmed].sort((a, b) => b.value - a.value);
    selected = [];
    for (const utxo of sorted) {
      selected.push(utxo);
      totalIn += utxo.value;
      if (totalIn >= targetAmount + estimateFee(selected.length, 2, rate)) break;
    }
    finalFee = estimateFee(selected.length, 2, rate);
    changeVal = totalIn - targetAmount - finalFee;
    hasChange = changeVal >= 546;

    if (totalIn < targetAmount + finalFee) {
      return json(400, {
        ok: false,
        error: `Insufficient funds. Need ${targetAmount + finalFee} sats confirmed, have ${totalIn}.`,
        confirmed_sats: totalIn,
      });
    }
  }

  const inputs = await Promise.all(selected.map(async (utxo) => {
    try {
      const tx = await mempoolFetch(`${base}/tx/${utxo.txid}`);
      const vout = tx.vout[utxo.vout];
      return { txid: utxo.txid, vout: utxo.vout, value_sats: utxo.value, script_pubkey: vout?.scriptpubkey || '' };
    } catch {
      return { txid: utxo.txid, vout: utxo.vout, value_sats: utxo.value, script_pubkey: '' };
    }
  }));
  const missingSpk = inputs.find((i) => !i.script_pubkey);
  if (missingSpk) {
    return json(502, {
      error: `Could not fetch the scriptPubKey for input ${missingSpk.txid}:${missingSpk.vout}. Try again in a moment.`,
    });
  }

  try {
    const compilerRes = await fetch(`${COMPILER_URL.replace(/\/$/, '')}/psbt-binary-tranche`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
      },
      body: JSON.stringify({
        inputs,
        destination,
        amount_sats: targetAmount,
        fee_sats: finalFee,
        // 2026-08-12 fix: this endpoint's policy (beneficiary_key,
        // trustee_keys, unlock_block) is ALWAYS server-derived from the
        // distribution_wallets row -- there is no client-holds-the-policy
        // path the way psbt-binary-bloc.js has. A caller-supplied
        // change_address has no such backing and, since this endpoint
        // defaults to sweeping the entire tranche, would let a request
        // redirect nearly the whole tranche balance to an address of its
        // choosing. Change must always return to the tranche's own address.
        change_address: tranche.address,
        network,
        beneficiary_key: wallet.beneficiary_pubkey,
        trustee_keys: wallet.trustee_keys,
        trustee_quorum: wallet.trustee_quorum,
        unlock_block: tranche.unlock_block,
        path,
        key_origins: (wallet.key_origins && wallet.key_origins.length > 0) ? wallet.key_origins : bodyKeyOrigins,
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
        amount_sats: targetAmount,
        fee_sats: finalFee,
        change_sats: hasChange ? changeVal : 0,
        input_count: data.input_count,
        output_count: data.output_count,
        path,
        tranche_address: tranche.address,
      },
    });
  } catch (err) {
    return json(502, { error: 'Compiler unreachable: ' + err.message });
  }
}
