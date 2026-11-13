//! service.rs -- every compiler request, as plain functions (sovereign
//! slice 1, docs/super-sovereign-build-note.md).
//!
//! Moved here unchanged from compiler/src/main.rs's request handlers so the
//! Fly server (thin wrappers that only check the shared secret) and the
//! browser module (protocol-wasm) run ONE copy of this logic. Same request
//! JSON in, same response JSON out; an error carries the HTTP status the
//! server sends and the same message. Proven identical against recorded
//! answers of the server before the move: scripts/compiler-parity.mjs.

#![allow(clippy::too_many_arguments)]

use anyhow::{anyhow, Result};
use bitcoin::{
    absolute::LockTime, transaction::Version, Amount, Network, OutPoint,
    PublicKey, ScriptBuf, Transaction, TxIn, TxOut, Txid, Witness,
};
use bitcoin::psbt::Psbt;
use bitcoin::sighash::TapSighashType;
use bitcoin::taproot::LeafVersion;
use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use crate::{
    attach_tap_change_output_metadata, attach_tap_key_origins, audit_spend, build_bloc_spend_psbt,
    build_leaf_multileaf, build_multileaf, build_tranche_spend_psbt, compile_dynasty_bloc_tr_multileaf,
    compile_dynasty_policy, compile_dynasty_policy_tr, compile_dynasty_policy_tr_multileaf,
    compile_tranche_tr_multileaf, evaluate_spend_proposal, evaluate_vault_status, next_action,
    BlocSpendRequest, DynastyBlocPolicy, DynastyPolicy, KeyOrigin, ProposedSpend, SignerStatus,
    SpendingPath, TranchePolicy, TrancheSpendRequest, Unlock, VaultPolicy, VaultUTXO,
};
use crate as dynastytrust_protocol;
use miniscript::psbt::PsbtExt;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

/// A refusal: the HTTP status the server answers with, and its message.
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceError { pub status: u16, pub error: String }

pub fn api_err(status: u16, msg: impl ToString) -> ServiceError {
    ServiceError { status, error: msg.to_string() }
}

/// One entry point for every endpoint, for callers with no web server (the
/// browser module): request JSON in, (status, response JSON) out -- the same
/// status and body the server sends.
pub fn handle(endpoint: &str, body: &str) -> (u16, String) {
    fn run<Req: serde::de::DeserializeOwned, Resp: Serialize>(
        body: &str, f: fn(Req) -> Result<Resp, ServiceError>,
    ) -> (u16, String) {
        let err = |status: u16, error: String| (status, serde_json::json!({ "ok": false, "error": error }).to_string());
        let req: Req = match serde_json::from_str(body) {
            Ok(r) => r,
            Err(e) => return err(422, format!("Invalid request body: {e}")),
        };
        match f(req) {
            Ok(resp) => match serde_json::to_string(&resp) {
                Ok(s) => (200, s),
                Err(e) => err(500, format!("response encoding: {e}")),
            },
            Err(e) => err(e.status, e.error),
        }
    }
    match endpoint {
        "/compile" => run(body, compile),
        "/compile-bloc" => run(body, compile_bloc),
        "/compile-tranche" => run(body, compile_tranche),
        "/compile-leaves" => run(body, compile_leaves),
        "/psbt-binary" => run(body, psbt_binary),
        "/psbt-binary-bloc" => run(body, psbt_binary_bloc),
        "/psbt-binary-tranche" => run(body, psbt_binary_tranche),
        "/psbt-finalize" => run(body, psbt_finalize),
        "/psbt-merge" => run(body, psbt_merge),
        "/governance/status" => run(body, governance_status),
        "/governance/audit" => run(body, governance_audit),
        "/validate-address" => run(body, validate_address),
        other => (404, serde_json::json!({ "ok": false, "error": format!("unknown endpoint {other}") }).to_string()),
    }
}

pub fn parse_network(s: &str) -> Result<Network> {
    match s.to_lowercase().as_str() {
        "testnet"           => Ok(Network::Testnet),
        "signet"            => Ok(Network::Signet),
        "bitcoin"|"mainnet" => Ok(Network::Bitcoin),
        other => Err(anyhow!("unknown network: {other}")),
    }
}

pub fn parse_pubkeys(keys: &[String]) -> Result<Vec<PublicKey>> {
    keys.iter()
        .map(|k| PublicKey::from_str(k).map_err(|e| anyhow!("bad pubkey {k}: {e}")))
        .collect()
}

// ── Generic leaf-list vault (toggle-a-leaf builder) ─────────────────────────
// Wire shapes for dynastytrust_protocol::{Leaf, Unlock, DecayConfig,
// LeafPolicy} -- string-keyed pubkeys the same way every other request in
// this file is (see parse_pubkeys above), never bitcoin::PublicKey's own
// Deserialize impl directly.

#[derive(Deserialize)]
pub struct LeafUnlockWire {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub blocks: Option<u32>,
}

#[derive(Deserialize)]
pub struct LeafDecayWire {
    pub step_blocks: u32,
    pub floor_quorum: usize,
}

#[derive(Deserialize)]
pub struct LeafSpecWire {
    pub id: String,
    pub label: String,
    pub keys: Vec<String>,
    pub quorum: usize,
    pub unlock: LeafUnlockWire,
    #[serde(default)]
    pub decay: Option<LeafDecayWire>,
    /// Must-sign keys for this path -- see protocol::Leaf::required_keys.
    #[serde(default)]
    pub required_keys: Vec<String>,
}

