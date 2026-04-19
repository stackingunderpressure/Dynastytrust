use anyhow::{anyhow, Result};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use bitcoin::{
    absolute::LockTime, transaction::Version, Amount, Network, OutPoint,
    PublicKey, ScriptBuf, Transaction, TxIn, TxOut, Txid, Witness,
};
use bitcoin::psbt::Psbt;
use bitcoin::taproot::{LeafVersion, TaprootBuilder};
use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use dynastytrust_protocol::{
    audit_spend, build_multileaf_spend_info, compile_dynasty_policy,
    compile_dynasty_policy_tr, compile_dynasty_policy_tr_multileaf,
    compile_tranche_tr_multileaf, evaluate_spend_proposal,
    evaluate_vault_status, next_action, DynastyPolicy, ProposedSpend,
    SignerStatus, SpendingPath, TranchePolicy, VaultPolicy,
};
use miniscript::policy::concrete::Policy;
use miniscript::{psbt::PsbtExt, Miniscript};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, str::FromStr, sync::Arc};

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState { secret: Option<String> }

// ── Helpers ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ErrorResponse { ok: bool, error: String }

type ApiError = (StatusCode, Json<ErrorResponse>);

fn api_err(status: StatusCode, msg: impl ToString) -> ApiError {
    (status, Json(ErrorResponse { ok: false, error: msg.to_string() }))
}

fn check_auth(headers: &HeaderMap, state: &AppState) -> Result<(), ApiError> {
    let Some(ref secret) = state.secret else { return Ok(()); };
    let token = headers
        .get("authorization").or_else(|| headers.get("Authorization"))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if token != secret.as_str() {
        return Err(api_err(StatusCode::UNAUTHORIZED, "Invalid or missing compiler secret"));
    }
    Ok(())
}

fn parse_network(s: &str) -> Result<Network> {
    match s.to_lowercase().as_str() {
        "testnet"           => Ok(Network::Testnet),
        "bitcoin"|"mainnet" => Ok(Network::Bitcoin),
        other => Err(anyhow!("unknown network: {other}")),
    }
}

fn parse_pubkeys(keys: &[String]) -> Result<Vec<PublicKey>> {
    keys.iter()
        .map(|k| PublicKey::from_str(k).map_err(|e| anyhow!("bad pubkey {k}: {e}")))
        .collect()
}

const NUMS_HEX: &str = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

fn base64_encode(data: &[u8]) -> String {
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

// ── /health ───────────────────────────────────────────────────────────────────

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true, "service": "dynastytrust-compiler",
        "endpoints": ["/health","/compile","/compile-tranche","/psbt-binary","/psbt-finalize","/psbt-merge","/governance/status","/governance/audit"]
    }))
}

// ── /compile ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CompileRequest {
    name: Option<String>, network: String,
    founder_keys: Vec<String>, founder_quorum: usize,
    #[serde(default)] recovery_quorum: Option<usize>,
    heir_keys: Vec<String>,    heir_quorum: usize,
    recovery_after: u32,       inheritance_after: u32,
    #[serde(default = "default_addr_type")] address_type: String,
    #[serde(default)] protector_keys: Vec<String>,
    #[serde(default)] protector_quorum: Option<usize>,
    #[serde(default)] protector_after: Option<u32>,
    #[serde(default)] consent_keys: Vec<String>,
    #[serde(default)] consent_quorum: Option<usize>,
}
fn default_addr_type() -> String { "tr".to_string() }

#[derive(Serialize)]
struct CompileResponse {
    ok: bool, name: String, network: String, address_type: String,
    miniscript_policy: String, descriptor: String, address: String,
}

