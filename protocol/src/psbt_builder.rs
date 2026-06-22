use bitcoin::absolute;
use bitcoin::address::Address;
use bitcoin::hex::FromHex;
use bitcoin::psbt::Psbt;
use bitcoin::taproot::LeafVersion;
use bitcoin::{
    Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid,
};
use crate::policy_compiler::{build_bloc_multileaf, DynastyBlocPolicy, BLOC_PATH_KIDS_DECAY};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use thiserror::Error;

/// Standard dust floor (sats). A change output below this is dropped
/// into the fee rather than created as a non-standard output.
pub const DUST_LIMIT_SATS: u64 = 546;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VaultUTXO {
    pub txid: String,
    pub vout: u32,
    pub value: u64,
    pub script_pubkey: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpendRequest {
    pub utxos: Vec<VaultUTXO>,
    pub amount: u64,
    pub fee: u64,
    pub destination: String,
    pub change_address: String,
    pub network: String,
}

#[derive(Error, Debug)]
pub enum PsbtError {
    #[error("insufficient funds: inputs={inputs} need={need}")]
    InsufficientFunds { inputs: u64, need: u64 },
    #[error("invalid txid: {0}")]
    InvalidTxid(String),
    #[error("invalid address: {0}")]
    InvalidAddress(String),
    #[error("invalid network: {0}")]
    InvalidNetwork(String),
    #[error("invalid script_pubkey: {0}")]
    InvalidScriptPubKey(String),
    #[error("psbt error: {0}")]
    Psbt(String),
    #[error("unknown spend path: {0}")]
    UnknownPath(String),
}

pub fn build_spend_psbt(spend: SpendRequest) -> Result<Psbt, PsbtError> {
    let network = parse_network(&spend.network)?;

    let destination = Address::from_str(&spend.destination)
        .map_err(|e| PsbtError::InvalidAddress(format!("destination: {e}")))?
        .require_network(network)
        .map_err(|e| PsbtError::InvalidAddress(format!("destination network mismatch: {e}")))?;

    let change_address = Address::from_str(&spend.change_address)
        .map_err(|e| PsbtError::InvalidAddress(format!("change_address: {e}")))?
        .require_network(network)
        .map_err(|e| PsbtError::InvalidAddress(format!("change network mismatch: {e}")))?;

    let selected = select_coins(spend.utxos, spend.amount, spend.fee)?;
    let inputs_value: u64 = selected.iter().map(|u| u.value).sum();

    let need = spend
        .amount
        .checked_add(spend.fee)
        .ok_or(PsbtError::InsufficientFunds {
            inputs: inputs_value,
            need: u64::MAX,
        })?;

    let change_value = inputs_value
        .checked_sub(need)
        .ok_or(PsbtError::InsufficientFunds {
            inputs: inputs_value,
            need,
        })?;

    let has_change = change_value > 0;

    let mut inputs = Vec::with_capacity(selected.len());
    for u in &selected {
        let txid = Txid::from_str(&u.txid).map_err(|_| PsbtError::InvalidTxid(u.txid.clone()))?;

        inputs.push(TxIn {
            previous_output: OutPoint { txid, vout: u.vout },
            script_sig: ScriptBuf::new(),
            // Match compiler/src/main.rs: BIP 125 replaceable
            // sequence so RBF stays enabled and miniscript's
            // finalizer accepts the witness.
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: bitcoin::Witness::default(),
        });
    }

    let mut outputs = Vec::with_capacity(if has_change { 2 } else { 1 });

    outputs.push(TxOut {
        value: Amount::from_sat(spend.amount),
        script_pubkey: destination.script_pubkey(),
    });

    if has_change {
        outputs.push(TxOut {
            value: Amount::from_sat(change_value),
            script_pubkey: change_address.script_pubkey(),
        });
    }

    let tx = Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: absolute::LockTime::ZERO,
        input: inputs,
        output: outputs,
    };

    let mut psbt = Psbt::from_unsigned_tx(tx)
        .map_err(|e: bitcoin::psbt::Error| PsbtError::Psbt(e.to_string()))?;

    for (i, utxo) in selected.iter().enumerate() {
        psbt.inputs[i].witness_utxo = Some(TxOut {
            value: Amount::from_sat(utxo.value),
            script_pubkey: parse_script_pubkey(&utxo.script_pubkey)?,
        });
    }

    Ok(psbt)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BlocSpendRequest {
    pub utxos: Vec<VaultUTXO>,
    pub amount: u64,
    pub fee: u64,
    pub destination: String,
    pub change_address: String,
    pub network: String,
    /// Which Bloc leaf to spend via (one of the BLOC_PATH_* ids).
    pub path: String,
    /// Disambiguates decay rungs (the kid quorum of the chosen rung).
    /// Ignored for the non-decay paths.
    #[serde(default)]
    pub quorum: usize,
}

/// Build an unsigned PSBT that spends a Dynasty Bloc UTXO via a specific
/// leaf. Reconstructs the tree from `build_bloc_multileaf` (the single
/// source of truth), selects the leaf for `path` (+ `quorum` for decay
/// rungs), stamps the leaf's absolute CLTV height as the tx lock_time,
/// and attaches tap_internal_key + tap_scripts (control block + leaf)
/// so any hardware wallet / the browser signer can produce a script-path
/// signature. The control block proves against the SAME spend_info the
/// address was derived from, so finalize cannot hit a merkle mismatch.
pub fn build_bloc_spend_psbt(
    policy: &DynastyBlocPolicy,
    req: BlocSpendRequest,
) -> Result<Psbt, PsbtError> {
    let network = parse_network(&req.network)?;

    let tree = build_bloc_multileaf(policy)
        .map_err(|e| PsbtError::Psbt(format!("bloc tree: {e}")))?;

    // Decay rungs share a path id, so match on quorum too. Other paths
    // are unique by id.
    let leaf = tree
        .leaves
        .iter()
        .find(|l| l.path == req.path && (l.path != BLOC_PATH_KIDS_DECAY || l.quorum == req.quorum))
        .ok_or_else(|| {
            let suffix = if req.path == BLOC_PATH_KIDS_DECAY {
                format!(" quorum {}", req.quorum)
            } else {
                String::new()
            };
            PsbtError::UnknownPath(format!("{}{suffix}", req.path))
        })?;

    let destination = Address::from_str(&req.destination)
        .map_err(|e| PsbtError::InvalidAddress(format!("destination: {e}")))?
        .require_network(network)
        .map_err(|e| PsbtError::InvalidAddress(format!("destination network mismatch: {e}")))?;

    let change_address = Address::from_str(&req.change_address)
        .map_err(|e| PsbtError::InvalidAddress(format!("change_address: {e}")))?
        .require_network(network)
        .map_err(|e| PsbtError::InvalidAddress(format!("change network mismatch: {e}")))?;

    let selected = select_coins(req.utxos, req.amount, req.fee)?;
    let inputs_value: u64 = selected.iter().map(|u| u.value).sum();
    let need = req
        .amount
        .checked_add(req.fee)
        .ok_or(PsbtError::InsufficientFunds { inputs: inputs_value, need: u64::MAX })?;
    let change_value = inputs_value
        .checked_sub(need)
        .ok_or(PsbtError::InsufficientFunds { inputs: inputs_value, need })?;
    // Dust floor: a change output below the dust limit is non-standard
    // and can make the tx unbroadcastable. Drop sub-dust change into the
    // fee instead -- matching the 546-sat floor the netlify proxy and the
    // founders/heirs psbt-binary path both use, so the on-screen summary
    // (change=0) and the actual PSBT agree.
    let has_change = change_value >= DUST_LIMIT_SATS;

    // CLTV path: immediate leaves leave lock_time at 0; timelocked
    // leaves stamp their absolute height so miniscript can satisfy the
    // leaf's `after(N)` at finalize.
    let lock_time = if leaf.locktime > 0 {
        absolute::LockTime::from_height(leaf.locktime)
            .map_err(|e| PsbtError::Psbt(format!("bad lock_time {}: {e}", leaf.locktime)))?
    } else {
        absolute::LockTime::ZERO
    };

    let mut inputs = Vec::with_capacity(selected.len());
    for u in &selected {
        let txid = Txid::from_str(&u.txid).map_err(|_| PsbtError::InvalidTxid(u.txid.clone()))?;
        inputs.push(TxIn {
            previous_output: OutPoint { txid, vout: u.vout },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: bitcoin::Witness::default(),
        });
    }

    let mut outputs = Vec::with_capacity(if has_change { 2 } else { 1 });
    outputs.push(TxOut {
        value: Amount::from_sat(req.amount),
        script_pubkey: destination.script_pubkey(),
    });
    if has_change {
        outputs.push(TxOut {
            value: Amount::from_sat(change_value),
            script_pubkey: change_address.script_pubkey(),
        });
    }

    let tx = Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time,
        input: inputs,
        output: outputs,
    };

    let mut psbt = Psbt::from_unsigned_tx(tx)
        .map_err(|e: bitcoin::psbt::Error| PsbtError::Psbt(e.to_string()))?;

    let script_ver = (leaf.leaf_script.clone(), LeafVersion::TapScript);
    let control_block = tree
        .spend_info
        .control_block(&script_ver)
        .ok_or_else(|| PsbtError::Psbt("no control block for selected leaf".into()))?;

    for (i, utxo) in selected.iter().enumerate() {
        psbt.inputs[i].witness_utxo = Some(TxOut {
            value: Amount::from_sat(utxo.value),
            script_pubkey: parse_script_pubkey(&utxo.script_pubkey)?,
        });
        psbt.inputs[i].tap_internal_key = Some(tree.internal_key);
        psbt.inputs[i].tap_scripts.insert(control_block.clone(), script_ver.clone());
    }

    Ok(psbt)
}

