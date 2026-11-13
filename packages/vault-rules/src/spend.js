// The rules for building a spend from a standard or path-builder vault,
// moved from netlify/functions/psbt-binary.js into pure functions so the
// website's server and the downloaded app run ONE copy (download slice,
// docs/download-and-run-build-note.md). Same order, same numbers, same
// messages; proven unchanged by scripts/test-vault-rules-spend.mjs.
//
// Pure: the caller fetches the vault's coins, the fee rate and each coin's
// scriptPubKey (from mempool.space on the website, from Bitcoin Core in the
// download), and sends `spendCompilerRequest` to the compiler.

// Taproot key-path input: 57.5 vbytes, output: 43 vbytes, overhead: 10.5.
// TR_INPUT_VBYTES is only correct for a plain single-key key-path spend.
// Every vault input here is a SCRIPT-PATH spend through a multi_a(Q,keys)
// tapscript leaf, which is meaningfully bigger; estimateTapscriptInputVbytes
// sizes that per leaf, and TR_INPUT_VBYTES stays only as the fallback when
// a vault's leaf shape can't be determined.
export const TR_INPUT_VBYTES = 57.5;
export const TR_OUTPUT_VBYTES = 43;
export const TX_OVERHEAD = 10.5;
export const DUST_SATS = 546;