async fn compile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CompileRequest>,
) -> Result<Json<CompileResponse>, ApiError> {
    check_auth(&headers, &state)?;
    let network  = parse_network(&req.network).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let founders = parse_pubkeys(&req.founder_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let heirs    = parse_pubkeys(&req.heir_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let protectors = parse_pubkeys(&req.protector_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let consenters = parse_pubkeys(&req.consent_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let policy = DynastyPolicy {
        founder_keys: founders, founder_quorum: req.founder_quorum,
        recovery_quorum: req.recovery_quorum,
        heir_keys: heirs,       heir_quorum: req.heir_quorum,
        recovery_after: req.recovery_after, inheritance_after: req.inheritance_after,
        protector_keys: protectors,
        protector_quorum: req.protector_quorum,
        protector_after: req.protector_after,
        consent_keys: consenters,
        consent_quorum: req.consent_quorum,
    };
    let compiled = match req.address_type.as_str() {
        "wsh"          => compile_dynasty_policy(policy, network),
        "tr_multileaf" => compile_dynasty_policy_tr_multileaf(policy, network),
        _              => compile_dynasty_policy_tr(policy, network),
    }.map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(CompileResponse {
        ok: true, name: req.name.unwrap_or_else(|| "Vault".to_string()),
        network: req.network, address_type: compiled.address_type.to_string(),
        miniscript_policy: compiled.miniscript_policy,
        descriptor: compiled.descriptor, address: compiled.address.to_string(),
    }))
}

// ── /compile-tranche ─────────────────────────────────────────────────────────
// Single tranche of a T-vesting distribution wallet: beneficiary
// alone can claim after the absolute unlock block; trustees always
// retain an escape hatch. Callers build one of these per scheduled
// unlock (e.g. 12 for monthly over a year, 4 for quarterly).

#[derive(Deserialize)]
struct TrancheRequest {
    network: String,
    beneficiary_key: String,
    trustee_keys: Vec<String>,
    trustee_quorum: usize,
    unlock_block: u32,
}

#[derive(Serialize)]
struct TrancheResponse {
    ok: bool,
    network: String,
    miniscript_policy: String,
    descriptor: String,
    address: String,
    unlock_block: u32,
}

async fn compile_tranche(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<TrancheRequest>,
) -> Result<Json<TrancheResponse>, ApiError> {
    check_auth(&headers, &state)?;
    let network = parse_network(&req.network).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let beneficiary = PublicKey::from_str(&req.beneficiary_key)
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad beneficiary key: {e}")))?;
    let trustees = parse_pubkeys(&req.trustee_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let policy = TranchePolicy {
        beneficiary_key: beneficiary,
        trustee_keys: trustees,
        trustee_quorum: req.trustee_quorum,
        unlock_block: req.unlock_block,
    };
    let compiled = compile_tranche_tr_multileaf(policy, network)
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(TrancheResponse {
        ok: true,
        network: req.network,
        miniscript_policy: compiled.miniscript_policy,
        descriptor: compiled.descriptor,
        address: compiled.address.to_string(),
        unlock_block: req.unlock_block,
    }))
}

// ── /psbt-binary ─────────────────────────────────────────────────────────────
//
// Builds an unsigned PSBT with all hardware-wallet-required fields:
//   - witness_utxo     (required by ALL hardware wallets — BIP 174)
//   - tap_internal_key (tells wallet the keypath is NUMS/disabled)
//   - tap_scripts      (control block + leaf script — required by Coldcard, Passport, Keystone)
//   - witness_script   (for WSH inputs)

#[derive(Deserialize)]
struct UtxoInput {
    txid: String, vout: u32, value_sats: u64,
    script_pubkey: String,  // hex-encoded scriptPubKey of the UTXO being spent
}

#[derive(Deserialize)]
struct PsbtBinaryRequest {
    inputs: Vec<UtxoInput>,
    destination: String, amount_sats: u64, fee_sats: u64,
    change_address: String, network: String,
    // Policy params — used to recompile leaf script for tap_scripts attachment
    founder_keys:     Option<Vec<String>>,
    founder_quorum:   Option<usize>,
    heir_keys:        Option<Vec<String>>,
    heir_quorum:      Option<usize>,
    recovery_after:   Option<u32>,
    inheritance_after: Option<u32>,
    address_type:     Option<String>,
    #[serde(default)] consent_keys:   Vec<String>,
    #[serde(default)] consent_quorum: Option<usize>,
    #[serde(default)] recovery_quorum: Option<usize>,
    #[serde(default)] protector_keys: Vec<String>,
    #[serde(default)] protector_quorum: Option<usize>,
    #[serde(default)] protector_after: Option<u32>,
    // Fallback raw scripts (if policy params not provided)
    leaf_script_hex:    Option<String>,
    witness_script_hex: Option<String>,
}

#[derive(Serialize)]
struct PsbtBinaryResponse {
    ok: bool, psbt_hex: String, psbt_b64: String,
    input_count: usize, output_count: usize, fee_sats: u64, has_tap_leaf: bool,
}

async fn psbt_binary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<PsbtBinaryRequest>,
) -> Result<Json<PsbtBinaryResponse>, ApiError> {
    check_auth(&headers, &state)?;

    if req.inputs.is_empty() {
        return Err(api_err(StatusCode::BAD_REQUEST, "No inputs provided"));
    }

    let network = parse_network(&req.network).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let total_in: u64 = req.inputs.iter().map(|u| u.value_sats).sum();
    let total_need = req.amount_sats.checked_add(req.fee_sats)
        .ok_or_else(|| api_err(StatusCode::BAD_REQUEST, "amount + fee overflow"))?;

    if total_in < total_need {
        return Err(api_err(StatusCode::BAD_REQUEST,
            format!("Insufficient funds: have {total_in} sats, need {total_need} sats")));
    }

    let change_value = total_in - total_need;
    let has_change   = change_value >= 546;

    // Bail on any malformed txid rather than silently substituting
    // a zero-hash placeholder (which would produce an unspendable
    // tx that looks fine until broadcast).
    let tx_inputs: Vec<TxIn> = req.inputs.iter().map(|u| {
        let txid = Txid::from_str(&u.txid)
            .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad txid {}: {e}", u.txid)))?;
        Ok(TxIn {
            previous_output: OutPoint { txid, vout: u.vout },
            script_sig: ScriptBuf::new(),
            sequence: bitcoin::Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::default(),
        })
    }).collect::<Result<Vec<_>, ApiError>>()?;

    let dest_addr = req.destination.parse::<bitcoin::Address<_>>()
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad destination: {e}")))?
        .require_network(network)
        .map_err(|_| api_err(StatusCode::BAD_REQUEST, "destination network mismatch"))?;

    let mut tx_outputs = vec![TxOut {
        value: Amount::from_sat(req.amount_sats),
        script_pubkey: dest_addr.script_pubkey(),
    }];

    if has_change {
        let change_addr = req.change_address.parse::<bitcoin::Address<_>>()
            .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad change address: {e}")))?
            .require_network(network)
            .map_err(|_| api_err(StatusCode::BAD_REQUEST, "change address network mismatch"))?;
        tx_outputs.push(TxOut {
            value: Amount::from_sat(change_value),
            script_pubkey: change_addr.script_pubkey(),
        });
    }

    let tx = Transaction {
        version: Version::TWO, lock_time: LockTime::ZERO,
        input: tx_inputs, output: tx_outputs,
    };

    let output_count = tx.output.len();
    let mut psbt = Psbt::from_unsigned_tx(tx)
        .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, format!("PSBT: {e}")))?;

    // Build the FULL multileaf taproot tree so the control block
    // attached to tap_scripts proves against the real vault's merkle
    // root -- rebuilding only the founders-now leaf produced a
    // mismatched root and the finalizer rejected the spend with
    // "Control block verification failed at index 0".
    let addr_type = req.address_type.as_deref().unwrap_or("tr");
    let full_spend_info: Option<(bitcoin::taproot::TaprootSpendInfo, ScriptBuf)> = if let (
        Some(fk), Some(fq), Some(hk), Some(hq), Some(ra), Some(ia)
    ) = (
        req.founder_keys.as_ref(), req.founder_quorum,
        req.heir_keys.as_ref(),    req.heir_quorum,
        req.recovery_after,        req.inheritance_after,
    ) {
        match (
            parse_pubkeys(fk),
            parse_pubkeys(hk),
            parse_pubkeys(&req.protector_keys),
            parse_pubkeys(&req.consent_keys),
        ) {
            (Ok(founders), Ok(heirs), Ok(protectors), Ok(consenters)) => {
                let pol = DynastyPolicy {
                    founder_keys: founders, founder_quorum: fq,
                    recovery_quorum: req.recovery_quorum,
                    heir_keys: heirs,       heir_quorum: hq,
                    recovery_after: ra,     inheritance_after: ia,
                    protector_keys: protectors,
                    protector_quorum: req.protector_quorum,
                    protector_after: req.protector_after,
                    consent_keys: consenters,
                    consent_quorum: req.consent_quorum,
                };
                build_multileaf_spend_info(&pol).ok()
            }
            _ => None,
        }
    } else {
        None
    };

    let _ = addr_type; // kept for future use
    let witness_script: Option<ScriptBuf> =
        req.witness_script_hex.as_ref().and_then(|h| hex::decode(h).ok().map(ScriptBuf::from_bytes));

    let has_tap_leaf = full_spend_info.is_some();

    for (i, utxo_in) in req.inputs.iter().enumerate() {
        // witness_utxo — mandatory for all hardware wallets
        let spk_bytes = hex::decode(&utxo_in.script_pubkey).unwrap_or_default();
        let spk = ScriptBuf::from_bytes(spk_bytes);
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
            }
        }

        if spk.is_p2wsh() {
            if let Some(ref ws) = witness_script {
                psbt.inputs[i].witness_script = Some(ws.clone());
            }
        }
    }

    let psbt_bytes = psbt.serialize();
    Ok(Json(PsbtBinaryResponse {
        ok: true, psbt_hex: hex::encode(&psbt_bytes), psbt_b64: base64_encode(&psbt_bytes),
        input_count: req.inputs.len(), output_count, fee_sats: req.fee_sats, has_tap_leaf,
    }))
}

