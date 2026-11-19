//! PoC: ranged (BIP-389 multipath `<0;1>/*`) vault descriptors.
//!
//! The policy is compiled ONCE (the existing build_leaf_multileaf, with any
//! concrete keys) to get its miniscript template; each key is then replaced by
//! its `[fp/path]xpub/<0;1>/*` origin expression. Every receive (branch 0) and
//! change (branch 1) address is plain descriptor derivation after that -- no
//! per-index policy compile. The internal key stays the fixed BIP-341 NUMS
//! x-only point at every index (it has no wildcard), so key-path stays
//! unspendable for every address.
use std::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::psbt::Psbt;
use bitcoin::{Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
use miniscript::descriptor::{DefiniteDescriptorKey, Descriptor, DescriptorPublicKey};
use miniscript::psbt::PsbtExt;

pub struct KeyExpr {
    /// The concrete pubkey hex the template was compiled with.
    pub template_pubkey: String,
    pub fingerprint: String,
    /// Account path, e.g. m/48'/1'/0'/2'
    pub account_path: String,
    pub xpub: String,
}

pub fn ranged_from_template(template: &str, keys: &[KeyExpr]) -> Result<String, String> {
    let mut out = template.to_string();
    for k in keys {
        if !out.contains(&k.template_pubkey) {
            return Err(format!("template does not contain key {}", k.template_pubkey));
        }
        let path = k.account_path.trim_start_matches("m/");
        out = out.replace(&k.template_pubkey, &format!("[{}/{}]{}/<0;1>/*", k.fingerprint, path, k.xpub));
    }
    // must parse as a multipath descriptor with exactly two branches
    let d = Descriptor::<DescriptorPublicKey>::from_str(&out).map_err(|e| e.to_string())?;
    let singles = d.into_single_descriptors().map_err(|e| e.to_string())?;
    if singles.len() != 2 {
        return Err(format!("expected 2 branches, got {}", singles.len()));
    }
    Ok(out)
}

fn branch(desc: &str, branch: usize) -> Result<Descriptor<DescriptorPublicKey>, String> {
    let d = Descriptor::<DescriptorPublicKey>::from_str(desc).map_err(|e| e.to_string())?;
    let mut s = d.into_single_descriptors().map_err(|e| e.to_string())?;
    if branch >= s.len() {
        return Err("no such branch".into());
    }
    Ok(s.swap_remove(branch))
}

pub fn definite(desc: &str, br: usize, index: u32) -> Result<Descriptor<DefiniteDescriptorKey>, String> {
    branch(desc, br)?.at_derivation_index(index).map_err(|e| e.to_string())
}

pub fn derive_addresses(desc: &str, network: Network, br: usize, start: u32, count: u32) -> Result<Vec<String>, String> {
    (start..start + count)
        .map(|i| Ok(definite(desc, br, i)?.address(network).map_err(|e| e.to_string())?.to_string()))
        .collect()
}

pub struct RangedInput {
    pub txid: String,
    pub vout: u32,
    pub value_sats: u64,
    pub branch: usize,
    pub index: u32,
}

/// Unsigned PSBT spending ranged-vault UTXOs. rust-miniscript's descriptor
/// updater fills tap_internal_key, tap_merkle_root, every tap leaf script +
/// control block and per-index tap_key_origins (fp/path/<branch>/<index>);
/// the change output gets the same (internal key, tap tree, key origins at
/// /1/<change_index>) so a signer can verify it against the descriptor.
pub fn build_ranged_spend_psbt(
    desc: &str,
    network: Network,
    inputs: &[RangedInput],
    destination: &str,
    amount_sats: u64,
    fee_sats: u64,
    change_index: u32,
    lock_time_height: u32,
) -> Result<Psbt, String> {
    let total: u64 = inputs.iter().map(|i| i.value_sats).sum();
    let change = total.checked_sub(amount_sats + fee_sats).ok_or("insufficient funds")?;
    let dest = Address::from_str(destination).map_err(|e| e.to_string())?
        .require_network(network).map_err(|e| e.to_string())?;
    let change_desc = definite(desc, 1, change_index)?;
    let mut outs = vec![TxOut { value: Amount::from_sat(amount_sats), script_pubkey: dest.script_pubkey() }];
    let has_change = change >= 546;
    if has_change {
        outs.push(TxOut { value: Amount::from_sat(change), script_pubkey: change_desc.script_pubkey() });
    }
    let tx = Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: if lock_time_height > 0 { LockTime::from_height(lock_time_height).map_err(|e| e.to_string())? } else { LockTime::ZERO },
        input: inputs.iter().map(|i| Ok(TxIn {
            previous_output: OutPoint { txid: Txid::from_str(&i.txid).map_err(|e| e.to_string())?, vout: i.vout },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::default(),
        })).collect::<Result<_, String>>()?,
        output: outs,
    };
    let mut psbt = Psbt::from_unsigned_tx(tx).map_err(|e| e.to_string())?;
    for (n, i) in inputs.iter().enumerate() {
        let d = definite(desc, i.branch, i.index)?;
        psbt.inputs[n].witness_utxo = Some(TxOut { value: Amount::from_sat(i.value_sats), script_pubkey: d.script_pubkey() });
        psbt.update_input_with_descriptor(n, &d).map_err(|e| format!("input {n}: {e:?}"))?;
    }
    if has_change {
        psbt.update_output_with_descriptor(1, &change_desc).map_err(|e| format!("change: {e:?}"))?;
    }
    Ok(psbt)
}
