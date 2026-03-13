use bitcoin::absolute;
use bitcoin::address::Address;
use bitcoin::hex::FromHex;
use bitcoin::psbt::Psbt;
use bitcoin::{
    Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid,
};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use thiserror::Error;

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
            sequence: Sequence::MAX,
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