pub fn select_coins(
    mut utxos: Vec<VaultUTXO>,
    amount: u64,
    fee: u64,
) -> Result<Vec<VaultUTXO>, PsbtError> {
    let target = amount
        .checked_add(fee)
        .ok_or(PsbtError::InsufficientFunds {
            inputs: 0,
            need: u64::MAX,
        })?;

    utxos.sort_by(|a, b| b.value.cmp(&a.value));

    let mut selected: Vec<VaultUTXO> = Vec::new();
    let mut total: u64 = 0;

    for u in utxos {
        total = total.saturating_add(u.value);
        selected.push(u);
        if total >= target {
            return Ok(selected);
        }
    }

    Err(PsbtError::InsufficientFunds {
        inputs: total,
        need: target,
    })
}

fn parse_network(s: &str) -> Result<Network, PsbtError> {
    match s.to_lowercase().as_str() {
        "bitcoin" | "mainnet" | "main" => Ok(Network::Bitcoin),
        "testnet" | "test" => Ok(Network::Testnet),
        "signet" => Ok(Network::Signet),
        "regtest" => Ok(Network::Regtest),
        other => Err(PsbtError::InvalidNetwork(other.to_string())),
    }
}

fn parse_script_pubkey(hex_str: &str) -> Result<ScriptBuf, PsbtError> {
    let bytes = Vec::<u8>::from_hex(hex_str)
        .map_err(|e| PsbtError::InvalidScriptPubKey(format!("{hex_str}: {e}")))?;
    Ok(ScriptBuf::from_bytes(bytes))
}