fn build_founders_leaf_script(policy: &DynastyPolicy, addr_type: &str) -> Result<ScriptBuf> {
    let founders: Vec<String> = policy.founder_keys.iter().map(|k| format!("pk({k})")).collect();
    let trustee_thresh = format!("thresh({},{})", policy.founder_quorum, founders.join(","));
    let founder_thresh = if policy.has_consent() {
        let consenters: Vec<String> = policy.consent_keys.iter().map(|k| format!("pk({k})")).collect();
        let consent_thresh = format!(
            "thresh({},{})",
            policy.consent_quorum.unwrap(),
            consenters.join(","),
        );
        format!("and({},{})", trustee_thresh, consent_thresh)
    } else {
        trustee_thresh
    };

    if addr_type == "wsh" {
        let heirs: Vec<String> = policy.heir_keys.iter().map(|k| format!("pk({k})")).collect();
        let recovery = format!("and(after({}),{})", policy.recovery_after, founder_thresh);
        let inheritance = format!("and(after({}),thresh({},{}))",
            policy.inheritance_after, policy.heir_quorum, heirs.join(","));
        let full = format!("or({},or({},{}))", founder_thresh, recovery, inheritance);
        let ms: Miniscript<PublicKey, miniscript::Segwitv0> = full
            .parse::<Policy<PublicKey>>().map_err(|e| anyhow!("{e:?}"))?
            .compile().map_err(|e| anyhow!("{e:?}"))?;
        Ok(ms.encode())
    } else {
        let ms: Miniscript<PublicKey, miniscript::Tap> = founder_thresh
            .parse::<Policy<PublicKey>>().map_err(|e| anyhow!("{e:?}"))?
            .compile().map_err(|e| anyhow!("{e:?}"))?;
        Ok(ms.encode())
    }
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
struct FinalizeRequest {
    psbt_hex: String,
}

#[derive(Serialize)]
struct FinalizeResponse {
    ok:          bool,
    raw_tx_hex:  String,
    txid:        String,
    input_count: usize,
    output_count: usize,
    vbytes:      usize,
}

async fn psbt_finalize(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<FinalizeRequest>,
) -> Result<Json<FinalizeResponse>, ApiError> {
    check_auth(&headers, &state)?;

    let bytes = hex::decode(&req.psbt_hex)
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad PSBT hex: {e}")))?;

    let mut psbt = Psbt::deserialize(&bytes)
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("PSBT deserialize: {e}")))?;

    // Verify the PSBT has signatures before attempting finalization
    let has_sigs = psbt.inputs.iter().any(|inp|
        !inp.tap_script_sigs.is_empty() || !inp.partial_sigs.is_empty()
    );
    if !has_sigs {
        return Err(api_err(StatusCode::BAD_REQUEST,
            "PSBT has no signatures. Sign it with your hardware wallet first, then finalize."));
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
            let hint = if lower.contains("control block") {
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
            api_err(StatusCode::BAD_REQUEST,
                format!("Finalization failed: {joined}. {hint}"))
        })?;

    // Extract the raw transaction (strips PSBT wrapper)
    let raw_tx = psbt.extract_tx()
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("Extract tx: {e}")))?;

    let raw_tx_bytes = bitcoin::consensus::encode::serialize(&raw_tx);
    let raw_tx_hex   = hex::encode(&raw_tx_bytes);
    let txid         = raw_tx.txid().to_string();
    let input_count  = raw_tx.input.len();
    let output_count = raw_tx.output.len();

    // Virtual bytes via Weight type (bitcoin 0.31 canonical API)
    let vbytes = raw_tx.weight().to_vbytes_ceil() as usize;

    Ok(Json(FinalizeResponse {
        ok: true, raw_tx_hex, txid,
        input_count, output_count, vbytes,
    }))
}

