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
import { recordEvent } from './_ledger.js';
import { getSupabaseAdmin } from './_supabase.js';
import { pubkeyFromXpub } from './_xpub.js';
import { MEMPOOL, mempoolFetch, getFeeRate } from './_chain.js';
import { checkNumberBounds, MIN_FEE_RATE_SAT_VB, MAX_FEE_RATE_SAT_VB } from './_numeric.js';
import { spendKeys, inputVbytesFor, selectCoins, spendCompilerRequest, spendSummary } from '../../packages/vault-rules/src/spend.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

// The spend rules -- input size and fee estimates, keys for the compiler,
// coin selection, the compiler request and the summary -- are ONE copy in
// packages/vault-rules, shared with the downloaded app
// (scripts/test-vault-rules-spend.mjs holds this function to its recorded
// behaviour).

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { vault_id, destination, amount_sats, fee_rate, path = 'founders_now', selected_utxos, sweep } = body;
  if (!vault_id)    return json(400, { error: 'Missing: vault_id' });
  if (!destination) return json(400, { error: 'Missing: destination' });
  // checkNumberBounds requires a real finite number before comparing --
  // the previous inline checks (`!x`, `x < MIN || x > MAX`) let NaN,
  // Infinity, and non-numeric strings slip through silently, since
  // every one of those comparisons evaluates false for them (Kimi K3
  // scan Family D).
  if (!sweep) {
    const amountErr = checkNumberBounds(amount_sats, { field: 'amount_sats', min: 546, max: Number.MAX_SAFE_INTEGER, integer: true });
    if (amountErr) return json(400, { error: amountErr });
  }
  if (fee_rate != null) {
    const feeErr = checkNumberBounds(fee_rate, { field: 'fee_rate', min: MIN_FEE_RATE_SAT_VB, max: MAX_FEE_RATE_SAT_VB });
    if (feeErr) return json(400, { error: feeErr });
  }

  // Load vault. Any active member may build a PSBT, not just the
  // owner -- same membership check proposals.js GET/PATCH/POST use.
  const supabase = getSupabaseAdmin();
  const { data: vault, error } = await supabase
    .from('vaults')
    .select('id, name, address, network, descriptor, address_type, recovery_after, inheritance_after, recovery_quorum, founder_quorum, heir_quorum, founder_keys, heir_keys, consent_keys, consent_quorum, protector_keys, protector_quorum, protector_after, backup_keys, backup_quorum, second_heir_keys, second_heir_quorum, second_inheritance_after, key_origins, leaves')
    .eq('id', vault_id)
    .maybeSingle();

  if (error || !vault) return json(404, { error: 'Vault not found' });

  const { data: membership } = await supabase
    .from('vault_members')
    .select('id')
    .eq('vault_id', vault_id)
    .eq('user_id', u.userId)
    .eq('status', 'active')
    .maybeSingle();
  if (!membership) return json(403, { error: 'Not a member of this vault' });

  // Stored xpubs become their /0/0 child pubkey so tap_scripts match what
  // the browser signs against; a path-builder vault's leaves are
  // authoritative over the named columns.
  let keys;
  try {
    keys = spendKeys(vault, pubkeyFromXpub);
  } catch (e) {
    return json(500, { error: 'Could not derive /0/0 pubkey from vault xpubs: ' + e.message });
  }

  // BIP32 origins for hardware-wallet compatibility (2026-08-06 fix --
  // operator finding: "hardware wallets won't let you sign our
  // tapscripts"). Every PSBT built here already attaches tap_internal_key
  // + tap_scripts, which is enough for the browser and Tapit signers
  // (both match their own key by searching the leaf script bytes). A real
  // hardware wallet follows BIP371 strictly and only signs for a key it
  // can positively match via tap_key_origins (pubkey -> fingerprint +
  // full derivation path + which leaf hash it may sign for) -- without
  // that field it has nothing to match and correctly refuses to sign.
  // vault_members already carries fingerprint + derivation_path per
  // signer (the same values that feed the Nunchuk-compatible descriptor);
  // this was simply never forwarded past this function. derivation_path
  // is stored as the ACCOUNT-level path (e.g. "m/48'/1'/0'/2'") to match
  // descriptor-keys.ts's convention -- append /0/0 for the specific
  // receive-chain child every leaf script actually embeds.
  //
  // Prefer vault.key_origins (2026-08-12 fix): a direct_keys-compiled
  // vault -- a single owner bringing every key themselves -- never gets
  // a vault_members row per key (that table is one row per HUMAN
  // signer, unique on (vault_id, user_id), which can't represent "one
  // owner, several keys"), so the vault_members lookup below always
  // silently returned empty for those vaults. vaults-compile.js now
  // writes key_origins directly onto the vault row for both compile
  // paths; fall back to the vault_members lookup only for older rows
  // compiled before that column existed.
  let keyOrigins = vault.key_origins || [];
  if (!keyOrigins.length) {
    const { data: signers } = await supabase
      .from('vault_members')
      .select('pubkey, fingerprint, derivation_path')
      .eq('vault_id', vault_id)
      .eq('status', 'active');
    keyOrigins = (signers || [])
      .filter((m) => m.pubkey && m.fingerprint && m.derivation_path)
      .map((m) => ({
        pubkey: m.pubkey,
        fingerprint: m.fingerprint,
        derivation_path: m.derivation_path.replace(/\/+$/, '') + '/0/0',
      }));
  }

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

  // Fee rate, then size the input for the SPECIFIC leaf this spend signs
  // through (path), and pick the coins.
  const rate = fee_rate || await getFeeRate(network);
  const inputVbytes = inputVbytesFor(vault, path);
  const picked = selectCoins({ confirmed, amount_sats, sweep, selected_utxos, rate, inputVbytes });
  if (!picked.ok) return json(picked.status, picked.body);
  const { selected, totalIn, finalFee, amountSatsFinal, hasChange, changeVal } = picked;

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

  // Bail loudly if any prevout scriptPubKey could not be fetched -- an
  // empty one yields a malformed witness_utxo that only fails later at
  // sign/finalize with an opaque error. Matches psbt-binary-bloc.js /
  // psbt-binary-tranche.js's identical guard, missing here until now.
  const missingSpk = inputsWithScript.find((i) => !i.script_pubkey);
  if (missingSpk) {
    return json(502, {
      error: `Could not fetch the scriptPubKey for input ${missingSpk.txid}:${missingSpk.vout}. Try again in a moment.`,
    });
  }

  // Build binary PSBT via Rust compiler
  if (!COMPILER_URL) {
    // Fallback: return JSON PSBT structure for manual import
    return json(200, {
      ok: true,
      fallback: true,
      message: 'COMPILER_URL not set — returning JSON PSBT. Deploy compiler for binary PSBT.',
      psbt_json: { inputs: inputsWithScript, destination, amount_sats: amountSatsFinal, fee_sats: finalFee, change_sats: hasChange ? changeVal : 0 },
      summary: { vault_name: vault.name, vault_address: vault.address, destination, amount_sats: amountSatsFinal, fee_sats: finalFee, fee_rate: rate, input_count: selected.length, total_in_sats: totalIn, network },
    });
  }

  try {
    const compilerRes = await fetch(`${COMPILER_URL.replace(/\/$/, '')}/psbt-binary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
      },
      body: JSON.stringify(spendCompilerRequest(vault, keys, {
        inputs: inputsWithScript, destination, amountSatsFinal, finalFee, network, path, keyOrigins,
      })),
    });

    const psbtData = await compilerRes.json();
    if (!compilerRes.ok || !psbtData.ok) {
      throw new Error(psbtData.error || `Compiler error: ${compilerRes.status}`);
    }

    // Log event
    await recordEvent(supabase, {
      vault_id: vault.id,
      user_id:  u.userId,
      event_type: 'psbt_generated',
      metadata: { destination, amount_sats: amountSatsFinal, fee_sats: finalFee, fee_rate: rate, input_count: selected.length, binary: true, path, sweep: !!sweep },
    });

    return json(200, {
      ok: true,
      psbt_hex: psbtData.psbt_hex,
      psbt_b64: psbtData.psbt_b64,
      summary: spendSummary(vault, picked, { destination, rate, network, path }),
    });

  } catch (err) {
    console.error('PSBT binary error:', err);
    return json(502, { error: 'Compiler error: ' + err.message });
  }
}