#[cfg(test)]
mod bloc_psbt_tests {
    use super::*;
    use crate::policy_compiler::{compile_dynasty_bloc_tr_multileaf, DynastyBlocPolicy};
    use bitcoin::PublicKey;

    fn sample() -> DynastyBlocPolicy {
        let p = |s: &str| PublicKey::from_str(s).unwrap();
        DynastyBlocPolicy {
            parent_keys: vec![
                p("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97"),
                p("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569"),
            ],
            parents_together_quorum: 2,
            coparent_quorum: 1,
            kid_keys: vec![
                p("03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34"),
                p("025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"),
                p("03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe"),
                p("02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"),
            ],
            kids_with_parent_quorum: 4,
            parent_solo_after: 100_000,
            parent_solo_quorum: 1,
            kids_decay_start_after: 200_000,
            kids_decay_step_blocks: 52_560,
            kids_decay_start_quorum: 4,
            kids_decay_floor_quorum: 1,
        }
    }

    // Build a mock UTXO sitting at the vault's own address, plus a
    // self-spend back to it, so we can build a PSBT with no network.
    fn request(path: &str, quorum: usize) -> (DynastyBlocPolicy, BlocSpendRequest) {
        let policy = sample();
        let compiled = compile_dynasty_bloc_tr_multileaf(policy.clone(), Network::Testnet).unwrap();
        let spk_hex = hex::encode(compiled.address.script_pubkey().as_bytes());
        let addr = compiled.address.to_string();
        let req = BlocSpendRequest {
            utxos: vec![VaultUTXO {
                txid: "0000000000000000000000000000000000000000000000000000000000000001".into(),
                vout: 0,
                value: 100_000,
                script_pubkey: spk_hex,
            }],
            amount: 50_000,
            fee: 1_000,
            destination: addr.clone(),
            change_address: addr,
            network: "testnet".into(),
            path: path.into(),
            quorum,
        };
        (policy, req)
    }

