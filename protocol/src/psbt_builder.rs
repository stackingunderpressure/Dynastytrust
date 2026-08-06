use bitcoin::absolute;
use bitcoin::address::Address;
use bitcoin::bip32::{DerivationPath, Fingerprint};
use bitcoin::hex::FromHex;
use bitcoin::psbt::{Input as PsbtInput, Psbt};
use bitcoin::taproot::{LeafVersion, TapLeafHash};
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

/// One signer's BIP32 origin, needed to populate a PSBT's tap_key_origins
/// field (PSBT_IN_TAP_BIP32_DERIVATION, BIP371) -- 2026-08-06 fix for
/// "hardware wallets won't let you sign our tapscripts" (operator
/// finding). Every PSBT this service builds already attaches
/// tap_internal_key + tap_scripts (the control block + leaf script), which
/// is enough for the browser signer and Tapit's signer: both find their
/// own key by searching the leaf script bytes for their raw pubkey. A
/// real hardware wallet (Coldcard, Nunchuk, Passport, Keystone) does not
/// do that -- it follows BIP371 strictly and only signs for a key it can
/// positively match via tap_key_origins, which pairs a pubkey with its
/// BIP32 fingerprint + full derivation path and names exactly which
/// taproot leaf hash(es) that key may sign for. Without this field a
/// spec-compliant hardware wallet has nothing to match against its own
/// keys and correctly refuses to sign -- that was the actual root cause,
/// not any inherent inability to handle a custom multi-leaf policy.
///
/// `pubkey` is the same 66-char compressed-pubkey-hex form
/// vaults.founder_keys / heir_keys / etc. already use (the /0/0
/// receive-chain child, per the Nunchuk key-material parity fix).
/// `fingerprint` is 8 hex characters. `derivation_path` is the FULL path
/// to that specific pubkey (e.g. "m/48'/1'/0'/2'/0/0") -- note this is
/// the account path PLUS the /0/0 child suffix, NOT the bare account path
/// descriptor-keys.ts stores for the key-origin descriptor expression
/// (which appends /0/* itself); tap_key_origins needs the concrete path
/// to the exact key used in the script, so the caller must append /0/0
/// before sending it here.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KeyOrigin {
    pub pubkey: String,
    pub fingerprint: String,
    pub derivation_path: String,
}

