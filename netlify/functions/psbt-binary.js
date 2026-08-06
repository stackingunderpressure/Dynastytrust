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
import { pubkeyFromXpub } from './_xpub.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

const MEMPOOL = {
  testnet: 'https://mempool.space/testnet/api',
  signet:  'https://mempool.space/signet/api',
  bitcoin: 'https://mempool.space/api',
};

// Taproot key-path input: 57.5 vbytes, output: 43 vbytes, overhead: 10.5.
// TR_INPUT_VBYTES is only correct for a plain single-key key-path spend.
// Every vault input here is a SCRIPT-PATH spend through a multi_a(Q,keys)
// tapscript leaf -- witness carries one stack item per key slot (a ~65-byte
// signature or an empty item), the full leaf script, and a control block --
// which is meaningfully bigger. estimateTapscriptInputVbytes below sizes
// that properly per leaf; TR_INPUT_VBYTES stays only as the last-resort
// fallback when a vault's leaf shape can't be determined (fee still gets
// estimated rather than the call failing outright).
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

// Which leaf a spend path actually signs through, and how many of the
// vault's keys sit in that leaf -- recovery reuses the founder keys
// (recovery_quorum falls back to founder_quorum) per the architecture doc.
function leafSignerCounts(vault, path) {
  switch (path) {
    case 'recovery':
      return { quorum: vault.recovery_quorum ?? vault.founder_quorum, total: (vault.founder_keys || []).length };
    case 'inheritance':
      return { quorum: vault.heir_quorum, total: (vault.heir_keys || []).length };
    case 'protector':
      return { quorum: vault.protector_quorum, total: (vault.protector_keys || []).length };
    case 'founders_now':
    default:
      return { quorum: vault.founder_quorum, total: (vault.founder_keys || []).length };
  }
}

// Number of leaves in this vault's taproot tree (founders_now + recovery +
// inheritance, plus protector if configured) -- determines the taptree
// merkle path length baked into every input's control block.
function leafCountForTree(vault) {
  return 3 + (vault.protector_quorum != null && vault.protector_after != null ? 1 : 0);
}

// Size a script-path (tapscript leaf) taproot input properly instead of
// assuming a plain key-path spend. multi_a(quorum, total) puts one witness
// stack item per key slot (a 64-byte Schnorr signature + 1-byte push length
// for each of the `quorum` signers, 1 empty byte for each non-signer),
// followed by the leaf script itself and a control block (33-byte internal
// key + 1 version/parity byte + 32 bytes per taptree level). Witness bytes
// get the standard 1/4 segwit weight discount.
function estimateTapscriptInputVbytes(quorum, total, treeDepth) {
  const leafScript   = 33 * total + 2; // n pubkey pushes + CHECKSIG/CHECKSIGADD chain + push-quorum + NUMEQUAL
  const controlBlock = 33 + 1 + 32 * treeDepth;
  const witnessBytes =
    quorum * 65 +                      // one Schnorr sig (+ push length) per required signer
    Math.max(total - quorum, 0) * 1 +  // one empty stack item per non-signing keyholder
    (leafScript + 3) +                 // leaf script + its length-prefix varint
    (controlBlock + 3) +               // control block + its length-prefix varint
    1;                                 // witness stack item-count varint
  const baseInput = 41; // outpoint(36) + sequence(4) + empty scriptSig varint(1)
  return baseInput + witnessBytes / 4;
}

