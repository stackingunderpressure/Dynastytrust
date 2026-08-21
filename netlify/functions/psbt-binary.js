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
import { MEMPOOL, mempoolFetch, getFeeRate } from './_chain.js';
import { checkNumberBounds, MIN_FEE_RATE_SAT_VB, MAX_FEE_RATE_SAT_VB } from './_numeric.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

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

// Which leaf a spend path actually signs through, and how many of the
// vault's keys sit in that leaf -- recovery reuses the founder keys
// (recovery_quorum falls back to founder_quorum) per the architecture doc.
// backup is a SEPARATE key set (027_backup_path.sql), never the founder
// keys -- unlike recovery, it's mutually exclusive with recovery on the
// same vault (see DynastyPolicy::has_backup, protocol repo).
function leafSignerCounts(vault, path) {
  switch (path) {
    case 'recovery':
      return { quorum: vault.recovery_quorum ?? vault.founder_quorum, total: (vault.founder_keys || []).length };
    case 'inheritance':
      return { quorum: vault.heir_quorum, total: (vault.heir_keys || []).length };
    case 'backup':
      return { quorum: vault.backup_quorum, total: (vault.backup_keys || []).length };
    case 'second_inheritance':
      return { quorum: vault.second_heir_quorum, total: (vault.second_heir_keys || []).length };
    case 'founders_now':
    default:
      return { quorum: vault.founder_quorum, total: (vault.founder_keys || []).length };
  }
}

// Number of leaves in this vault's taproot tree -- determines the taptree
// merkle path length baked into every input's control block. Not every
// vault has all three: a "Gift Locker" shape has no recovery/backup leaf,
// a "founders + backup only" shape (Tapit Circle) has no inheritance leaf
// at all. Count only what's actually configured rather than assuming the
// old fixed 3-leaf shape.
function leafCountForTree(vault) {
  let n = 1; // founders_now is always present
  if (vault.recovery_after > 0) n += 1;
  else if ((vault.backup_keys || []).length > 0 && vault.backup_quorum != null) n += 1;
  if ((vault.heir_keys || []).length > 0) n += 1;
  if ((vault.second_heir_keys || []).length > 0 && vault.second_heir_quorum != null
      && vault.second_inheritance_after != null) n += 1;
  return n;
}

// Generic leaf-list vault equivalents of leafSignerCounts/leafCountForTree
// above -- same fee-estimation role, but reading vault.leaves (migration
// 042) instead of the named founder/heir/etc columns. A decay-bearing
// leaf expands into (quorum - floor_quorum + 1) rungs at compile time
// (protocol::expand_decay), so its tree-depth contribution is counted the
// same way here; `path` naming a specific rung id ("heirs_1") falls back
// to the base leaf id (before the "_N" suffix) since the draft's own
// leaf list only ever stores one entry per leaf, not per rung.
function leafListSignerCounts(vault, path) {
  const leaves = vault.leaves || [];
  let leaf = leaves.find((l) => l.id === path);
  if (!leaf) {
    const base = path.replace(/_\d+$/, '');
    leaf = leaves.find((l) => l.id === base);
  }
  if (!leaf) return { quorum: 0, total: 0 };
  return { quorum: leaf.quorum, total: (leaf.keys || []).length };
}