/// Populate `input.tap_key_origins` for every `key_origins` entry whose
/// pubkey is embedded in `leaf` -- the specific tapscript leaf this PSBT
/// input is being built to spend via. Matching is a byte-search of the
/// leaf script for the key's 32-byte x-only serialization, mirroring the
/// exact convention the browser (psbt-signer.ts) and Tapit
/// (signPsbtCosign.ts) signers already use to find "is my key in this
/// leaf" -- so all three signing paths agree on what "this key belongs to
/// this leaf" means, and none of them needs to know which policy-key list
/// (founders / heirs / protectors / consenters) a key came from.
///
/// Deliberately infallible: a malformed entry (bad pubkey, bad
/// fingerprint hex, bad derivation path) is skipped with a logged
/// warning rather than failing the whole PSBT build. The old behavior
/// (no tap_key_origins at all) already works for browser + Tapit signing,
/// so one bad optional metadata entry should degrade that one key back to
/// today's status quo, not break every signer's ability to build a PSBT.
pub fn attach_tap_key_origins(input: &mut PsbtInput, leaf: &ScriptBuf, key_origins: &[KeyOrigin]) {
    if key_origins.is_empty() {
        return;
    }
    let leaf_bytes = leaf.as_bytes();
    let leaf_hash = TapLeafHash::from_script(leaf, LeafVersion::TapScript);

    for origin in key_origins {
        let Ok(pk) = bitcoin::PublicKey::from_str(&origin.pubkey) else {
            eprintln!("attach_tap_key_origins: skipping bad pubkey {}", origin.pubkey);
            continue;
        };
        let (xonly, _parity) = pk.inner.x_only_public_key();
        if !leaf_bytes.windows(32).any(|w| w == xonly.serialize()) {
            continue; // this key is not part of THIS leaf -- expected, not an error
        }
        let Ok(fp_bytes) = hex::decode(&origin.fingerprint) else {
            eprintln!("attach_tap_key_origins: skipping bad fingerprint hex {}", origin.fingerprint);
            continue;
        };
        let Ok(fp_arr): Result<[u8; 4], _> = fp_bytes.try_into() else {
            eprintln!("attach_tap_key_origins: fingerprint {} is not 4 bytes", origin.fingerprint);
            continue;
        };
        let fingerprint = Fingerprint::from(fp_arr);
        // DerivationPath::from_str requires a leading "m/"; tolerate a
        // caller that sent the path without it rather than silently
        // dropping an otherwise-good origin over a cosmetic mismatch.
        let normalized = if origin.derivation_path.starts_with("m/") || origin.derivation_path == "m" {
            origin.derivation_path.clone()
        } else {
            format!("m/{}", origin.derivation_path)
        };
        let Ok(path) = DerivationPath::from_str(&normalized) else {
            eprintln!("attach_tap_key_origins: skipping bad derivation path {}", origin.derivation_path);
            continue;
        };
        input
            .tap_key_origins
            .entry(xonly)
            .and_modify(|(leaves, _)| {
                if !leaves.contains(&leaf_hash) {
                    leaves.push(leaf_hash);
                }
            })
            .or_insert_with(|| (vec![leaf_hash], (fingerprint, path)));
    }
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
    /// BIP32 origins for any of this vault's signers, so a hardware
    /// wallet can recognize its own key on the leaf being spent. Optional
    /// and additive -- an empty list (or an older caller that omits the
    /// field) degrades exactly to pre-2026-08-06 behavior. See
    /// attach_tap_key_origins's doc comment for the full rationale.
    #[serde(default)]
    pub key_origins: Vec<KeyOrigin>,
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
        attach_tap_key_origins(&mut psbt.inputs[i], &leaf.leaf_script, &req.key_origins);
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
            key_origins: vec![],
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

    // 2026-08-06 hardware-wallet fix: key_origins is additive and must not
    // change any pre-existing behavior when empty (the default above), and
    // must correctly populate tap_key_origins ONLY for a key that is
    // actually part of the selected leaf when provided.
    const PARENT_A: &str = "02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97";
    const KID_A: &str = "03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34";

    #[test]
    fn key_origins_populate_tap_key_origins_for_a_signer_in_the_selected_leaf() {
        let (policy, mut req) = request(crate::policy_compiler::BLOC_PATH_PARENTS_NOW, 0);
        req.key_origins = vec![KeyOrigin {
            pubkey: PARENT_A.into(),
            fingerprint: "deadbeef".into(),
            derivation_path: "m/48'/1'/0'/2'/0/0".into(),
        }];
        let psbt = build_bloc_spend_psbt(&policy, req).unwrap();
        assert_eq!(psbt.inputs[0].tap_key_origins.len(), 1, "the parent key must get an origin entry");
    }

    #[test]
    fn key_not_in_the_selected_leaf_gets_no_origin_entry() {
        let (policy, mut req) = request(crate::policy_compiler::BLOC_PATH_PARENTS_NOW, 0);
        // A kid key is not part of the parents_now leaf.
        req.key_origins = vec![KeyOrigin {
            pubkey: KID_A.into(),
            fingerprint: "deadbeef".into(),
            derivation_path: "m/48'/1'/0'/2'/0/0".into(),
        }];
        let psbt = build_bloc_spend_psbt(&policy, req).unwrap();
        assert!(
            psbt.inputs[0].tap_key_origins.is_empty(),
            "a kid key must not be attached to the parents-now leaf"
        );
    }

    #[test]
    fn malformed_key_origin_is_skipped_without_failing_the_whole_psbt_build() {
        let (policy, mut req) = request(crate::policy_compiler::BLOC_PATH_PARENTS_NOW, 0);
        req.key_origins = vec![KeyOrigin {
            pubkey: PARENT_A.into(),
            fingerprint: "not-hex!".into(),
            derivation_path: "m/48'/1'/0'/2'/0/0".into(),
        }];
        let psbt = build_bloc_spend_psbt(&policy, req).unwrap();
        assert!(psbt.inputs[0].tap_key_origins.is_empty());
    }
}

#[cfg(test)]
mod key_origin_tests {
    use super::*;
    use bitcoin::script::Builder;
    use bitcoin::PublicKey;