// ── /psbt-merge ───────────────────────────────────────────────────────────────
//
// Merges N partially-signed PSBTs into one combined PSBT.
// All input PSBTs must share the same unsigned transaction.

#[derive(Deserialize)]
struct PsbtMergeRequest {
    psbts: Vec<String>,  // hex-encoded, minimum 2
}

#[derive(Serialize)]
struct PsbtMergeResponse {
    ok: bool, psbt_hex: String, psbt_b64: String,
    input_count: usize, signature_count: usize,
}

async fn psbt_merge(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<PsbtMergeRequest>,
) -> Result<Json<PsbtMergeResponse>, ApiError> {
    check_auth(&headers, &state)?;

    if req.psbts.len() < 2 {
        return Err(api_err(StatusCode::BAD_REQUEST, "Provide at least 2 PSBTs"));
    }

    let mut psbts: Vec<Psbt> = req.psbts.iter().map(|h| {
        let bytes = hex::decode(h).map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad hex: {e}")))?;
        Psbt::deserialize(&bytes).map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("PSBT parse: {e}")))
    }).collect::<Result<_, _>>()?;

    let mut merged = psbts.remove(0);
    for other in psbts {
        merged.combine(other)
            .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("merge: {e}")))?;
    }

    let signature_count: usize = merged.inputs.iter()
        .map(|inp| inp.tap_script_sigs.len() + inp.partial_sigs.len())
        .sum();

    let psbt_bytes = merged.serialize();
    Ok(Json(PsbtMergeResponse {
        ok: true, psbt_hex: hex::encode(&psbt_bytes), psbt_b64: base64_encode(&psbt_bytes),
        input_count: merged.inputs.len(), signature_count,
    }))
}