function estimateFee(numInputs, numOutputs, feeRate, inputVbytes = TR_INPUT_VBYTES) {
  return Math.ceil((TX_OVERHEAD + numInputs * inputVbytes + numOutputs * TR_OUTPUT_VBYTES) * feeRate);
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { vault_id, destination, amount_sats, fee_rate, path = 'founders_now', selected_utxos } = body;
  if (!vault_id)    return json(400, { error: 'Missing: vault_id' });
  if (!destination) return json(400, { error: 'Missing: destination' });
  if (!amount_sats || amount_sats < 546) return json(400, { error: 'amount_sats must be >= 546' });

  // Load vault. Any active member may build a PSBT, not just the
  // owner -- same membership check proposals.js GET/PATCH/POST use.
  const supabase = getSupabaseAdmin();
  const { data: vault, error } = await supabase
    .from('vaults')
    .select('id, name, address, network, descriptor, address_type, recovery_after, inheritance_after, recovery_quorum, founder_quorum, heir_quorum, founder_keys, heir_keys, consent_keys, consent_quorum, protector_keys, protector_quorum, protector_after')
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

  // vault.founder_keys / heir_keys / consent_keys are stored as
  // xpubs; the Fly.io /psbt-binary leaf-script rebuilder expects
  // 33-byte compressed pubkey hex (parse_pubkeys). Derive the /0/0
  // child pubkey here so tap_scripts matches what the browser signs
  // against. Legacy rows may already hold pubkey hex (66 chars) --
  // those pass through unchanged.
  const toPubkeyHex = (k) => {
    if (typeof k !== 'string') return k;
    if (k.length === 66) return k; // already pubkey hex
    return pubkeyFromXpub(k); // throws "Version mismatch" etc.
  };
  let founderPubkeys, heirPubkeys, consentPubkeys, protectorPubkeys;
  try {
    founderPubkeys = (vault.founder_keys || []).map(toPubkeyHex);
    heirPubkeys = (vault.heir_keys || []).map(toPubkeyHex);
    consentPubkeys = (vault.consent_keys || []).map(toPubkeyHex);
    protectorPubkeys = (vault.protector_keys || []).map(toPubkeyHex);
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
  const { data: signers } = await supabase
    .from('vault_members')
    .select('pubkey, fingerprint, derivation_path')
    .eq('vault_id', vault_id)
    .eq('status', 'active');
  const keyOrigins = (signers || [])
    .filter((m) => m.pubkey && m.fingerprint && m.derivation_path)
    .map((m) => ({
      pubkey: m.pubkey,
      fingerprint: m.fingerprint,
      derivation_path: m.derivation_path.replace(/\/+$/, '') + '/0/0',
    }));

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

  // Get fee rate and estimate. Size the input for the SPECIFIC leaf this
  // spend signs through (path), not a flat key-path guess -- a 2-of-3
  // founders leaf costs meaningfully more vbytes than a 1-of-1 leaf would,
  // and either is bigger than a plain key-path spend.
  const rate = fee_rate || await getFeeRate(network);
  const { quorum: leafQuorum, total: leafTotal } = leafSignerCounts(vault, path);
  const treeDepth = Math.ceil(Math.log2(Math.max(leafCountForTree(vault), 2)));
  const inputVbytes = (leafQuorum > 0 && leafTotal > 0)
    ? estimateTapscriptInputVbytes(leafQuorum, leafTotal, treeDepth)
    : TR_INPUT_VBYTES; // fallback: leaf config missing/unexpected shape
  const estFee = estimateFee(1, 2, rate, inputVbytes);

  // Coin selection: explicit list if caller supplied selected_utxos
  // (coin-control from the UI), otherwise greedy largest-first.
  let selected;
  let totalIn = 0;
  if (Array.isArray(selected_utxos) && selected_utxos.length > 0) {
    const key = (u) => `${u.txid}:${u.vout}`;
    const wanted = new Set(selected_utxos.map(key));
    selected = confirmed.filter(u => wanted.has(key(u)));
    if (selected.length !== selected_utxos.length) {
      return json(400, { error: "One or more selected UTXOs are unconfirmed or not found" });
    }
    totalIn = selected.reduce((n, u) => n + u.value, 0);
  } else {
    const sorted = [...confirmed].sort((a, b) => b.value - a.value);
    selected = [];
    for (const u of sorted) {
      selected.push(u);
      totalIn += u.value;
      if (totalIn >= amount_sats + estFee) break;
    }
  }

  const finalFee   = estimateFee(selected.length, 2, rate, inputVbytes);
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
        founder_keys:      founderPubkeys,
        founder_quorum:    vault.founder_quorum,
        recovery_quorum:   vault.recovery_quorum ?? null,
        heir_keys:         heirPubkeys,
        heir_quorum:       vault.heir_quorum,
        recovery_after:    vault.recovery_after,
        inheritance_after: vault.inheritance_after,
        // Fly compiler needs the intended leaf so it can set
        // tx.lock_time for CLTV-gated paths. Everything except
        // founders_now requires an absolute nLockTime that matches
        // the leaf's after(N).
        path,
        key_origins: keyOrigins,
        ...(consentPubkeys.length > 0 && vault.consent_quorum != null
          ? { consent_keys: consentPubkeys, consent_quorum: vault.consent_quorum }
          : {}),
        ...(protectorPubkeys.length > 0 && vault.protector_quorum != null && vault.protector_after != null
          ? {
              protector_keys: protectorPubkeys,
              protector_quorum: vault.protector_quorum,
              protector_after: vault.protector_after,
            }
          : {}),
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