    fn leaf_containing(pk_hex: &str) -> ScriptBuf {
        let pk = PublicKey::from_str(pk_hex).unwrap();
        let (xonly, _parity) = pk.inner.x_only_public_key();
        Builder::new().push_slice(xonly.serialize()).into_script()
    }

    const PRESENT: &str = "02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97";
    const ABSENT: &str = "03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34";

    #[test]
    fn attaches_origin_with_correct_fingerprint_and_path_for_a_key_present_in_the_leaf() {
        let leaf = leaf_containing(PRESENT);
        let mut input = PsbtInput::default();
        attach_tap_key_origins(
            &mut input,
            &leaf,
            &[KeyOrigin {
                pubkey: PRESENT.into(),
                fingerprint: "deadbeef".into(),
                derivation_path: "m/48'/1'/0'/2'/0/0".into(),
            }],
        );
        assert_eq!(input.tap_key_origins.len(), 1);
        let (leaves, (fp, path)) = input.tap_key_origins.values().next().unwrap();
        assert_eq!(leaves.len(), 1);
        assert_eq!(fp.to_string(), "deadbeef");
        assert_eq!(path.to_string(), "m/48'/1'/0'/2'/0/0");
    }

    #[test]
    fn does_not_attach_origin_for_a_key_absent_from_the_leaf() {
        let leaf = leaf_containing(PRESENT);
        let mut input = PsbtInput::default();
        attach_tap_key_origins(
            &mut input,
            &leaf,
            &[KeyOrigin {
                pubkey: ABSENT.into(),
                fingerprint: "deadbeef".into(),
                derivation_path: "m/48'/1'/0'/2'/0/0".into(),
            }],
        );
        assert!(input.tap_key_origins.is_empty());
    }

    #[test]
    fn skips_bad_fingerprint_without_panicking() {
        let leaf = leaf_containing(PRESENT);
        let mut input = PsbtInput::default();
        attach_tap_key_origins(
            &mut input,
            &leaf,
            &[KeyOrigin {
                pubkey: PRESENT.into(),
                fingerprint: "zz".into(), // not hex
                derivation_path: "m/48'/1'/0'/2'/0/0".into(),
            }],
        );
        assert!(input.tap_key_origins.is_empty());
    }

    #[test]
    fn skips_bad_pubkey_without_panicking() {
        let leaf = leaf_containing(PRESENT);
        let mut input = PsbtInput::default();
        attach_tap_key_origins(
            &mut input,
            &leaf,
            &[KeyOrigin {
                pubkey: "not-a-pubkey".into(),
                fingerprint: "deadbeef".into(),
                derivation_path: "m/48'/1'/0'/2'/0/0".into(),
            }],
        );
        assert!(input.tap_key_origins.is_empty());
    }

    #[test]
    fn tolerates_a_derivation_path_missing_the_leading_m() {
        let leaf = leaf_containing(PRESENT);
        let mut input = PsbtInput::default();
        attach_tap_key_origins(
            &mut input,
            &leaf,
            &[KeyOrigin {
                pubkey: PRESENT.into(),
                fingerprint: "deadbeef".into(),
                derivation_path: "48'/1'/0'/2'/0/0".into(),
            }],
        );
        assert_eq!(input.tap_key_origins.len(), 1);
    }

    #[test]
    fn empty_key_origins_is_a_no_op() {
        let leaf = leaf_containing(PRESENT);
        let mut input = PsbtInput::default();
        attach_tap_key_origins(&mut input, &leaf, &[]);
        assert!(input.tap_key_origins.is_empty());
    }

    #[test]
    fn one_bad_entry_does_not_block_a_later_good_entry() {
        let leaf = leaf_containing(PRESENT);
        let mut input = PsbtInput::default();
        attach_tap_key_origins(
            &mut input,
            &leaf,
            &[
                KeyOrigin {
                    pubkey: "garbage".into(),
                    fingerprint: "deadbeef".into(),
                    derivation_path: "m/48'/1'/0'/2'/0/0".into(),
                },
                KeyOrigin {
                    pubkey: PRESENT.into(),
                    fingerprint: "deadbeef".into(),
                    derivation_path: "m/48'/1'/0'/2'/0/0".into(),
                },
            ],
        );
        assert_eq!(input.tap_key_origins.len(), 1);
    }
}
