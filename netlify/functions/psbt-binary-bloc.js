/**
 * POST /api/psbt-binary-bloc
 *
 * Builds an unsigned PSBT that spends a Dynasty Bloc UTXO via a chosen
 * leaf. Mirrors psbt-binary.js. vault_id is required -- the Bloc vault
 * is persisted (023_bloc_vaults.sql's bloc_policy column, wired up to a
 * save path 2026-08-06); policy + address + key_origins are looked up
 * server-side from the vaults table, the same way psbt-binary.js works
 * for standard vaults, and ownership is checked against the caller.
 *
 * The original client-holds-the-policy direct/ad-hoc calling convention
 * (address + raw policy fields, no vault_id, no ownership check) that
 * BlocBuilder.tsx used before persistence existed was removed 2026-08-21
 * (Kimi K3 scan #4/#38): BlocBuilder.tsx itself was retired when
 * VaultWizard absorbed it, and the only live caller
 * (VaultDetail.tsx's send flow) always passes vault_id -- the direct
 * path was dead code that let any authenticated caller build a spend
 * PSBT against an arbitrary address with a caller-controlled
 * change_address, no ownership check possible since there was nothing
 * to check ownership against.
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
import { MEMPOOL, mempoolFetch, getFeeRate } from './_chain.js';
import { assertNotPrivateExtendedKey } from './_xpub.js';
import { checkNumberBounds, MIN_FEE_RATE_SAT_VB, MAX_FEE_RATE_SAT_VB } from './_numeric.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

// Taproot input: 57.5 vbytes, output: 43 vbytes, overhead: 10.5.
const TR_INPUT_VBYTES  = 57.5;
const TR_OUTPUT_VBYTES = 43;
const TX_OVERHEAD      = 10.5;

// Size a script-path (tapscript leaf) taproot input properly instead of
// the flat TR_INPUT_VBYTES guess, which is only correct for a plain
// key-path spend and underestimated every Bloc leaf -- even the
// simplest one (parents_now at, say, 2-of-3) is already far bigger
// than a key-path spend once the leaf script and control block are
// counted. Ported from psbt-binary.js's tapscript-sizing math.
//
// Bloc's leaves aren't all the same shape, though: parents_now,
// parent_solo, and each kids_decay rung are a single flat
// thresh(quorum, total); coparent_kids is
// and(thresh(coparent_quorum, parents), thresh(kids_with_parent_quorum, kids))
// -- an AND of two SEPARATE thresholds, needing sigs from BOTH groups
// and a bigger leaf script than a single thresh(). The coparent_kids
// branch below sums both groups' cost, which won't match the compiled
// miniscript byte-for-byte but is a much closer bound than the flat
// constant was -- and erring slightly high is the safe direction for
// a fee estimate, not the dangerous one.
function estimateBlocInputVbytes(policy, path, quorum, treeDepth) {
  const controlBlock = 33 + 1 + 32 * treeDepth;
  const parentTotal = (policy.parent_keys || []).length;
  const kidTotal = (policy.kid_keys || []).length;

  let witnessBytes;
  if (path === 'coparent_kids') {
    const parentQuorum = policy.coparent_quorum ?? 0;
    const kidQuorum = policy.kids_with_parent_quorum ?? 0;
    const leafScript = (33 * parentTotal + 2) + (33 * kidTotal + 2) + 8; // both sub-scripts + AND overhead
    witnessBytes =
      parentQuorum * 65 + Math.max(parentTotal - parentQuorum, 0) * 1 +
      kidQuorum * 65 + Math.max(kidTotal - kidQuorum, 0) * 1 +
      (leafScript + 3) + (controlBlock + 3) + 1;
  } else {
    const total = (path === 'parent_solo' || path === 'parents_now') ? parentTotal : kidTotal;
    const leafScript = 33 * total + 2;
    witnessBytes =
      quorum * 65 + Math.max(total - quorum, 0) * 1 +
      (leafScript + 3) + (controlBlock + 3) + 1;
  }
  const baseInput = 41;
  return baseInput + witnessBytes / 4;
}

// Total leaves in this Bloc vault's tree: parents_now + coparent_kids +
// parent_solo + one per kids_decay rung (start quorum down to floor
// quorum, inclusive, stepping by one -- matches build_bloc_multileaf's
// decay loop in protocol/src/policy_compiler.rs exactly).
function leafCountForBlocTree(policy) {
  const rungs = Math.max(1,
    (policy.kids_decay_start_quorum ?? 1) - (policy.kids_decay_floor_quorum ?? 1) + 1);
  return 3 + rungs;
}

function estimateFee(numInputs, numOutputs, feeRate, inputVbytes = TR_INPUT_VBYTES) {
  return Math.ceil((TX_OVERHEAD + numInputs * inputVbytes + numOutputs * TR_OUTPUT_VBYTES) * feeRate);
}

const BLOC_PATHS = new Set(['parents_now', 'coparent_kids', 'parent_solo', 'kids_decay']);

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const {
    vault_id,
    destination,
    amount_sats,
    sweep,
    fee_rate,
    path = 'parents_now',
    quorum = 0,
  } = body;

  if (!vault_id) return json(400, { error: 'Missing: vault_id' });

  // Pull address + the whole policy from the vaults row -- the caller
  // never supplies policy fields directly. Mirrors psbt-binary.js's
  // vault.address lookup. Bloc vaults are single-owner (no
  // vault_members row per signer), so ownership is just user_id.
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
  const address = vault.address;
  const network = vault.network;
  // Change always returns to the vault's OWN address -- never
  // caller-supplied. Mirrors psbt-binary.js's hardcoded
  // `change_address: vault.address` for the standard vault.
  const change_address = vault.address;
  const parent_keys = bp.parent_pubkeys ?? [];
  const kid_keys = bp.kid_pubkeys ?? [];
  const parents_together_quorum = bp.parents_together_quorum;
  const coparent_quorum = bp.coparent_quorum;
  const kids_with_parent_quorum = bp.kids_with_parent_quorum;
  const parent_solo_quorum = bp.parent_solo_quorum;
  const kids_decay_start_quorum = bp.kids_decay_start_quorum;
  const kids_decay_floor_quorum = bp.kids_decay_floor_quorum;
  const parent_solo_after = bp.parent_solo_after;
  const kids_decay_start_after = bp.kids_decay_start_after;
  const kids_decay_step_blocks = bp.kids_decay_step_blocks;
  const key_origins = bp.key_origins ?? [];

  if (!destination) return json(400, { error: 'Missing: destination' });
  // checkNumberBounds requires a real finite number first -- see
  // psbt-binary.js's identical fix comment (Kimi K3 scan Family D).
  if (!sweep) {
    const amountErr = checkNumberBounds(amount_sats, { field: 'amount_sats', min: 546, max: Number.MAX_SAFE_INTEGER, integer: true });
    if (amountErr) return json(400, { error: amountErr });
  }
  if (fee_rate != null) {
    const feeErr = checkNumberBounds(fee_rate, { field: 'fee_rate', min: MIN_FEE_RATE_SAT_VB, max: MAX_FEE_RATE_SAT_VB });
    if (feeErr) return json(400, { error: feeErr });
  }
  if (!BLOC_PATHS.has(path)) return json(400, { error: `Unknown path: ${path}` });
  if (path === 'kids_decay' && !quorum) {
    return json(400, { error: 'kids_decay requires a quorum (which decay rung to spend)' });
  }
  if (!parent_keys.length) return json(400, { error: 'Missing: parent_keys' });
  if (!kid_keys.length)    return json(400, { error: 'Missing: kid_keys' });

  // 2026-08-15 security audit: see compile.js's identical comment. Defense
  // in depth on the stored keys -- they should already be clean, but this
  // never assumes the DB side implicitly.
  for (const k of [...parent_keys, ...kid_keys]) {
    try {
      assertNotPrivateExtendedKey(k);
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

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
  // The leaf quorum for fee-sizing purposes: for kids_decay the caller's
  // own `quorum` IS the specific rung being spent through; every other
  // path has a single fixed quorum on the policy itself.
  const rate = fee_rate || await getFeeRate(network);
  const leafQuorum = path === 'kids_decay' ? quorum
    : path === 'parents_now' ? parents_together_quorum
    : path === 'parent_solo' ? parent_solo_quorum
    : 0; // coparent_kids reads both quorums directly inside estimateBlocInputVbytes
  const treeDepth = Math.ceil(Math.log2(Math.max(leafCountForBlocTree({
    kids_decay_start_quorum, kids_decay_floor_quorum,
  }), 2)));
  const inputVbytes = estimateBlocInputVbytes(
    { parent_keys, kid_keys, coparent_quorum, kids_with_parent_quorum },
    path, leafQuorum, treeDepth,
  );

  // sweep (2026-08-15, same fix as psbt-binary.js's standard-vault path):
  // send everything confirmed as one output with no change, computing
  // the exact fee for the real input count first, then deriving
  // amount_sats = totalIn - fee -- never a guessed amount with a
  // leftover that becomes an unwanted change output.
  let selected;
  let totalIn = 0;
  let finalFee;
  let amountSatsFinal;
  let hasChange;
  let changeVal = 0;

  if (sweep) {
    selected = confirmed;
    totalIn = selected.reduce((n, u) => n + u.value, 0);
    finalFee = estimateFee(selected.length, 1, rate, inputVbytes); // 1 output: destination only, no change
    amountSatsFinal = totalIn - finalFee;
    if (amountSatsFinal < 546) {
      return json(400, {
        ok: false,
        error: `Not enough confirmed balance to cover the network fee. Have ${totalIn} sats, need at least ${finalFee + 546}.`,
        confirmed_sats: totalIn,
      });
    }
    hasChange = false;
  } else {
    const estFee = estimateFee(1, 2, rate, inputVbytes);
    const sorted = [...confirmed].sort((a, b) => b.value - a.value);
    selected = [];
    for (const utxo of sorted) {
      selected.push(utxo);
      totalIn += utxo.value;
      if (totalIn >= amount_sats + estFee) break;
    }

    finalFee        = estimateFee(selected.length, 2, rate, inputVbytes);
    changeVal        = totalIn - amount_sats - finalFee;
    hasChange        = changeVal >= 546;
    amountSatsFinal  = amount_sats;

    if (totalIn < amount_sats + finalFee) {
      return json(400, {
        ok: false,
        error: `Insufficient funds. Need ${amount_sats + finalFee} sats confirmed, have ${totalIn}.`,
        confirmed_sats: totalIn,
      });
    }
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
        amount_sats: amountSatsFinal,
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
        amount_sats: amountSatsFinal,
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