// Which leaf a spend path signs through, and how many keys sit in it --
// recovery reuses the founder keys (recovery_quorum falls back to
// founder_quorum); backup is a SEPARATE key set, mutually exclusive with
// recovery on the same vault.
export function leafSignerCounts(vault, path) {
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

// Number of leaves in the taproot tree -- the merkle path length in every
// input's control block. Count only what is actually configured.
export function leafCountForTree(vault) {
  let n = 1; // founders_now is always present
  if (vault.recovery_after > 0) n += 1;
  else if ((vault.backup_keys || []).length > 0 && vault.backup_quorum != null) n += 1;
  if ((vault.heir_keys || []).length > 0) n += 1;
  if ((vault.second_heir_keys || []).length > 0 && vault.second_heir_quorum != null
      && vault.second_inheritance_after != null) n += 1;
  return n;
}

// Path-builder (leaf-list) equivalents. A decay leaf expands into
// (quorum - floor_quorum + 1) rungs at compile time; a rung id ("heirs_1")
// falls back to its base leaf id.
export function leafListSignerCounts(vault, path) {
  const leaves = vault.leaves || [];
  let leaf = leaves.find((l) => l.id === path);
  if (!leaf) {
    const base = path.replace(/_\d+$/, '');
    leaf = leaves.find((l) => l.id === base);
  }
  if (!leaf) return { quorum: 0, total: 0 };
  // Must-sign keys each add one signature and one key to the script.
  const must = (leaf.required_keys || []).length;
  return { quorum: leaf.quorum + must, total: (leaf.keys || []).length + must };
}

export function leafListCountForTree(vault) {
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

// Size a script-path (tapscript leaf) taproot input: one witness item per
// key slot (a 64-byte signature + 1-byte length per signer, 1 empty byte per
// non-signer), the leaf script, and a control block (33-byte internal key +
// 1 version byte + 32 bytes per tree level), witness bytes at 1/4 weight.
export function estimateTapscriptInputVbytes(quorum, total, treeDepth) {
  const leafScript   = 33 * total + 2;
  const controlBlock = 33 + 1 + 32 * treeDepth;
  const witnessBytes =
    quorum * 65 +
    Math.max(total - quorum, 0) * 1 +
    (leafScript + 3) +
    (controlBlock + 3) +
    1;
  const baseInput = 41; // outpoint(36) + sequence(4) + empty scriptSig varint(1)
  return baseInput + witnessBytes / 4;
}

export function estimateFee(numInputs, numOutputs, feeRate, inputVbytes = TR_INPUT_VBYTES) {
  return Math.ceil((TX_OVERHEAD + numInputs * inputVbytes + numOutputs * TR_OUTPUT_VBYTES) * feeRate);
}

/** The size of one input spending this vault through `path`. */
export function inputVbytesFor(vault, path) {
  const isLeafList = Array.isArray(vault.leaves) && vault.leaves.length > 0;
  const { quorum: leafQuorum, total: leafTotal } = isLeafList
    ? leafListSignerCounts(vault, path)
    : leafSignerCounts(vault, path);
  const treeDepth = Math.ceil(Math.log2(Math.max(isLeafList ? leafListCountForTree(vault) : leafCountForTree(vault), 2)));
  return (leafQuorum > 0 && leafTotal > 0)
    ? estimateTapscriptInputVbytes(leafQuorum, leafTotal, treeDepth)
    : TR_INPUT_VBYTES;
}

/**
 * The vault's keys as the compiler wants them (33-byte pubkey hex). Stored
 * xpubs become their /0/0 child via `pubkeyFromXpub`; a 66-char entry is
 * already a pubkey. A path-builder vault's `leaves` are authoritative over
 * the named columns. Throws if an xpub cannot be read.
 */
export function spendKeys(vault, pubkeyFromXpub) {
  const toPubkeyHex = (k) => {
    if (typeof k !== 'string') return k;
    if (k.length === 66) return k;
    return pubkeyFromXpub(k);
  };
  const isLeafList = Array.isArray(vault.leaves) && vault.leaves.length > 0;
  if (isLeafList) {
    return {
      isLeafList,
      leafListWire: vault.leaves.map((leaf) => ({
        id: leaf.id,
        label: leaf.label || leaf.id,
        keys: (leaf.keys || []).map(toPubkeyHex),
        quorum: leaf.quorum,
        unlock: leaf.unlock,
        decay: leaf.decay ?? null,
        // Must be forwarded or the compiler rebuilds a DIFFERENT tree and
        // refuses the vault's own address as change.
        ...((leaf.required_keys || []).length > 0 ? { required_keys: leaf.required_keys.map(toPubkeyHex) } : {}),
      })),
      founderPubkeys: [], heirPubkeys: [], backupPubkeys: [], secondHeirPubkeys: [],
      consentPubkeys: (vault.consent_keys || []).map(toPubkeyHex),
    };
  }
  return {
    isLeafList,
    founderPubkeys: (vault.founder_keys || []).map(toPubkeyHex),
    heirPubkeys: (vault.heir_keys || []).map(toPubkeyHex),
    consentPubkeys: (vault.consent_keys || []).map(toPubkeyHex),
    backupPubkeys: (vault.backup_keys || []).map(toPubkeyHex),
    secondHeirPubkeys: (vault.second_heir_keys || []).map(toPubkeyHex),
  };
}

/**
 * Pick the coins and work out amount, fee and change. `confirmed` is the
 * vault's CONFIRMED coins ({txid, vout, value}). A sweep spends every
 * confirmed coin (or the chosen subset) to one output with no change: the
 * exact fee for the exact input count comes first, then amount = in - fee.
 * Otherwise largest-first (or the chosen coins). Change too small to keep
 * (1-545 sats) joins the fee, as the compiler does -- reported as such, or
 * the phone's real-fee check refuses to sign.
 * Returns { ok:false, status, body } or { ok:true, selected, totalIn,
 * finalFee, amountSatsFinal, hasChange, changeVal }.
 */
export function selectCoins({ confirmed, amount_sats, sweep, selected_utxos, rate, inputVbytes }) {
  let selected;
  let totalIn = 0;
  let finalFee;
  let amountSatsFinal;
  let hasChange;
  let changeVal = 0;
  const pickChosen = () => {
    const key = (u) => `${u.txid}:${u.vout}`;
    const wanted = new Set(selected_utxos.map(key));
    return confirmed.filter(u => wanted.has(key(u)));
  };
  const chosenGiven = Array.isArray(selected_utxos) && selected_utxos.length > 0;

  if (sweep) {
    if (chosenGiven) {
      selected = pickChosen();
      if (selected.length !== selected_utxos.length) {
        return { ok: false, status: 400, body: { error: "One or more selected UTXOs are unconfirmed or not found" } };
      }
    } else {
      selected = confirmed;
    }
    totalIn = selected.reduce((n, u) => n + u.value, 0);
    finalFee = estimateFee(selected.length, 1, rate, inputVbytes); // destination only, no change
    amountSatsFinal = totalIn - finalFee;
    if (amountSatsFinal < DUST_SATS) {
      return { ok: false, status: 400, body: {
        ok: false,
        error: `Not enough confirmed balance to cover the network fee. Have ${totalIn} sats, need at least ${finalFee + DUST_SATS}.`,
        confirmed_sats: totalIn,
      } };
    }
    hasChange = false;
  } else {
    const estFee = estimateFee(1, 2, rate, inputVbytes);
    if (chosenGiven) {
      selected = pickChosen();
      if (selected.length !== selected_utxos.length) {
        return { ok: false, status: 400, body: { error: "One or more selected UTXOs are unconfirmed or not found" } };
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
    finalFee  = estimateFee(selected.length, 2, rate, inputVbytes);
    changeVal = totalIn - amount_sats - finalFee;
    hasChange = changeVal >= DUST_SATS;
    // Only positive change: a shortfall must still reach the refusal below.
    if (!hasChange && changeVal > 0) { finalFee += changeVal; changeVal = 0; }
    amountSatsFinal = amount_sats;
    if (totalIn < amount_sats + finalFee) {
      return { ok: false, status: 400, body: {
        ok: false,
        error: `Insufficient funds. Need ${amount_sats + finalFee} sats confirmed, have ${totalIn}.`,
        confirmed_sats: totalIn,
      } };
    }
  }
  return { ok: true, selected, totalIn, finalFee, amountSatsFinal, hasChange, changeVal };
}

/** The compiler request (POST /psbt-binary). Change always returns to the
 *  vault's own address. */
export function spendCompilerRequest(vault, keys, { inputs, destination, amountSatsFinal, finalFee, network, path, keyOrigins }) {
  return {
    inputs,
    destination,
    amount_sats:       amountSatsFinal,
    fee_sats:          finalFee,
    change_address:    vault.address,
    network,
    address_type:      vault.address_type || 'tr',
    path,
    key_origins: keyOrigins,
    ...(keys.isLeafList
      ? {
          leaves: keys.leafListWire,
          ...(keys.consentPubkeys.length > 0 && vault.consent_quorum != null
            ? { consent_keys: keys.consentPubkeys, consent_quorum: vault.consent_quorum }
            : {}),
        }
      : {
          founder_keys:      keys.founderPubkeys,
          founder_quorum:    vault.founder_quorum,
          recovery_quorum:   vault.recovery_quorum ?? null,
          heir_keys:         keys.heirPubkeys,
          heir_quorum:       vault.heir_quorum,
          recovery_after:    vault.recovery_after,
          inheritance_after: vault.inheritance_after,
          ...(keys.consentPubkeys.length > 0 && vault.consent_quorum != null
            ? { consent_keys: keys.consentPubkeys, consent_quorum: vault.consent_quorum }
            : {}),
          ...(keys.backupPubkeys.length > 0 && vault.backup_quorum != null
            ? { backup_keys: keys.backupPubkeys, backup_quorum: vault.backup_quorum }
            : {}),
          ...(keys.secondHeirPubkeys.length > 0 && vault.second_heir_quorum != null && vault.second_inheritance_after != null
            ? {
                second_heir_keys: keys.secondHeirPubkeys,
                second_heir_quorum: vault.second_heir_quorum,
                second_inheritance_after: vault.second_inheritance_after,
              }
            : {}),
        }),
  };
}

/** What the person is shown before signing (and the phone re-checks). */
export function spendSummary(vault, picked, { destination, rate, network, path }) {
  return {
    vault_name:    vault.name,
    vault_address: vault.address,
    destination,
    amount_sats:   picked.amountSatsFinal,
    fee_sats:      picked.finalFee,
    change_sats:   picked.hasChange ? picked.changeVal : 0,
    fee_rate:      rate,
    input_count:   picked.selected.length,
    total_in_sats: picked.totalIn,
    network,
    path,
  };
}