function leafListCountForTree(vault) {
  const leaves = vault.leaves || [];
  let n = 0;
  for (const leaf of leaves) {
    if (leaf.decay && typeof leaf.decay.floor_quorum === 'number') {
      n += Math.max(1, leaf.quorum - leaf.decay.floor_quorum + 1);
    } else {
      n += 1;
    }
  }
  return Math.max(n, 1);
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
  // Generic leaf-list vault (migration 042): vault.leaves, when present,
  // is authoritative over the named founder/heir/etc columns, the same
  // way compiler/src/main.rs's psbt_binary treats req.leaves as
  // authoritative over its own named-field request fields.
  const isLeafList = Array.isArray(vault.leaves) && vault.leaves.length > 0;

  let founderPubkeys, heirPubkeys, consentPubkeys, backupPubkeys, secondHeirPubkeys;
  let leafListWire;
  try {
    if (isLeafList) {
      leafListWire = vault.leaves.map((leaf) => ({
        id: leaf.id,
        label: leaf.label || leaf.id,
        keys: (leaf.keys || []).map(toPubkeyHex),
        quorum: leaf.quorum,
        unlock: leaf.unlock,
        decay: leaf.decay ?? null,
      }));
      founderPubkeys = heirPubkeys = backupPubkeys = secondHeirPubkeys = [];
      consentPubkeys = (vault.consent_keys || []).map(toPubkeyHex);
    } else {
      founderPubkeys = (vault.founder_keys || []).map(toPubkeyHex);
      heirPubkeys = (vault.heir_keys || []).map(toPubkeyHex);
      consentPubkeys = (vault.consent_keys || []).map(toPubkeyHex);
      backupPubkeys = (vault.backup_keys || []).map(toPubkeyHex);
      secondHeirPubkeys = (vault.second_heir_keys || []).map(toPubkeyHex);
    }
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

  // Get fee rate and estimate. Size the input for the SPECIFIC leaf this
  // spend signs through (path), not a flat key-path guess -- a 2-of-3
  // founders leaf costs meaningfully more vbytes than a 1-of-1 leaf would,
  // and either is bigger than a plain key-path spend.
  const rate = fee_rate || await getFeeRate(network);
  const { quorum: leafQuorum, total: leafTotal } = isLeafList
    ? leafListSignerCounts(vault, path)
    : leafSignerCounts(vault, path);
  const treeDepth = Math.ceil(Math.log2(Math.max(isLeafList ? leafListCountForTree(vault) : leafCountForTree(vault), 2)));
  const inputVbytes = (leafQuorum > 0 && leafTotal > 0)
    ? estimateTapscriptInputVbytes(leafQuorum, leafTotal, treeDepth)
    : TR_INPUT_VBYTES; // fallback: leaf config missing/unexpected shape

  // Coin selection: explicit list if caller supplied selected_utxos
  // (coin-control from the UI), otherwise greedy largest-first -- except
  // for a real sweep, which always spends every confirmed UTXO (or the
  // coin-controlled subset, if given) as a single output with no change.
  //
  // sweep (2026-08-15, operator: "did max spend should be no change but
  // there was some back to wallet miscalculation") -- the frontend's old
  // "Max" button computed amount_sats itself by subtracting a flat
  // 2000-sat guess from the confirmed balance, then sent that as a
  // normal fixed-amount spend. Whenever the REAL fee (which depends on
  // exactly how many inputs get selected and the live fee rate) differed
  // from that guess -- routinely, since 2000 sats is not derived from
  // anything -- the leftover became an unwanted, unrequested change
  // output back to the vault. Sweep computes the exact fee for the exact
  // input count first, THEN derives amount_sats = totalIn - fee, so
  // there is nothing left over to become change by construction.
  let selected;
  let totalIn = 0;
  let finalFee;
  let amountSatsFinal;
  let hasChange;
  let changeVal = 0;

  if (sweep) {
    if (Array.isArray(selected_utxos) && selected_utxos.length > 0) {
      const key = (u) => `${u.txid}:${u.vout}`;
      const wanted = new Set(selected_utxos.map(key));
      selected = confirmed.filter(u => wanted.has(key(u)));
      if (selected.length !== selected_utxos.length) {
        return json(400, { error: "One or more selected UTXOs are unconfirmed or not found" });
      }
    } else {
      selected = confirmed;
    }
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
      body: JSON.stringify({
        inputs:            inputsWithScript,
        destination,
        amount_sats:       amountSatsFinal,
        fee_sats:          finalFee,
        change_address:    vault.address,
        network,
        // Pass vault policy params so compiler can attach tap_leaf_script
        // This is required for Coldcard/Passport/Keystone to sign correctly
        address_type:      vault.address_type || 'tr',
        // Fly compiler needs the intended leaf so it can set
        // tx.lock_time (After) or every input's nSequence (OlderThan).
        // Everything except an Immediate leaf requires one of the two to
        // match the leaf's own unlock -- see CLAUDE.md's timelock section.
        path,
        key_origins: keyOrigins,
        ...(isLeafList
          ? {
              // Generic leaf-list vault: forward the leaf list as-is,
              // authoritative over every named field below (which stays
              // absent here). Mirrors compiler/src/main.rs's own
              // req.leaves-present branch in psbt_binary.
              leaves: leafListWire,
              ...(consentPubkeys.length > 0 && vault.consent_quorum != null
                ? { consent_keys: consentPubkeys, consent_quorum: vault.consent_quorum }
                : {}),
            }
          : {
              founder_keys:      founderPubkeys,
              founder_quorum:    vault.founder_quorum,
              recovery_quorum:   vault.recovery_quorum ?? null,
              heir_keys:         heirPubkeys,
              heir_quorum:       vault.heir_quorum,
              recovery_after:    vault.recovery_after,
              inheritance_after: vault.inheritance_after,
              ...(consentPubkeys.length > 0 && vault.consent_quorum != null
                ? { consent_keys: consentPubkeys, consent_quorum: vault.consent_quorum }
                : {}),
              ...(backupPubkeys.length > 0 && vault.backup_quorum != null
                ? { backup_keys: backupPubkeys, backup_quorum: vault.backup_quorum }
                : {}),
              ...(secondHeirPubkeys.length > 0 && vault.second_heir_quorum != null && vault.second_inheritance_after != null
                ? {
                    second_heir_keys: secondHeirPubkeys,
                    second_heir_quorum: vault.second_heir_quorum,
                    second_inheritance_after: vault.second_inheritance_after,
                  }
                : {}),
            }),
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
      metadata: { destination, amount_sats: amountSatsFinal, fee_sats: finalFee, fee_rate: rate, input_count: selected.length, binary: true, path, sweep: !!sweep },
    });

    return json(200, {
      ok: true,
      psbt_hex: psbtData.psbt_hex,
      psbt_b64: psbtData.psbt_b64,
      summary: {
        vault_name:    vault.name,
        vault_address: vault.address,
        destination,
        amount_sats:   amountSatsFinal,
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