pub fn parse_leaf_policy(
    wire_leaves: &[LeafSpecWire],
    consent_keys: &[String],
    consent_quorum: Option<usize>,
) -> Result<dynastytrust_protocol::LeafPolicy> {
    let leaves = wire_leaves
        .iter()
        .map(|w| {
            let keys = parse_pubkeys(&w.keys)?;
            let unlock = match w.unlock.kind.as_str() {
                "immediate" => dynastytrust_protocol::Unlock::Immediate,
                "after" => dynastytrust_protocol::Unlock::After {
                    blocks: w.unlock.blocks.ok_or_else(|| anyhow!("leaf '{}': after unlock missing blocks", w.id))?,
                },
                "older" => dynastytrust_protocol::Unlock::OlderThan {
                    blocks: w.unlock.blocks.ok_or_else(|| anyhow!("leaf '{}': older unlock missing blocks", w.id))?,
                },
                other => return Err(anyhow!("leaf '{}': unknown unlock type '{other}'", w.id)),
            };
            Ok(dynastytrust_protocol::Leaf {
                required_keys: parse_pubkeys(&w.required_keys)?,
                id: w.id.clone(),
                label: w.label.clone(),
                keys,
                quorum: w.quorum,
                unlock,
                decay: w.decay.as_ref().map(|d| dynastytrust_protocol::DecayConfig {
                    step_blocks: d.step_blocks,
                    floor_quorum: d.floor_quorum,
                }),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(dynastytrust_protocol::LeafPolicy {
        leaves,
        consent_keys: parse_pubkeys(consent_keys)?,
        consent_quorum,
    })
}

pub const NUMS_HEX: &str = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

pub fn base64_encode(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i+1 < data.len() { data[i+1] as u32 } else { 0 };
        let b2 = if i+2 < data.len() { data[i+2] as u32 } else { 0 };
        out.push(A[((b0>>2)&0x3F) as usize] as char);
        out.push(A[(((b0&3)<<4)|(b1>>4)) as usize] as char);
        out.push(if i+1<data.len() { A[(((b1&0xF)<<2)|(b2>>6)) as usize] as char } else { '=' });
        out.push(if i+2<data.len() { A[(b2&0x3F) as usize] as char } else { '=' });
        i += 3;
    }
    out
}

// ── /compile ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CompileRequest {
    pub name: Option<String>, pub network: String,
    pub founder_keys: Vec<String>, pub founder_quorum: usize,
    #[serde(default)] pub recovery_quorum: Option<usize>,
    pub heir_keys: Vec<String>,    pub heir_quorum: usize,
    pub recovery_after: u32,       pub inheritance_after: u32,
    #[serde(default = "default_addr_type")] pub address_type: String,
    #[serde(default)] pub consent_keys: Vec<String>,
    #[serde(default)] pub consent_quorum: Option<usize>,
    /// "Anytime, harder" fallback (2026-08-08) -- an untimelocked branch
    /// over a SEPARATE key set the owner controls directly, occupying the
    /// same tree slot the timelocked recovery branch would. Mutually
    /// exclusive with recovery_after > 0; see DynastyPolicy::has_backup.
    #[serde(default)] pub backup_keys: Vec<String>,
    #[serde(default)] pub backup_quorum: Option<usize>,
    /// Second, independent inheritance leaf (2026-08-11) -- a distinct
    /// heir cohort with its own key set, quorum, and absolute timelock
    /// alongside the primary heir_keys/heir_quorum/inheritance_after
    /// leaf. See DynastyPolicy::has_second_inheritance.
    #[serde(default)] pub second_heir_keys: Vec<String>,
    #[serde(default)] pub second_heir_quorum: Option<usize>,
    #[serde(default)] pub second_inheritance_after: Option<u32>,
}
pub fn default_addr_type() -> String { "tr".to_string() }

#[derive(Serialize)]
pub struct CompileResponse {
    pub ok: bool, pub name: String, pub network: String, pub address_type: String,
    pub miniscript_policy: String, pub descriptor: String, pub address: String,
    /// Hex-encoded tapscript leaf bytes for a tr_multileaf vault, keyed by
    /// role ("founders_now", "recovery" OR "backup" -- mutually exclusive,
    /// "inheritance") -- present only for the roles the
    /// policy actually compiled a leaf for.
    /// None for non-multileaf address types. This is what a vault-membership
    /// attestation (DynastyTrust -> Tapit Cut C3) names per signer so the
    /// receiving wallet can later verify a psbt-cosign request's tapLeafScript
    /// against a leaf it was actually told about at vault-creation time,
    /// not merely a leaf that arrives labeled with a familiar descriptor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leaf_scripts: Option<std::collections::HashMap<String, String>>,
}

pub fn compile(req: CompileRequest) -> Result<CompileResponse, ServiceError> {
    let network  = parse_network(&req.network).map_err(|e| api_err(400, e))?;
    let founders = parse_pubkeys(&req.founder_keys).map_err(|e| api_err(400, e))?;
    let heirs    = parse_pubkeys(&req.heir_keys).map_err(|e| api_err(400, e))?;
    let consenters = parse_pubkeys(&req.consent_keys).map_err(|e| api_err(400, e))?;
    let backups = parse_pubkeys(&req.backup_keys).map_err(|e| api_err(400, e))?;
    let second_heirs = parse_pubkeys(&req.second_heir_keys).map_err(|e| api_err(400, e))?;
    let policy = DynastyPolicy {
        founder_keys: founders, founder_quorum: req.founder_quorum,
        recovery_quorum: req.recovery_quorum,
        heir_keys: heirs,       heir_quorum: req.heir_quorum,
        recovery_after: req.recovery_after, inheritance_after: req.inheritance_after,
        consent_keys: consenters,
        consent_quorum: req.consent_quorum,
        backup_keys: backups,
        backup_quorum: req.backup_quorum,
        second_heir_keys: second_heirs,
        second_heir_quorum: req.second_heir_quorum,
        second_inheritance_after: req.second_inheritance_after,
    };
    // Cloned up front (cheap -- a handful of Vec<PublicKey>): the compile
    // functions below take `policy` by value, but a tr_multileaf compile
    // also needs a second, independent pass through build_multileaf to
    // recover the per-role leaf ScriptBufs, which compile_dynasty_policy_tr_
    // multileaf computes internally and then discards before returning.
    let policy_for_leaves = policy.clone();
    let compiled = match req.address_type.as_str() {
        "wsh"          => compile_dynasty_policy(policy, network),
        "tr_multileaf" => compile_dynasty_policy_tr_multileaf(policy, network),
        _              => compile_dynasty_policy_tr(policy, network),
    }.map_err(|e| api_err(400, e))?;
    let leaf_scripts = if req.address_type == "tr_multileaf" {
        build_multileaf(&policy_for_leaves).ok().map(|out| {
            let mut m = std::collections::HashMap::new();
            m.insert("founders_now".to_string(), hex::encode(out.founder_leaf.as_bytes()));
            if let Some(l) = &out.recovery_leaf {
                // Mutually exclusive slot -- recovery_leaf IS the backup
                // leaf when the policy set backup_keys instead of a
                // timelocked recovery_after (see MultileafOutput's doc
                // comment); label it accordingly, never both.
                let key = if policy_for_leaves.has_backup() { "backup" } else { "recovery" };
                m.insert(key.to_string(), hex::encode(l.as_bytes()));
            }
            if let Some(l) = &out.inheritance_leaf {
                m.insert("inheritance".to_string(), hex::encode(l.as_bytes()));
            }
            if let Some(l) = &out.second_inheritance_leaf {
                m.insert("second_inheritance".to_string(), hex::encode(l.as_bytes()));
            }
            m
        })
    } else {
        None
    };
    Ok(CompileResponse {
        ok: true, name: req.name.unwrap_or_else(|| "Vault".to_string()),
        network: req.network, address_type: compiled.address_type.to_string(),
        miniscript_policy: compiled.miniscript_policy,
        descriptor: compiled.descriptor, address: compiled.address.to_string(),
        leaf_scripts,
    })
}

// ── /compile-tranche ─────────────────────────────────────────────────────────
// Single tranche of a T-vesting distribution wallet: beneficiary
// alone can claim after the absolute unlock block; trustees always
// retain an escape hatch. Callers build one of these per scheduled
// unlock (e.g. 12 for monthly over a year, 4 for quarterly).

#[derive(Deserialize)]
pub struct TrancheRequest {
    pub network: String,
    pub beneficiary_key: String,
    pub trustee_keys: Vec<String>,
    pub trustee_quorum: usize,
    pub unlock_block: u32,
}

#[derive(Serialize)]
pub struct TrancheResponse {
    pub ok: bool,
    pub network: String,
    pub miniscript_policy: String,
    pub descriptor: String,
    pub address: String,
    pub unlock_block: u32,
}

pub fn compile_tranche(req: TrancheRequest) -> Result<TrancheResponse, ServiceError> {
    let network = parse_network(&req.network).map_err(|e| api_err(400, e))?;
    let beneficiary = PublicKey::from_str(&req.beneficiary_key)
        .map_err(|e| api_err(400, format!("bad beneficiary key: {e}")))?;
    let trustees = parse_pubkeys(&req.trustee_keys).map_err(|e| api_err(400, e))?;
    let policy = TranchePolicy {
        beneficiary_key: beneficiary,
        trustee_keys: trustees,
        trustee_quorum: req.trustee_quorum,
        unlock_block: req.unlock_block,
    };
    let compiled = compile_tranche_tr_multileaf(policy, network)
        .map_err(|e| api_err(400, e))?;
    Ok(TrancheResponse {
        ok: true,
        network: req.network,
        miniscript_policy: compiled.miniscript_policy,
        descriptor: compiled.descriptor,
        address: compiled.address.to_string(),
        unlock_block: req.unlock_block,
    })
}

// ── /compile-bloc ──────────────────────────────────────────────────────────────
// Dynasty Bloc: a decaying-multisig family vault.
//   A  parents together                                 now
//   B  one parent + every kid                           now
//   C  one parent alone                  after parent_solo_after
//   D+ kids alone, decaying threshold,   after kids_decay_start_after
// Timelock fields are ABSOLUTE CLTV heights -- the caller (netlify
// compile-bloc.js) bakes tip + relative-offset before forwarding.
// `kids_decay_step_blocks` is a duration, not an offset, so it is
// passed through unchanged.

#[derive(Deserialize)]
pub struct CompileBlocRequest {
    pub name: Option<String>,
    pub network: String,
    pub parent_keys: Vec<String>,
    pub parents_together_quorum: usize,
    pub coparent_quorum: usize,
    pub kid_keys: Vec<String>,
    pub kids_with_parent_quorum: usize,
    pub parent_solo_after: u32,
    pub parent_solo_quorum: usize,
    pub kids_decay_start_after: u32,
    pub kids_decay_step_blocks: u32,
    pub kids_decay_start_quorum: usize,
    pub kids_decay_floor_quorum: usize,
}

pub fn compile_bloc(req: CompileBlocRequest) -> Result<CompileResponse, ServiceError> {
    let network = parse_network(&req.network).map_err(|e| api_err(400, e))?;
    let parents = parse_pubkeys(&req.parent_keys).map_err(|e| api_err(400, e))?;
    let kids = parse_pubkeys(&req.kid_keys).map_err(|e| api_err(400, e))?;
    let policy = DynastyBlocPolicy {
        parent_keys: parents,
        parents_together_quorum: req.parents_together_quorum,
        coparent_quorum: req.coparent_quorum,
        kid_keys: kids,
        kids_with_parent_quorum: req.kids_with_parent_quorum,
        parent_solo_after: req.parent_solo_after,
        parent_solo_quorum: req.parent_solo_quorum,
        kids_decay_start_after: req.kids_decay_start_after,
        kids_decay_step_blocks: req.kids_decay_step_blocks,
        kids_decay_start_quorum: req.kids_decay_start_quorum,
        kids_decay_floor_quorum: req.kids_decay_floor_quorum,
    };
    let compiled = compile_dynasty_bloc_tr_multileaf(policy, network)
        .map_err(|e| api_err(400, e))?;
    Ok(CompileResponse {
        ok: true,
        name: req.name.unwrap_or_else(|| "Dynasty Bloc".to_string()),
        network: req.network,
        address_type: compiled.address_type.to_string(),
        miniscript_policy: compiled.miniscript_policy,
        descriptor: compiled.descriptor,
        address: compiled.address.to_string(),
        // Bloc vaults are a different vault family, not part of the Tapit
        // Circle vault-membership flow -- no per-role leaf export needed here.
        leaf_scripts: None,
    })
}

// ── /compile-leaves ──────────────────────────────────────────────────────────
// Compile a generic leaf-list vault (the "toggle-a-leaf" builder) --
// mirrors /compile-bloc: single-owner-held, the caller (the wizard,
// once every leaf's keys are filled) sends the finished leaf list
// directly rather than the server reading vault_members. Timelock
// fields are ABSOLUTE for After leaves and a DURATION for OlderThan
// leaves (the caller, netlify/functions/compile-leaves.js, converts
// only the After leaves' relative offsets via tip + offset before
// forwarding here -- an OlderThan leaf's block count is never an
// offset from anything, it's measured from whichever UTXO is spent).

#[derive(Deserialize)]
pub struct CompileLeavesRequest {
    pub name: Option<String>,
    pub network: String,
    pub leaves: Vec<LeafSpecWire>,
    #[serde(default)]
    pub consent_keys: Vec<String>,
    #[serde(default)]
    pub consent_quorum: Option<usize>,
}

pub fn compile_leaves(req: CompileLeavesRequest) -> Result<CompileResponse, ServiceError> {
    let network = parse_network(&req.network).map_err(|e| api_err(400, e))?;
    let policy = parse_leaf_policy(&req.leaves, &req.consent_keys, req.consent_quorum)
        .map_err(|e| api_err(400, format!("bad leaf policy: {e}")))?;
    let out = build_leaf_multileaf(&policy)
        .map_err(|e| api_err(400, format!("leaf policy rejected: {e}")))?;

    let addr = bitcoin::Address::p2tr_tweaked(out.spend_info.output_key(), network);
    use miniscript::{Descriptor, DescriptorPublicKey};
    let _: Descriptor<DescriptorPublicKey> = Descriptor::from_str(&out.descriptor)
        .map_err(|e| api_err(500, format!("descriptor round-trip: {e:?}")))?;

    let leaf_scripts: std::collections::HashMap<String, String> = out
        .leaf_scripts
        .iter()
        .map(|(id, s)| (id.clone(), hex::encode(s.as_bytes())))
        .collect();

    Ok(CompileResponse {
        ok: true,
        name: req.name.unwrap_or_else(|| "Vault".to_string()),
        network: req.network,
        address_type: "tr_multileaf".to_string(),
        miniscript_policy: out.miniscript_policy,
        descriptor: out.descriptor,
        address: addr.to_string(),
        leaf_scripts: Some(leaf_scripts),
    })
}

// ── /psbt-binary ─────────────────────────────────────────────────────────────
//
// Builds an unsigned PSBT with all hardware-wallet-required fields:
//   - witness_utxo     (required by ALL hardware wallets — BIP 174)
//   - tap_internal_key (tells wallet the keypath is NUMS/disabled)
//   - tap_scripts      (control block + leaf script — required by Coldcard, Passport, Keystone)
//   - witness_script   (for WSH inputs)

#[derive(Deserialize)]
pub struct UtxoInput {
    pub txid: String, pub vout: u32, pub value_sats: u64,
    pub script_pubkey: String,  // hex-encoded scriptPubKey of the UTXO being spent
}

#[derive(Deserialize)]
pub struct PsbtBinaryRequest {
    pub inputs: Vec<UtxoInput>,
    pub destination: String, pub amount_sats: u64, pub fee_sats: u64,
    pub change_address: String, pub network: String,
    // Policy params — used to recompile leaf script for tap_scripts attachment
    pub founder_keys:     Option<Vec<String>>,
    pub founder_quorum:   Option<usize>,
    pub heir_keys:        Option<Vec<String>>,
    pub heir_quorum:      Option<usize>,
    pub recovery_after:   Option<u32>,
    pub inheritance_after: Option<u32>,
    pub address_type:     Option<String>,
    #[serde(default)] pub consent_keys:   Vec<String>,
    #[serde(default)] pub consent_quorum: Option<usize>,
    #[serde(default)] pub recovery_quorum: Option<usize>,
    #[serde(default)] pub backup_keys: Vec<String>,
    #[serde(default)] pub backup_quorum: Option<usize>,
    // Second, independent inheritance leaf (2026-08-11) -- see
    // DynastyPolicy::has_second_inheritance.
    #[serde(default)] pub second_heir_keys: Vec<String>,
    #[serde(default)] pub second_heir_quorum: Option<usize>,
    #[serde(default)] pub second_inheritance_after: Option<u32>,
    // Which leaf the caller intends to spend via. Needed so we can
    // set tx.lock_time for CLTV-gated paths; founders_now and backup
    // both leave lock_time at 0. Values: "founders_now" | "recovery" |
    // "inheritance" | "backup" | "second_inheritance".
    #[serde(default)] pub path: Option<String>,
    // Fallback raw witness script (if policy params not provided)
    pub witness_script_hex: Option<String>,
    // BIP32 origins for this vault's signers (2026-08-06 hardware-wallet
    // fix) -- see attach_tap_key_origins's doc comment in psbt_builder.rs
    // for the full rationale. Optional and additive.
    #[serde(default)]
    pub key_origins: Vec<KeyOrigin>,
    // Generic leaf-list vault (toggle-a-leaf builder), additive alongside
    // every named field above. When present, this is authoritative over
    // the named fields, and `path` is looked up as a leaf id in this list
    // instead of the fixed founders_now/recovery/inheritance/
    // backup/second_inheritance switch. Reuses `consent_keys`/
    // `consent_quorum` above -- consent gates the primary leaf the same
    // way in both shapes, no separate field needed.
    #[serde(default)]
    pub leaves: Option<Vec<LeafSpecWire>>,
}

#[derive(Serialize)]
pub struct PsbtBinaryResponse {
    pub ok: bool, pub psbt_hex: String, pub psbt_b64: String,
    pub input_count: usize, pub output_count: usize, pub fee_sats: u64, pub has_tap_leaf: bool,
}

pub fn psbt_binary(req: PsbtBinaryRequest) -> Result<PsbtBinaryResponse, ServiceError> {

    if req.inputs.is_empty() {
        return Err(api_err(400, "No inputs provided"));
    }

    let network = parse_network(&req.network).map_err(|e| api_err(400, e))?;
    let total_in: u64 = req.inputs.iter().map(|u| u.value_sats).sum();
    let total_need = req.amount_sats.checked_add(req.fee_sats)
        .ok_or_else(|| api_err(400, "amount + fee overflow"))?;

    if total_in < total_need {
        return Err(api_err(400,
            format!("Insufficient funds: have {total_in} sats, need {total_need} sats")));
    }

    let change_value = total_in - total_need;
    let has_change   = change_value >= 546;

    // Bail on any malformed txid rather than silently substituting
    // a zero-hash placeholder (which would produce an unspendable
    // tx that looks fine until broadcast).
    let tx_inputs: Vec<TxIn> = req.inputs.iter().map(|u| {
        let txid = Txid::from_str(&u.txid)
            .map_err(|e| api_err(400, format!("bad txid {}: {e}", u.txid)))?;
        Ok(TxIn {
            previous_output: OutPoint { txid, vout: u.vout },
            script_sig: ScriptBuf::new(),
            sequence: bitcoin::Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::default(),
        })
    }).collect::<Result<Vec<_>, ServiceError>>()?;

    let dest_addr = req.destination.parse::<bitcoin::Address<_>>()
        .map_err(|e| api_err(400, format!("bad destination: {e}")))?
        .require_network(network)
        .map_err(|_| api_err(400, "destination network mismatch"))?;

    let mut tx_outputs = vec![TxOut {
        value: Amount::from_sat(req.amount_sats),
        script_pubkey: dest_addr.script_pubkey(),
    }];

    if has_change {
        let change_addr = req.change_address.parse::<bitcoin::Address<_>>()
            .map_err(|e| api_err(400, format!("bad change address: {e}")))?
            .require_network(network)
            .map_err(|_| api_err(400, "change address network mismatch"))?;
        tx_outputs.push(TxOut {
            value: Amount::from_sat(change_value),
            script_pubkey: change_addr.script_pubkey(),
        });
    }

    // Path selection has two shapes now. Generic (req.leaves present):
    // `path` is an arbitrary leaf id the caller's own LeafPolicy declares;
    // the leaf's own Unlock (Immediate/After/OlderThan) says whether
    // tx.lock_time or the spending inputs' nSequence needs setting --
    // CLTV and CSV are two different transaction fields, never
    // interchangeable. Named (legacy): founders_now leaves lock_time at
    // 0; recovery/inheritance set it to the stored absolute
    // block height. Both shapes require current-tip + relative-offset
    // already baked into any absolute height by the time it reaches here.
    //
    // An unrecognized path is rejected outright rather than silently
    // falling back to founders_now -- build_bloc_spend_psbt and
    // build_tranche_spend_psbt (psbt_builder.rs) both already fail closed
    // on an unknown path via PsbtError::UnknownPath; "reject what you
    // don't recognize" is the pattern this codebase deliberately follows.
    let intended_path = req.path.as_deref().unwrap_or("founders_now");

    // Build the FULL multileaf taproot tree so the control block attached
    // to tap_scripts proves against the real vault's merkle root --
    // rebuilding only the founders-now leaf produced a mismatched root
    // and the finalizer rejected the spend with "Control block
    // verification failed at index 0". `full_output` is authoritative
    // from whichever shape the request actually declared; leaf-list wins
    // when both happen to be present, since `req.leaves` is the caller
    // deliberately opting into the new mechanism.
    let addr_type = req.address_type.as_deref().unwrap_or("tr");
    let is_leaf_list = req.leaves.is_some();

    let full_output: Option<dynastytrust_protocol::MultileafOutput> = if let Some(wire_leaves) = req.leaves.as_ref() {
        let policy = parse_leaf_policy(wire_leaves, &req.consent_keys, req.consent_quorum)
            .map_err(|e| api_err(400, format!("bad leaf policy: {e}")))?;
        Some(
            build_leaf_multileaf(&policy)
                .map_err(|e| api_err(400, format!("leaf policy rejected: {e}")))?,
        )
    } else if let (
        Some(fk), Some(fq), Some(hk), Some(hq), Some(ra), Some(ia)
    ) = (
        req.founder_keys.as_ref(), req.founder_quorum,
        req.heir_keys.as_ref(),    req.heir_quorum,
        req.recovery_after,        req.inheritance_after,
    ) {
        match (
            parse_pubkeys(fk),
            parse_pubkeys(hk),
            parse_pubkeys(&req.consent_keys),
            parse_pubkeys(&req.backup_keys),
        ) {
            (Ok(founders), Ok(heirs), Ok(consenters), Ok(backups)) => {
                match parse_pubkeys(&req.second_heir_keys) {
                    Ok(second_heirs) => {
                        let pol = DynastyPolicy {
                            founder_keys: founders, founder_quorum: fq,
                            recovery_quorum: req.recovery_quorum,
                            heir_keys: heirs,       heir_quorum: hq,
                            recovery_after: ra,     inheritance_after: ia,
                            consent_keys: consenters,
                            consent_quorum: req.consent_quorum,
                            backup_keys: backups,
                            backup_quorum: req.backup_quorum,
                            second_heir_keys: second_heirs,
                            second_heir_quorum: req.second_heir_quorum,
                            second_inheritance_after: req.second_inheritance_after,
                        };
                        build_multileaf(&pol).ok()
                    }
                    Err(_) => None,
                }
            }
            _ => None,
        }
    } else {
        None
    };

    // Select the leaf `intended_path` names, and derive tx.lock_time /
    // the spending inputs' nSequence from ITS unlock -- generalizes the
    // 2026-08-06 fix (previously always used founder_leaf regardless of
    // path, mismatching tap_scripts against lock_time for every
    // non-founders spend). A path naming a leaf the policy doesn't have
    // correctly yields None, same as a full policy-parse failure above.
    let (selected_leaf, lock_time, needs_relative_sequence): (Option<ScriptBuf>, LockTime, Option<u32>) =
        if is_leaf_list {
            let out = full_output.as_ref();
            let leaf = out.and_then(|o| o.leaf_scripts.iter().find(|(id, _)| id == intended_path).map(|(_, s)| s.clone()));
            if leaf.is_none() {
                return Err(api_err(400, format!("Unknown path: {intended_path}")));
            }
            let unlock = out.and_then(|o| o.leaf_unlocks.iter().find(|(id, _)| id == intended_path).map(|(_, u)| *u));
            match unlock {
                Some(Unlock::Immediate) | None => (leaf, LockTime::ZERO, None),
                Some(Unlock::After { blocks }) if blocks > 0 => {
                    let lt = LockTime::from_height(blocks)
                        .map_err(|e| api_err(400, format!("bad lock_time {blocks}: {e}")))?;
                    (leaf, lt, None)
                }
                Some(Unlock::After { .. }) => (leaf, LockTime::ZERO, None),
                Some(Unlock::OlderThan { blocks }) => (leaf, LockTime::ZERO, Some(blocks)),
            }
        } else {
            const VALID_PATHS: &[&str] = &[
                "founders_now", "recovery", "inheritance", "backup", "second_inheritance",
            ];
            if !VALID_PATHS.contains(&intended_path) {
                return Err(api_err(400, format!("Unknown path: {intended_path}")));
            }
            let locktime_height: Option<u32> = match intended_path {
                "recovery" => req.recovery_after,
                "inheritance" => req.inheritance_after,
                "second_inheritance" => req.second_inheritance_after,
                _ => None,
            };
            let lt = match locktime_height {
                Some(h) if h > 0 => LockTime::from_height(h)
                    .map_err(|e| api_err(400, format!("bad lock_time {h}: {e}")))?,
                _ => LockTime::ZERO,
            };
            // "backup" shares recovery_leaf's tree slot -- see
            // MultileafOutput's doc comment (policy_compiler.rs). It is
            // never CLTV-gated (falls to the default no-timelock case
            // above) and never relative either.
            let leaf = full_output.as_ref().and_then(|out| match intended_path {
                "recovery" | "backup" => out.recovery_leaf.clone(),
                "inheritance" => out.inheritance_leaf.clone(),
                "second_inheritance" => out.second_inheritance_leaf.clone(),
                _ => Some(out.founder_leaf.clone()),
            });
            (leaf, lt, None)
        };

    let tx = Transaction {
        version: Version::TWO, lock_time,
        input: tx_inputs, output: tx_outputs,
    };

    let output_count = tx.output.len();
    let mut psbt = Psbt::from_unsigned_tx(tx)
        .map_err(|e| api_err(500, format!("PSBT: {e}")))?;

    // BIP68 relative locktime (older()) is enforced through the SPENDING
    // input's nSequence, never through tx.lock_time -- that's CLTV's
    // field, not CSV's. Applied to every input the same whole-transaction
    // granularity lock_time already uses above, since this compiler's
    // model spends every input of a given PSBT via the same intended
    // path. `blocks` is guaranteed <= MAX_RELATIVE_BLOCKS (well under
    // BIP68's u16 ceiling) by build_leaf_multileaf's own verify_leaf_policy
    // call above, so the cast below can't truncate.
    if let Some(blocks) = needs_relative_sequence {
        // Never `as u16`: a silent truncation is exactly how older(65536)
        // became a 0-block wait. verify_leaf_policy rejects such a leaf
        // now; this refuses to build the spend if one ever reaches here.
        let height = u16::try_from(blocks).map_err(|_| api_err(
            400,
            format!("relative timelock of {blocks} blocks does not fit BIP 68"),
        ))?;
        let seq = bitcoin::Sequence::from_height(height);
        for input in psbt.unsigned_tx.input.iter_mut() {
            input.sequence = seq;
        }
    }

    // The one scriptPubkey this vault's policy can ever actually spend
    // from -- this app's vaults are a single fixed tr_multileaf address
    // (see CLAUDE.md's "Address type" rule), so every claimed input MUST
    // pay into exactly this script. Computed once, used both for the
    // change-output check below and for the new input check further
    // down (Kimi K3 scan #12/#22): neither witness_utxo.value_sats nor
    // .script_pubkey the caller claims per input was ever cross-checked
    // against what the vault's own compiled policy actually derives --
    // trusted implicitly. Since BIP341 sighashes commit to the claimed
    // prevout, a mismatched claim already fails on-chain validation at
    // broadcast, so this isn't a theft path by itself; it closes the
    // defense-in-depth gap (a compromised/buggy caller, or a signer's
    // on-screen summary reflecting fabricated numbers with nothing here
    // to catch it before they approve) the same way the change-output
    // check just below it already does.
    let compiled_output_script: Option<ScriptBuf> = full_output
        .as_ref()
        .map(|out| bitcoin::ScriptBuf::new_p2tr_tweaked(out.spend_info.output_key()));

    // Change always returns to this same vault's own tr_multileaf address
    // (psbt-binary.js sets change_address: vault.address), but until now the
    // change output carried no taproot metadata at all -- a bare
    // scriptPubkey. A signer verifying change by reconstructing it from its
    // own derived key (the same approach attach_tap_key_origins uses for
    // inputs) has nothing to reconstruct from a multi-leaf tree without
    // tap_internal_key / tap_key_origins on the output, so real change was
    // indistinguishable from an external destination on the confirm screen.
    // Every leaf (not just the one being spent) is passed through, since a
    // signer key can legitimately appear in more than one leaf (founder keys
    // sit in both founders-now and recovery).
    if has_change {
        if let Some(ref out) = full_output {
            // The change output's actual scriptPubkey comes from parsing
            // req.change_address (line ~523) -- independent of the policy
            // this request also supplied. Without this check, a request
            // whose change_address didn't actually belong to the compiled
            // policy would still get the policy's real tap_internal_key /
            // tap_tree / tap_key_origins stamped onto it, describing a
            // vault the output doesn't actually pay into. A signer that
            // trusts "tap_key_origins contains my key" as proof of change,
            // without independently recomputing the output key the way
            // this check does, would be misled. Reject rather than attach
            // mismatched metadata.
            if let Some(ref compiled) = compiled_output_script {
                if psbt.unsigned_tx.output[1].script_pubkey != *compiled {
                    return Err(api_err(
                        400,
                        "change_address does not match the address this policy actually compiles to",
                    ));
                }
            }
            let nums_bytes = hex::decode(NUMS_HEX).unwrap();
            let internal_key = XOnlyPublicKey::from_slice(&nums_bytes).unwrap();
            // Generic leaf-list vaults expose every leaf via leaf_scripts;
            // named vaults expose them as separate Option<ScriptBuf> fields.
            let leaves: Vec<&ScriptBuf> = if is_leaf_list {
                out.leaf_scripts.iter().map(|(_, s)| s).collect()
            } else {
                std::iter::once(&out.founder_leaf)
                    .chain(out.recovery_leaf.as_ref())
                    .chain(out.inheritance_leaf.as_ref())
                    .chain(out.second_inheritance_leaf.as_ref())
                    .collect()
            };
            attach_tap_change_output_metadata(
                &mut psbt.outputs[1],
                internal_key,
                out.tap_tree.clone(),
                &leaves,
                &req.key_origins,
            );
        }
    }

    let full_spend_info = full_output
        .as_ref()
        .zip(selected_leaf.as_ref())
        .map(|(out, leaf)| (out.spend_info.clone(), leaf.clone()));

    let _ = addr_type; // kept for future use
    let witness_script: Option<ScriptBuf> =
        req.witness_script_hex.as_ref().and_then(|h| hex::decode(h).ok().map(ScriptBuf::from_bytes));

    let has_tap_leaf = full_spend_info.is_some();

    for (i, utxo_in) in req.inputs.iter().enumerate() {
        // witness_utxo — mandatory for all hardware wallets. A malformed
        // hex string here must fail loudly, not silently coerce to an
        // empty scriptPubKey -- an empty script isn't p2tr, so the whole
        // tap_internal_key/tap_scripts attachment below would be quietly
        // skipped for this input, producing a PSBT with a bogus witness
        // that only fails later at sign/finalize with a confusing error.
        let spk_bytes = hex::decode(&utxo_in.script_pubkey).map_err(|e| api_err(
            400,
            format!("bad script_pubkey for input {}:{}: {e}", utxo_in.txid, utxo_in.vout),
        ))?;
        let spk = ScriptBuf::from_bytes(spk_bytes);

        // Every input this vault spends must actually come from this
        // vault's own compiled address -- see compiled_output_script's
        // doc comment above (Kimi K3 scan #12/#22). Reject rather than
        // build a PSBT whose witness_utxo describes a UTXO the compiled
        // policy doesn't actually own.
        if let Some(ref compiled) = compiled_output_script {
            if spk != *compiled {
                return Err(api_err(
                    400,
                    format!("input {}:{} script_pubkey does not match the address this policy compiles to", utxo_in.txid, utxo_in.vout),
                ));
            }
        }

        psbt.inputs[i].witness_utxo = Some(TxOut {
            value: Amount::from_sat(utxo_in.value_sats),
            script_pubkey: spk.clone(),
        });

        if spk.is_p2tr() {
            if let Some((ref spend_info, ref leaf)) = full_spend_info {
                let nums_bytes = hex::decode(NUMS_HEX).unwrap();
                psbt.inputs[i].tap_internal_key =
                    Some(XOnlyPublicKey::from_slice(&nums_bytes).unwrap());
                let script_ver = (leaf.clone(), LeafVersion::TapScript);
                if let Some(ctrl) = spend_info.control_block(&script_ver) {
                    psbt.inputs[i].tap_scripts.insert(ctrl, script_ver);
                }
                attach_tap_key_origins(&mut psbt.inputs[i], leaf, &req.key_origins);
            }
        }

        if spk.is_p2wsh() {
            if let Some(ref ws) = witness_script {
                psbt.inputs[i].witness_script = Some(ws.clone());
            }
        }
    }

    let psbt_bytes = psbt.serialize();
    Ok(PsbtBinaryResponse {
        ok: true, psbt_hex: hex::encode(&psbt_bytes), psbt_b64: base64_encode(&psbt_bytes),
        input_count: req.inputs.len(), output_count, fee_sats: req.fee_sats, has_tap_leaf,
    })
}

// ── /psbt-binary-bloc ────────────────────────────────────────────────────────
// Build an unsigned PSBT that spends a Dynasty Bloc UTXO via a chosen leaf.
// Timelock fields are ABSOLUTE CLTV heights (the stored vault values); the
// caller passes them straight through -- no tip conversion here, unlike
// /compile-bloc. `path` (+ `quorum` for decay rungs) selects the leaf; the
// protocol builder rebuilds the SAME tree the address came from, so the
// attached control block proves against the real merkle root.

#[derive(Deserialize)]
pub struct PsbtBinaryBlocRequest {
    pub inputs: Vec<UtxoInput>,
    pub destination: String,
    pub amount_sats: u64,
    pub fee_sats: u64,
    pub change_address: String,
    pub network: String,
    pub path: String,
    #[serde(default)]
    pub quorum: usize,
    pub parent_keys: Vec<String>,
    pub parents_together_quorum: usize,
    pub coparent_quorum: usize,
    pub kid_keys: Vec<String>,
    pub kids_with_parent_quorum: usize,
    pub parent_solo_after: u32,
    pub parent_solo_quorum: usize,
    pub kids_decay_start_after: u32,
    pub kids_decay_step_blocks: u32,
    pub kids_decay_start_quorum: usize,
    pub kids_decay_floor_quorum: usize,
    // BIP32 origins for this vault's signers (2026-08-06 hardware-wallet
    // fix). Optional and additive -- see PsbtBinaryRequest's own field.
    #[serde(default)]
    pub key_origins: Vec<KeyOrigin>,
}

pub fn psbt_binary_bloc(req: PsbtBinaryBlocRequest) -> Result<PsbtBinaryResponse, ServiceError> {

    if req.inputs.is_empty() {
        return Err(api_err(400, "No inputs provided"));
    }

    let parents = parse_pubkeys(&req.parent_keys).map_err(|e| api_err(400, e))?;
    let kids = parse_pubkeys(&req.kid_keys).map_err(|e| api_err(400, e))?;

    let policy = DynastyBlocPolicy {
        parent_keys: parents,
        parents_together_quorum: req.parents_together_quorum,
        coparent_quorum: req.coparent_quorum,
        kid_keys: kids,
        kids_with_parent_quorum: req.kids_with_parent_quorum,
        parent_solo_after: req.parent_solo_after,
        parent_solo_quorum: req.parent_solo_quorum,
        kids_decay_start_after: req.kids_decay_start_after,
        kids_decay_step_blocks: req.kids_decay_step_blocks,
        kids_decay_start_quorum: req.kids_decay_start_quorum,
        kids_decay_floor_quorum: req.kids_decay_floor_quorum,
    };

    let utxos: Vec<VaultUTXO> = req
        .inputs
        .iter()
        .map(|u| VaultUTXO {
            txid: u.txid.clone(),
            vout: u.vout,
            value: u.value_sats,
            script_pubkey: u.script_pubkey.clone(),
        })
        .collect();

    let spend = BlocSpendRequest {
        utxos,
        amount: req.amount_sats,
        fee: req.fee_sats,
        destination: req.destination,
        change_address: req.change_address,
        network: req.network,
        path: req.path,
        quorum: req.quorum,
        key_origins: req.key_origins,
    };

    let psbt = build_bloc_spend_psbt(&policy, spend)
        .map_err(|e| api_err(400, e))?;

    let output_count = psbt.unsigned_tx.output.len();
    let input_count = psbt.inputs.len();
    let psbt_bytes = psbt.serialize();
    Ok(PsbtBinaryResponse {
        ok: true,
        psbt_hex: hex::encode(&psbt_bytes),
        psbt_b64: base64_encode(&psbt_bytes),
        input_count,
        output_count,
        fee_sats: req.fee_sats,
        has_tap_leaf: true,
    })
}

// ── /psbt-binary-tranche ─────────────────────────────────────────────────────
// Spend a single T-vesting tranche's UTXO -- either the beneficiary
// claiming after the timelock, or a trustee using the escape hatch.
// The policy params (beneficiary_key, trustee_keys, trustee_quorum,
// unlock_block) are the SAME ones the ceremony used to call
// /compile-tranche when the tranche was created, so recompiling here
// reproduces the exact tree the tranche's address was funded at.

#[derive(Deserialize)]
pub struct PsbtBinaryTrancheRequest {
    pub inputs: Vec<UtxoInput>,
    pub destination: String,
    pub amount_sats: u64,
    pub fee_sats: u64,
    pub change_address: String,
    pub network: String,
    pub beneficiary_key: String,
    pub trustee_keys: Vec<String>,
    pub trustee_quorum: usize,
    pub unlock_block: u32,
    // "beneficiary" or "trustee" -- see TrancheSpendRequest's doc.
    pub path: String,
    #[serde(default)]
    pub key_origins: Vec<KeyOrigin>,
}

pub fn psbt_binary_tranche(req: PsbtBinaryTrancheRequest) -> Result<PsbtBinaryResponse, ServiceError> {

    if req.inputs.is_empty() {
        return Err(api_err(400, "No inputs provided"));
    }

    let beneficiary_key = PublicKey::from_str(&req.beneficiary_key)
        .map_err(|e| api_err(400, format!("bad beneficiary_key: {e}")))?;
    let trustee_keys =
        parse_pubkeys(&req.trustee_keys).map_err(|e| api_err(400, e))?;

    let policy = TranchePolicy {
        beneficiary_key,
        trustee_keys,
        trustee_quorum: req.trustee_quorum,
        unlock_block: req.unlock_block,
    };

    let utxos: Vec<VaultUTXO> = req
        .inputs
        .iter()
        .map(|u| VaultUTXO {
            txid: u.txid.clone(),
            vout: u.vout,
            value: u.value_sats,
            script_pubkey: u.script_pubkey.clone(),
        })
        .collect();

    let spend = TrancheSpendRequest {
        utxos,
        amount: req.amount_sats,
        fee: req.fee_sats,
        destination: req.destination,
        change_address: req.change_address,
        network: req.network,
        path: req.path,
        key_origins: req.key_origins,
    };

    let psbt = build_tranche_spend_psbt(&policy, spend)
        .map_err(|e| api_err(400, e))?;

    let output_count = psbt.unsigned_tx.output.len();
    let input_count = psbt.inputs.len();
    let psbt_bytes = psbt.serialize();
    Ok(PsbtBinaryResponse {
        ok: true,
        psbt_hex: hex::encode(&psbt_bytes),
        psbt_b64: base64_encode(&psbt_bytes),
        input_count,
        output_count,
        fee_sats: req.fee_sats,
        has_tap_leaf: true,
    })
}

// ── /psbt-finalize ────────────────────────────────────────────────────────────
//
// Finalizes a fully-signed PSBT and extracts the raw transaction.
// mempool.space /api/tx expects raw tx hex, NOT PSBT hex.
// This endpoint is called client-side just before broadcast.
//
// Finalization: miniscript::psbt::finalize() fills in the final_script_witness
// field from tap_script_sigs/partial_sigs, then extract_tx() strips the PSBT
// wrapper and returns the serializable raw transaction.
//
// Input:  { psbt_hex: "..." }
// Output: { raw_tx_hex, txid, input_count, output_count, vbytes }

#[derive(Deserialize)]
pub struct FinalizeRequest {
    pub psbt_hex: String,
}

#[derive(Serialize)]
pub struct FinalizeResponse {
    pub ok:          bool,
    pub raw_tx_hex:  String,
    pub txid:        String,
    pub input_count: usize,
    pub output_count: usize,
    pub vbytes:      usize,
}

pub fn psbt_finalize(req: FinalizeRequest) -> Result<FinalizeResponse, ServiceError> {

    let bytes = hex::decode(&req.psbt_hex)
        .map_err(|e| api_err(400, format!("bad PSBT hex: {e}")))?;

    let mut psbt = Psbt::deserialize(&bytes)
        .map_err(|e| api_err(400, format!("PSBT deserialize: {e}")))?;

    // Verify the PSBT has signatures before attempting finalization
    let has_sigs = psbt.inputs.iter().any(|inp|
        !inp.tap_script_sigs.is_empty() || !inp.partial_sigs.is_empty()
    );
    if !has_sigs {
        return Err(api_err(400,
            "PSBT has no signatures. Sign it with your hardware wallet first, then finalize."));
    }

    // Reject any signature whose sighash type isn't Default/All before
    // finalizing. This app's only signer (psbt-signer.ts /
    // bip341-psbt-signer) hardcodes SIGHASH_DEFAULT and, as of the same
    // fix, throws on any other type -- so this never fires against real
    // traffic. It exists as the finalize-boundary half of that fix
    // (Kimi K3 scan #10/#85): whether miniscript::psbt::Psbt::finalize_mut
    // itself would accept a non-Default/All tapscript signature depends
    // on that crate's own internals, not this app's code, so this check
    // makes the acceptance boundary explicit here rather than relying on
    // an unverified upstream guarantee.
    for input in &psbt.inputs {
        for sig in input.tap_script_sigs.values() {
            if sig.hash_ty != TapSighashType::Default && sig.hash_ty != TapSighashType::All {
                return Err(api_err(400,
                    format!("Unsupported sighash type {:?} on a tapscript signature -- only SIGHASH_DEFAULT and SIGHASH_ALL are accepted.", sig.hash_ty)));
            }
        }
        if let Some(sig) = &input.tap_key_sig {
            if sig.hash_ty != TapSighashType::Default && sig.hash_ty != TapSighashType::All {
                return Err(api_err(400,
                    format!("Unsupported sighash type {:?} on a key-path signature -- only SIGHASH_DEFAULT and SIGHASH_ALL are accepted.", sig.hash_ty)));
            }
        }
    }

    // miniscript::psbt::finalize fills final_script_witness from tap_script_sigs.
    // Split the error list by cause so the client knows whether to
    // collect more signatures or to rebuild the PSBT from a fresh
    // tree.
    let secp = Secp256k1::verification_only();
    psbt.finalize_mut(&secp)
        .map_err(|errors| {
            let msgs: Vec<String> = errors.iter().map(|e| e.to_string()).collect();
            let joined = msgs.join("; ");
            let lower = joined.to_lowercase();
            let hint = if lower.contains("missing both witness and non-witness utxo") {
                // miniscript::psbt::InputError::MissingUtxo -- a SPECIFIC,
                // named error distinct from "not enough sigs": finalize
                // could not find witness_utxo OR non_witness_utxo on some
                // input at all. Every input gets witness_utxo attached
                // unconditionally at psbt-binary build time, so this input
                // either isn't the one this app built (a signed PSBT from
                // a stale/different proposal build got pasted or scanned
                // back in), or a merge step dropped it. Previously fell
                // through to the generic "not enough signatures" hint,
                // which sent the operator chasing more signers for a
                // problem that has nothing to do with signer count.
                "The PSBT is missing UTXO data for one of its inputs -- this is not a signature-\
                 count problem. Most likely the signed PSBT that was scanned or pasted back in \
                 was signed against a different build of this proposal (stale QR/paste from an \
                 earlier attempt). Re-export the CURRENT PSBT from this page (Show QR / Copy PSBT \
                 hex) fresh, sign that exact one, and scan/paste it back -- don't reuse an older \
                 export."
            } else if lower.contains("control block") {
                // Merkle root mismatch between the PSBT's tap_scripts
                // and the vault's actual tree -- the spend can never
                // finalize, rebuild the PSBT.
                "Control block mismatch: the PSBT's Taproot tree does not match the vault's address. \
                 Cancel this proposal and build a new one; the old PSBT cannot be recovered."
            } else if lower.contains("could not satisfy") || lower.contains("miniscript") {
                // Script-level satisfaction failure -- usually a real
                // miniscript logic issue (threshold not met even after
                // every signer). Distinct from "wrong merkle root".
                "Miniscript could not satisfy the script. Likely a timelock hasn't elapsed \
                 or a required signer (heir / protector / beneficiary) has not signed yet."
            } else {
                // Generic "not enough sigs" case: quorum unmet.
                "Not enough signatures. Collect more signers for this proposal and retry finalize."
            };
            api_err(400,
                format!("Finalization failed: {joined}. {hint}"))
        })?;

    // Extract the raw transaction (strips PSBT wrapper)
    let raw_tx = psbt.extract_tx()
        .map_err(|e| api_err(400, format!("Extract tx: {e}")))?;

    let raw_tx_bytes = bitcoin::consensus::encode::serialize(&raw_tx);
    let raw_tx_hex   = hex::encode(&raw_tx_bytes);
    let txid         = raw_tx.txid().to_string();
    let input_count  = raw_tx.input.len();
    let output_count = raw_tx.output.len();

    // Virtual bytes via Weight type (bitcoin 0.31 canonical API)
    let vbytes = raw_tx.weight().to_vbytes_ceil() as usize;

    Ok(FinalizeResponse {
        ok: true, raw_tx_hex, txid,
        input_count, output_count, vbytes,
    })
}

// ── /psbt-merge ───────────────────────────────────────────────────────────────
//
// Merges N partially-signed PSBTs into one combined PSBT.
// All input PSBTs must share the same unsigned transaction.

#[derive(Deserialize)]
pub struct PsbtMergeRequest {
    pub psbts: Vec<String>,  // hex-encoded, minimum 2
}

#[derive(Serialize)]
pub struct PsbtMergeResponse {
    pub ok: bool, pub psbt_hex: String, pub psbt_b64: String,
    pub input_count: usize, pub signature_count: usize,
}

pub fn psbt_merge(req: PsbtMergeRequest) -> Result<PsbtMergeResponse, ServiceError> {

    if req.psbts.len() < 2 {
        return Err(api_err(400, "Provide at least 2 PSBTs"));
    }

    let mut psbts: Vec<Psbt> = req.psbts.iter().map(|h| {
        let bytes = hex::decode(h).map_err(|e| api_err(400, format!("bad hex: {e}")))?;
        Psbt::deserialize(&bytes).map_err(|e| api_err(400, format!("PSBT parse: {e}")))
    }).collect::<Result<_, _>>()?;

    let mut merged = psbts.remove(0);
    for other in psbts {
        merged.combine(other)
            .map_err(|e| api_err(400, format!("merge: {e}")))?;
    }

    // MIN across inputs, not sum: a multi-input spend is only actually
    // fully signed once EVERY input independently clears the quorum --
    // summing counted a 2-input, 2-signers-each spend as 4 signatures,
    // which callers then compared against a single quorum threshold
    // (e.g. founder_quorum == 2) and reported "fully signed" after only
    // one signer had actually signed each input.
    let signature_count: usize = merged.inputs.iter()
        .map(|inp| inp.tap_script_sigs.len() + inp.partial_sigs.len())
        .min()
        .unwrap_or(0);

    let psbt_bytes = merged.serialize();
    Ok(PsbtMergeResponse {
        ok: true, psbt_hex: hex::encode(&psbt_bytes), psbt_b64: base64_encode(&psbt_bytes),
        input_count: merged.inputs.len(), signature_count,
    })
}

// ── /governance/status ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GovernanceStatusRequest {
    pub founder_quorum: usize, pub founder_key_count: usize,
    pub heir_quorum: usize,    pub heir_key_count: usize,
    pub recovery_after: u32,   pub inheritance_after: u32,
    // Legacy field name: this is the CURRENT CHAIN TIP HEIGHT (absolute), not
    // UTXO age. Timelocks are absolute CLTV; recovery_after/inheritance_after
    // are absolute heights, so callers must pass the chain tip here.
    pub utxo_age_blocks: u32,
}

pub fn governance_status(req: GovernanceStatusRequest) -> Result<serde_json::Value, ServiceError> {
    // Input validation
    if req.founder_quorum == 0 || req.heir_quorum == 0 {
        return Err(api_err(400, "quorum must be > 0"));
    }
    let status = evaluate_vault_status(&VaultPolicy {
        founder_quorum: req.founder_quorum, founder_key_count: req.founder_key_count,
        heir_quorum:    req.heir_quorum,    heir_key_count:    req.heir_key_count,
        recovery_after: req.recovery_after, inheritance_after: req.inheritance_after,
    }, req.utxo_age_blocks);
    Ok(serde_json::to_value(&status).unwrap())
}

// ── /governance/audit ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GovernanceAuditRequest {
    pub founder_quorum: usize, pub founder_key_count: usize,
    pub heir_quorum: usize,    pub heir_key_count: usize,
    pub recovery_after: u32,   pub inheritance_after: u32,
    pub path: String,
    pub amount_sats: u64, pub destination: String,
    // Legacy field name: CURRENT CHAIN TIP HEIGHT (absolute), not UTXO age.
    pub utxo_age_blocks: u32, pub total_vault_sats: u64,
    #[serde(default)]
    pub signers: Vec<serde_json::Value>,
}