    #[test]
    fn parents_now_has_zero_locktime_and_tap_scripts() {
        let (policy, req) = request(crate::policy_compiler::BLOC_PATH_PARENTS_NOW, 0);
        let psbt = build_bloc_spend_psbt(&policy, req).unwrap();
        assert_eq!(psbt.unsigned_tx.lock_time, absolute::LockTime::ZERO);
        assert_eq!(psbt.inputs.len(), 1);
        assert!(!psbt.inputs[0].tap_scripts.is_empty(), "leaf script must be attached");
        assert!(psbt.inputs[0].tap_internal_key.is_some());
        assert!(psbt.inputs[0].witness_utxo.is_some());
    }

    #[test]
    fn parent_solo_stamps_first_timelock() {
        let (policy, req) = request(crate::policy_compiler::BLOC_PATH_PARENT_SOLO, 0);
        let psbt = build_bloc_spend_psbt(&policy, req).unwrap();
        assert_eq!(
            psbt.unsigned_tx.lock_time,
            absolute::LockTime::from_height(100_000).unwrap(),
        );
    }

    #[test]
    fn decay_rung_quorum_selects_matching_height() {
        // 2-of-4 rung sits at 200_000 + (4-2)*52_560 = 305_120.
        let (policy, req) = request(crate::policy_compiler::BLOC_PATH_KIDS_DECAY, 2);
        let psbt = build_bloc_spend_psbt(&policy, req).unwrap();
        assert_eq!(
            psbt.unsigned_tx.lock_time,
            absolute::LockTime::from_height(305_120).unwrap(),
        );
    }

    #[test]
    fn unknown_decay_quorum_is_rejected() {
        // No 9-of-4 rung exists.
        let (policy, req) = request(crate::policy_compiler::BLOC_PATH_KIDS_DECAY, 9);
        let err = build_bloc_spend_psbt(&policy, req).unwrap_err();
        assert!(matches!(err, PsbtError::UnknownPath(_)));
    }

    #[test]
    fn unknown_path_is_rejected() {
        let (policy, req) = request("definitely_not_a_path", 0);
        let err = build_bloc_spend_psbt(&policy, req).unwrap_err();
        assert!(matches!(err, PsbtError::UnknownPath(_)));
    }

    #[test]
    fn sub_dust_change_is_dropped_into_fee() {
        // change = 51_400 - 50_000 - 1_000 = 400 sats, below the 546 dust
        // floor -> no change output (destination only).
        let (policy, mut req) = request(crate::policy_compiler::BLOC_PATH_PARENTS_NOW, 0);
        req.utxos[0].value = 51_400;
        let psbt = build_bloc_spend_psbt(&policy, req).unwrap();
        assert_eq!(psbt.unsigned_tx.output.len(), 1, "sub-dust change must be absorbed into fee");
    }

    #[test]
    fn at_dust_change_is_kept() {
        // change = 51_546 - 50_000 - 1_000 = 546 == dust floor -> kept.
        let (policy, mut req) = request(crate::policy_compiler::BLOC_PATH_PARENTS_NOW, 0);
        req.utxos[0].value = 51_546;
        let psbt = build_bloc_spend_psbt(&policy, req).unwrap();
        assert_eq!(psbt.unsigned_tx.output.len(), 2, "change at the dust floor must be kept");
    }
}