// ── /governance/status ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GovernanceStatusRequest {
    founder_quorum: usize, founder_key_count: usize,
    heir_quorum: usize,    heir_key_count: usize,
    recovery_after: u32,   inheritance_after: u32,
    utxo_age_blocks: u32,
}

async fn governance_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<GovernanceStatusRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    check_auth(&headers, &state)?;
    // Input validation
    if req.founder_quorum == 0 || req.heir_quorum == 0 {
        return Err(api_err(StatusCode::BAD_REQUEST, "quorum must be > 0"));
    }
    let status = evaluate_vault_status(&VaultPolicy {
        founder_quorum: req.founder_quorum, founder_key_count: req.founder_key_count,
        heir_quorum:    req.heir_quorum,    heir_key_count:    req.heir_key_count,
        recovery_after: req.recovery_after, inheritance_after: req.inheritance_after,
    }, req.utxo_age_blocks);
    Ok(Json(serde_json::to_value(&status).unwrap()))
}

// ── /governance/audit ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GovernanceAuditRequest {
    founder_quorum: usize, founder_key_count: usize,
    heir_quorum: usize,    heir_key_count: usize,
    recovery_after: u32,   inheritance_after: u32,
    path: String,
    amount_sats: u64, destination: String,
    utxo_age_blocks: u32, total_vault_sats: u64,
    #[serde(default)]
    signers: Vec<serde_json::Value>,
}

async fn governance_audit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<GovernanceAuditRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    check_auth(&headers, &state)?;

    if req.founder_quorum == 0 || req.heir_quorum == 0 {
        return Err(api_err(StatusCode::BAD_REQUEST, "quorum must be > 0"));
    }
    if req.destination.is_empty() {
        return Err(api_err(StatusCode::BAD_REQUEST, "destination is required"));
    }

    let policy = VaultPolicy {
        founder_quorum: req.founder_quorum, founder_key_count: req.founder_key_count,
        heir_quorum:    req.heir_quorum,    heir_key_count:    req.heir_key_count,
        recovery_after: req.recovery_after, inheritance_after: req.inheritance_after,
    };
    let path = match req.path.as_str() {
        "recovery"    => SpendingPath::Recovery,
        "inheritance" => SpendingPath::Inheritance,
        _             => SpendingPath::FoundersNow,
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

    Ok(Json(serde_json::json!({ "ok": true, "audit": audit, "evaluation": eval, "next_action": action })))
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let secret = std::env::var("COMPILER_SECRET").ok();
    if secret.is_none() { eprintln!("WARNING: COMPILER_SECRET not set — dev mode"); }

    let state = Arc::new(AppState { secret });
    let app = Router::new()
        .route("/health",            get(health))
        .route("/compile",           post(compile))
        .route("/compile-tranche",   post(compile_tranche))
        .route("/psbt-binary",       post(psbt_binary))
        .route("/psbt-finalize",     post(psbt_finalize))
        .route("/psbt-merge",        post(psbt_merge))
        .route("/governance/status", post(governance_status))
        .route("/governance/audit",  post(governance_audit))
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("DynastyTrust compiler on http://{addr}");
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app).await.unwrap();
}