pub fn governance_audit(req: GovernanceAuditRequest) -> Result<serde_json::Value, ServiceError> {

    if req.founder_quorum == 0 || req.heir_quorum == 0 {
        return Err(api_err(400, "quorum must be > 0"));
    }
    if req.destination.is_empty() {
        return Err(api_err(400, "destination is required"));
    }

    let policy = VaultPolicy {
        founder_quorum: req.founder_quorum, founder_key_count: req.founder_key_count,
        heir_quorum:    req.heir_quorum,    heir_key_count:    req.heir_key_count,
        recovery_after: req.recovery_after, inheritance_after: req.inheritance_after,
    };
    // SpendingPath only models the three-leaf shape (founders_now /
    // recovery / inheritance) -- protector, backup, and
    // second_inheritance have no governance-audit equivalent here.
    // Silently falling through to FoundersNow for any of those (or any
    // typo) would rubber-stamp the audit as the MOST permissive path
    // (no timelock, founder_quorum only) for a spend that may need
    // different signers or a different timelock entirely -- reject
    // instead of guessing.
    let path = match req.path.as_str() {
        "founders_now" => SpendingPath::FoundersNow,
        "recovery"     => SpendingPath::Recovery,
        "inheritance"  => SpendingPath::Inheritance,
        other => return Err(api_err(
            400,
            format!("Unsupported governance path: {other} (expected founders_now, recovery, or inheritance)"),
        )),
    };
    let signer_statuses: Vec<SignerStatus> = req.signers.iter().enumerate().map(|(i, s)| SignerStatus {
        index:  s.get("index").and_then(|v| v.as_u64()).unwrap_or(i as u64) as usize,
        signed: s.get("signed").and_then(|v| v.as_bool()).unwrap_or(false),
        label:  s.get("label").and_then(|v| v.as_str()).map(String::from),
    }).collect();

    let spend = ProposedSpend {
        path, amount_sats: req.amount_sats, destination: req.destination,
        utxo_age_blocks: req.utxo_age_blocks, total_vault_sats: req.total_vault_sats,
        signer_statuses: signer_statuses.clone(),
    };
    let audit  = audit_spend(&policy, &spend);
    let eval   = evaluate_spend_proposal(&policy, path, req.utxo_age_blocks, &signer_statuses);
    let action = next_action(&eval);

    Ok(serde_json::json!({ "ok": true, "audit": audit, "evaluation": eval, "next_action": action }))
}

// ── /validate-address ───────────────────────────────────────────────────────
// vaults.js persists a client-supplied {address, descriptor,
// miniscript_policy} triple with no server-side re-derivation binding
// them together -- under this project's own compromised-coordinator
// threat model, nothing stopped a bad actor with control of the
// coordinator from silently swapping in an address the founder keys
// don't actually control, and a user funding it based on the UI
// showing "this is your vault" would lose everything to whoever DOES
// control that address. Full descriptor->address re-derivation (fully
// closing the gap) is a larger undertaking than fits this pass; this
// endpoint closes the simplest and most dangerous form of it -- a
// malformed, wrong-network, or outright garbage address string being
// persisted with literally zero validation.

#[derive(Deserialize)]
pub struct ValidateAddressRequest { pub address: String, pub network: String }

#[derive(Serialize)]
pub struct ValidateAddressResponse { pub ok: bool, pub valid: bool }

pub fn validate_address(req: ValidateAddressRequest) -> Result<ValidateAddressResponse, ServiceError> {
    let network = parse_network(&req.network).map_err(|e| api_err(400, e))?;
    let valid = req.address.parse::<bitcoin::Address<_>>()
        .map(|a| a.require_network(network).is_ok())
        .unwrap_or(false);
    Ok(ValidateAddressResponse { ok: true, valid })
}
