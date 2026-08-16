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
use bitcoin::taproot::LeafVersion;
use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use dynastytrust_protocol::{
    attach_tap_change_output_metadata, attach_tap_key_origins, audit_spend, build_bloc_spend_psbt,
    build_leaf_multileaf, build_multileaf, build_tranche_spend_psbt, compile_dynasty_bloc_tr_multileaf,
    compile_dynasty_policy, compile_dynasty_policy_tr, compile_dynasty_policy_tr_multileaf,
    compile_tranche_tr_multileaf, evaluate_spend_proposal, evaluate_vault_status, next_action,
    BlocSpendRequest, DynastyBlocPolicy, DynastyPolicy, KeyOrigin, ProposedSpend, SignerStatus,
    SpendingPath, TranchePolicy, TrancheSpendRequest, Unlock, VaultPolicy, VaultUTXO,
};
use miniscript::psbt::PsbtExt;
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, str::FromStr, sync::Arc};

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState { secret: Option<String> }

// ── Helpers ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ErrorResponse { ok: bool, error: String }

type ApiError = (StatusCode, Json<ErrorResponse>);

fn api_err(status: StatusCode, msg: impl ToString) -> ApiError {
    (status, Json(ErrorResponse { ok: false, error: msg.to_string() }))
}

/// Constant-time byte comparison -- avoids leaking the secret's length-
/// prefix match via response timing the way `token != secret` would.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn check_auth(headers: &HeaderMap, state: &AppState) -> Result<(), ApiError> {
    // Fail CLOSED, not open: an unset COMPILER_SECRET must never mean
    // "accept every request." This service sits on the public internet
    // (Fly.io) and every mutating endpoint (PSBT building, vault
    // compilation) is reachable with no auth at all if this check is
    // ever satisfied by a misconfiguration rather than a real secret.
    let Some(ref secret) = state.secret else {
        return Err(api_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "Compiler is not configured with a secret -- refusing all requests until COMPILER_SECRET is set",
        ));
    };
    let token = headers
        .get("authorization").or_else(|| headers.get("Authorization"))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !constant_time_eq(token.as_bytes(), secret.as_bytes()) {
        return Err(api_err(StatusCode::UNAUTHORIZED, "Invalid or missing compiler secret"));
    }
    Ok(())
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with_bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        h
    }

    #[test]
    fn unset_secret_rejects_every_request() {
        let state = AppState { secret: None };
        let result = check_auth(&headers_with_bearer("anything"), &state);
        assert!(result.is_err(), "an unconfigured secret must fail closed, not open");
        let result_no_header = check_auth(&HeaderMap::new(), &state);
        assert!(result_no_header.is_err());
    }

    #[test]
    fn correct_token_is_accepted() {
        let state = AppState { secret: Some("s3cr3t".to_string()) };
        assert!(check_auth(&headers_with_bearer("s3cr3t"), &state).is_ok());
    }

    #[test]
    fn wrong_token_is_rejected() {
        let state = AppState { secret: Some("s3cr3t".to_string()) };
        assert!(check_auth(&headers_with_bearer("wrong"), &state).is_err());
    }

    #[test]
    fn missing_header_is_rejected_when_secret_is_configured() {
        let state = AppState { secret: Some("s3cr3t".to_string()) };
        assert!(check_auth(&HeaderMap::new(), &state).is_err());
    }

    #[test]
    fn constant_time_eq_matches_standard_equality() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
        assert!(constant_time_eq(b"", b""));
    }
}

// Shared by every non-auth-focused test below (psbt_binary_tests,
// psbt_binary_tranche_tests, and the compile tests) so they can call a
// handler directly without exercising check_auth's own behavior --
// those tests are about PSBT/compile construction, not auth. Since
// check_auth now fails closed on an unset secret, they need a real
// secret + matching header rather than the old `secret: None` shortcut.
#[cfg(test)]
fn test_auth_state_and_headers() -> (Arc<AppState>, HeaderMap) {
    const TEST_SECRET: &str = "test-secret-for-unit-tests";
    let state = Arc::new(AppState { secret: Some(TEST_SECRET.to_string()) });
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        axum::http::HeaderValue::from_str(&format!("Bearer {TEST_SECRET}")).unwrap(),
    );
    (state, headers)
}

fn parse_network(s: &str) -> Result<Network> {
    match s.to_lowercase().as_str() {
        "testnet"           => Ok(Network::Testnet),
        "signet"            => Ok(Network::Signet),
        "bitcoin"|"mainnet" => Ok(Network::Bitcoin),
        other => Err(anyhow!("unknown network: {other}")),
    }
}

fn parse_pubkeys(keys: &[String]) -> Result<Vec<PublicKey>> {
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
struct LeafUnlockWire {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    blocks: Option<u32>,
}

#[derive(Deserialize)]
struct LeafDecayWire {
    step_blocks: u32,
    floor_quorum: usize,
}

#[derive(Deserialize)]
struct LeafSpecWire {
    id: String,
    label: String,
    keys: Vec<String>,
    quorum: usize,
    unlock: LeafUnlockWire,
    #[serde(default)]
    decay: Option<LeafDecayWire>,
}

fn parse_leaf_policy(
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
        "endpoints": ["/health","/compile","/compile-bloc","/compile-tranche","/psbt-binary","/psbt-binary-bloc","/psbt-binary-tranche","/psbt-finalize","/psbt-merge","/governance/status","/governance/audit"]
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
    /// "Anytime, harder" fallback (2026-08-08) -- an untimelocked branch
    /// over a SEPARATE key set the owner controls directly, occupying the
    /// same tree slot the timelocked recovery branch would. Mutually
    /// exclusive with recovery_after > 0; see DynastyPolicy::has_backup.
    #[serde(default)] backup_keys: Vec<String>,
    #[serde(default)] backup_quorum: Option<usize>,
    /// Second, independent inheritance leaf (2026-08-11) -- a distinct
    /// heir cohort with its own key set, quorum, and absolute timelock
    /// alongside the primary heir_keys/heir_quorum/inheritance_after
    /// leaf. See DynastyPolicy::has_second_inheritance.
    #[serde(default)] second_heir_keys: Vec<String>,
    #[serde(default)] second_heir_quorum: Option<usize>,
    #[serde(default)] second_inheritance_after: Option<u32>,
}
fn default_addr_type() -> String { "tr".to_string() }

#[derive(Serialize)]
struct CompileResponse {
    ok: bool, name: String, network: String, address_type: String,
    miniscript_policy: String, descriptor: String, address: String,
    /// Hex-encoded tapscript leaf bytes for a tr_multileaf vault, keyed by
    /// role ("founders_now", "recovery" OR "backup" -- mutually exclusive,
    /// "inheritance", "protector") -- present only for the roles the
    /// policy actually compiled a leaf for.
    /// None for non-multileaf address types. This is what a vault-membership
    /// attestation (DynastyTrust -> Tapit Cut C3) names per signer so the
    /// receiving wallet can later verify a psbt-cosign request's tapLeafScript
    /// against a leaf it was actually told about at vault-creation time,
    /// not merely a leaf that arrives labeled with a familiar descriptor.
    #[serde(skip_serializing_if = "Option::is_none")]
    leaf_scripts: Option<std::collections::HashMap<String, String>>,
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
    let backups = parse_pubkeys(&req.backup_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let second_heirs = parse_pubkeys(&req.second_heir_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
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
    }.map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
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
            if let Some(l) = &out.protector_leaf {
                m.insert("protector".to_string(), hex::encode(l.as_bytes()));
            }
            if let Some(l) = &out.second_inheritance_leaf {
                m.insert("second_inheritance".to_string(), hex::encode(l.as_bytes()));
            }
            m
        })
    } else {
        None
    };
    Ok(Json(CompileResponse {
        ok: true, name: req.name.unwrap_or_else(|| "Vault".to_string()),
        network: req.network, address_type: compiled.address_type.to_string(),
        miniscript_policy: compiled.miniscript_policy,
        descriptor: compiled.descriptor, address: compiled.address.to_string(),
        leaf_scripts,
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
struct CompileBlocRequest {
    name: Option<String>,
    network: String,
    parent_keys: Vec<String>,
    parents_together_quorum: usize,
    coparent_quorum: usize,
    kid_keys: Vec<String>,
    kids_with_parent_quorum: usize,
    parent_solo_after: u32,
    parent_solo_quorum: usize,
    kids_decay_start_after: u32,
    kids_decay_step_blocks: u32,
    kids_decay_start_quorum: usize,
    kids_decay_floor_quorum: usize,
}

async fn compile_bloc(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CompileBlocRequest>,
) -> Result<Json<CompileResponse>, ApiError> {
    check_auth(&headers, &state)?;
    let network = parse_network(&req.network).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let parents = parse_pubkeys(&req.parent_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let kids = parse_pubkeys(&req.kid_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
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
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(CompileResponse {
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
    #[serde(default)] backup_keys: Vec<String>,
    #[serde(default)] backup_quorum: Option<usize>,
    // Second, independent inheritance leaf (2026-08-11) -- see
    // DynastyPolicy::has_second_inheritance.
    #[serde(default)] second_heir_keys: Vec<String>,
    #[serde(default)] second_heir_quorum: Option<usize>,
    #[serde(default)] second_inheritance_after: Option<u32>,
    // Which leaf the caller intends to spend via. Needed so we can
    // set tx.lock_time for CLTV-gated paths; founders_now and backup
    // both leave lock_time at 0. Values: "founders_now" | "recovery" |
    // "inheritance" | "protector" | "backup" | "second_inheritance".
    #[serde(default)] path: Option<String>,
    // Fallback raw witness script (if policy params not provided)
    witness_script_hex: Option<String>,
    // BIP32 origins for this vault's signers (2026-08-06 hardware-wallet
    // fix) -- see attach_tap_key_origins's doc comment in psbt_builder.rs
    // for the full rationale. Optional and additive.
    #[serde(default)]
    key_origins: Vec<KeyOrigin>,
    // Generic leaf-list vault (toggle-a-leaf builder), additive alongside
    // every named field above. When present, this is authoritative over
    // the named fields, and `path` is looked up as a leaf id in this list
    // instead of the fixed founders_now/recovery/inheritance/protector/
    // backup/second_inheritance switch. Reuses `consent_keys`/
    // `consent_quorum` above -- consent gates the primary leaf the same
    // way in both shapes, no separate field needed.
    #[serde(default)]
    leaves: Option<Vec<LeafSpecWire>>,
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

    // Path selection has two shapes now. Generic (req.leaves present):
    // `path` is an arbitrary leaf id the caller's own LeafPolicy declares;
    // the leaf's own Unlock (Immediate/After/OlderThan) says whether
    // tx.lock_time or the spending inputs' nSequence needs setting --
    // CLTV and CSV are two different transaction fields, never
    // interchangeable. Named (legacy): founders_now leaves lock_time at
    // 0; recovery/inheritance/protector set it to the stored absolute
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
            .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad leaf policy: {e}")))?;
        Some(
            build_leaf_multileaf(&policy)
                .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("leaf policy rejected: {e}")))?,
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
            parse_pubkeys(&req.protector_keys),
            parse_pubkeys(&req.consent_keys),
            parse_pubkeys(&req.backup_keys),
        ) {
            (Ok(founders), Ok(heirs), Ok(protectors), Ok(consenters), Ok(backups)) => {
                match parse_pubkeys(&req.second_heir_keys) {
                    Ok(second_heirs) => {
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
                return Err(api_err(StatusCode::BAD_REQUEST, format!("Unknown path: {intended_path}")));
            }
            let unlock = out.and_then(|o| o.leaf_unlocks.iter().find(|(id, _)| id == intended_path).map(|(_, u)| *u));
            match unlock {
                Some(Unlock::Immediate) | None => (leaf, LockTime::ZERO, None),
                Some(Unlock::After { blocks }) if blocks > 0 => {
                    let lt = LockTime::from_height(blocks)
                        .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad lock_time {blocks}: {e}")))?;
                    (leaf, lt, None)
                }
                Some(Unlock::After { .. }) => (leaf, LockTime::ZERO, None),
                Some(Unlock::OlderThan { blocks }) => (leaf, LockTime::ZERO, Some(blocks)),
            }
        } else {
            const VALID_PATHS: &[&str] = &[
                "founders_now", "recovery", "inheritance", "protector", "backup", "second_inheritance",
            ];
            if !VALID_PATHS.contains(&intended_path) {
                return Err(api_err(StatusCode::BAD_REQUEST, format!("Unknown path: {intended_path}")));
            }
            let locktime_height: Option<u32> = match intended_path {
                "recovery" => req.recovery_after,
                "inheritance" => req.inheritance_after,
                "protector" => req.protector_after,
                "second_inheritance" => req.second_inheritance_after,
                _ => None,
            };
            let lt = match locktime_height {
                Some(h) if h > 0 => LockTime::from_height(h)
                    .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad lock_time {h}: {e}")))?,
                _ => LockTime::ZERO,
            };
            // "backup" shares recovery_leaf's tree slot -- see
            // MultileafOutput's doc comment (policy_compiler.rs). It is
            // never CLTV-gated (falls to the default no-timelock case
            // above) and never relative either.
            let leaf = full_output.as_ref().and_then(|out| match intended_path {
                "recovery" | "backup" => out.recovery_leaf.clone(),
                "inheritance" => out.inheritance_leaf.clone(),
                "protector" => out.protector_leaf.clone(),
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
        .map_err(|e| api_err(StatusCode::INTERNAL_SERVER_ERROR, format!("PSBT: {e}")))?;

    // BIP68 relative locktime (older()) is enforced through the SPENDING
    // input's nSequence, never through tx.lock_time -- that's CLTV's
    // field, not CSV's. Applied to every input the same whole-transaction
    // granularity lock_time already uses above, since this compiler's
    // model spends every input of a given PSBT via the same intended
    // path. `blocks` is guaranteed <= MAX_RELATIVE_BLOCKS (well under
    // BIP68's u16 ceiling) by build_leaf_multileaf's own verify_leaf_policy
    // call above, so the cast below can't truncate.
    if let Some(blocks) = needs_relative_sequence {
        let seq = bitcoin::Sequence::from_height(blocks as u16);
        for input in psbt.unsigned_tx.input.iter_mut() {
            input.sequence = seq;
        }
    }

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
            let compiled_change_script = bitcoin::ScriptBuf::new_p2tr_tweaked(out.spend_info.output_key());
            if psbt.unsigned_tx.output[1].script_pubkey != compiled_change_script {
                return Err(api_err(
                    StatusCode::BAD_REQUEST,
                    "change_address does not match the address this policy actually compiles to",
                ));
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
                    .chain(out.protector_leaf.as_ref())
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
            StatusCode::BAD_REQUEST,
            format!("bad script_pubkey for input {}:{}: {e}", utxo_in.txid, utxo_in.vout),
        ))?;
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
    Ok(Json(PsbtBinaryResponse {
        ok: true, psbt_hex: hex::encode(&psbt_bytes), psbt_b64: base64_encode(&psbt_bytes),
        input_count: req.inputs.len(), output_count, fee_sats: req.fee_sats, has_tap_leaf,
    }))
}

// ── /psbt-binary-bloc ────────────────────────────────────────────────────────
// Build an unsigned PSBT that spends a Dynasty Bloc UTXO via a chosen leaf.
// Timelock fields are ABSOLUTE CLTV heights (the stored vault values); the
// caller passes them straight through -- no tip conversion here, unlike
// /compile-bloc. `path` (+ `quorum` for decay rungs) selects the leaf; the
// protocol builder rebuilds the SAME tree the address came from, so the
// attached control block proves against the real merkle root.

#[derive(Deserialize)]
struct PsbtBinaryBlocRequest {
    inputs: Vec<UtxoInput>,
    destination: String,
    amount_sats: u64,
    fee_sats: u64,
    change_address: String,
    network: String,
    path: String,
    #[serde(default)]
    quorum: usize,
    parent_keys: Vec<String>,
    parents_together_quorum: usize,
    coparent_quorum: usize,
    kid_keys: Vec<String>,
    kids_with_parent_quorum: usize,
    parent_solo_after: u32,
    parent_solo_quorum: usize,
    kids_decay_start_after: u32,
    kids_decay_step_blocks: u32,
    kids_decay_start_quorum: usize,
    kids_decay_floor_quorum: usize,
    // BIP32 origins for this vault's signers (2026-08-06 hardware-wallet
    // fix). Optional and additive -- see PsbtBinaryRequest's own field.
    #[serde(default)]
    key_origins: Vec<KeyOrigin>,
}

async fn psbt_binary_bloc(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<PsbtBinaryBlocRequest>,
) -> Result<Json<PsbtBinaryResponse>, ApiError> {
    check_auth(&headers, &state)?;

    if req.inputs.is_empty() {
        return Err(api_err(StatusCode::BAD_REQUEST, "No inputs provided"));
    }

    let parents = parse_pubkeys(&req.parent_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let kids = parse_pubkeys(&req.kid_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;

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
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;

    let output_count = psbt.unsigned_tx.output.len();
    let input_count = psbt.inputs.len();
    let psbt_bytes = psbt.serialize();
    Ok(Json(PsbtBinaryResponse {
        ok: true,
        psbt_hex: hex::encode(&psbt_bytes),
        psbt_b64: base64_encode(&psbt_bytes),
        input_count,
        output_count,
        fee_sats: req.fee_sats,
        has_tap_leaf: true,
    }))
}

// ── /psbt-binary-tranche ─────────────────────────────────────────────────────
// Spend a single T-vesting tranche's UTXO -- either the beneficiary
// claiming after the timelock, or a trustee using the escape hatch.
// The policy params (beneficiary_key, trustee_keys, trustee_quorum,
// unlock_block) are the SAME ones the ceremony used to call
// /compile-tranche when the tranche was created, so recompiling here
// reproduces the exact tree the tranche's address was funded at.

#[derive(Deserialize)]
struct PsbtBinaryTrancheRequest {
    inputs: Vec<UtxoInput>,
    destination: String,
    amount_sats: u64,
    fee_sats: u64,
    change_address: String,
    network: String,
    beneficiary_key: String,
    trustee_keys: Vec<String>,
    trustee_quorum: usize,
    unlock_block: u32,
    // "beneficiary" or "trustee" -- see TrancheSpendRequest's doc.
    path: String,
    #[serde(default)]
    key_origins: Vec<KeyOrigin>,
}

async fn psbt_binary_tranche(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<PsbtBinaryTrancheRequest>,
) -> Result<Json<PsbtBinaryResponse>, ApiError> {
    check_auth(&headers, &state)?;

    if req.inputs.is_empty() {
        return Err(api_err(StatusCode::BAD_REQUEST, "No inputs provided"));
    }

    let beneficiary_key = PublicKey::from_str(&req.beneficiary_key)
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, format!("bad beneficiary_key: {e}")))?;
    let trustee_keys =
        parse_pubkeys(&req.trustee_keys).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;

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
        .map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;

    let output_count = psbt.unsigned_tx.output.len();
    let input_count = psbt.inputs.len();
    let psbt_bytes = psbt.serialize();
    Ok(Json(PsbtBinaryResponse {
        ok: true,
        psbt_hex: hex::encode(&psbt_bytes),
        psbt_b64: base64_encode(&psbt_bytes),
        input_count,
        output_count,
        fee_sats: req.fee_sats,
        has_tap_leaf: true,
    }))
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
    // Legacy field name: this is the CURRENT CHAIN TIP HEIGHT (absolute), not
    // UTXO age. Timelocks are absolute CLTV; recovery_after/inheritance_after
    // are absolute heights, so callers must pass the chain tip here.
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
    // Legacy field name: CURRENT CHAIN TIP HEIGHT (absolute), not UTXO age.
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
            StatusCode::BAD_REQUEST,
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

    Ok(Json(serde_json::json!({ "ok": true, "audit": audit, "evaluation": eval, "next_action": action })))
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
struct ValidateAddressRequest { address: String, network: String }

#[derive(Serialize)]
struct ValidateAddressResponse { ok: bool, valid: bool }

async fn validate_address(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ValidateAddressRequest>,
) -> Result<Json<ValidateAddressResponse>, ApiError> {
    check_auth(&headers, &state)?;
    let network = parse_network(&req.network).map_err(|e| api_err(StatusCode::BAD_REQUEST, e))?;
    let valid = req.address.parse::<bitcoin::Address<_>>()
        .map(|a| a.require_network(network).is_ok())
        .unwrap_or(false);
    Ok(Json(ValidateAddressResponse { ok: true, valid }))
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
        .route("/compile-bloc",      post(compile_bloc))
        .route("/compile-tranche",   post(compile_tranche))
        .route("/psbt-binary",       post(psbt_binary))
        .route("/psbt-binary-bloc",  post(psbt_binary_bloc))
        .route("/psbt-binary-tranche", post(psbt_binary_tranche))
        .route("/psbt-finalize",     post(psbt_finalize))
        .route("/psbt-merge",        post(psbt_merge))
        .route("/governance/status", post(governance_status))
        .route("/governance/audit",  post(governance_audit))
        .route("/validate-address",  post(validate_address))
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("DynastyTrust compiler on http://{addr}");
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app).await.unwrap();
}

// 2026-08-06 fix regression coverage. This is the actual bug the operator
// hit: /psbt-binary always attached the founders-now leaf's control block
// regardless of `path`, and never attached tap_key_origins at all -- the
// combination is why a hardware wallet asked to sign a non-founders spend
// had no chance (wrong leaf AND no way to recognize its own key even on
// the right one). These tests call the handler directly (no HTTP server
// needed -- an axum handler is just an async function) and inspect the
// actual PSBT bytes it returns.
#[cfg(test)]
mod psbt_binary_tests {
    use super::*;
    use dynastytrust_protocol::compile_dynasty_policy_tr_multileaf;

    const FOUNDER_A: &str = "02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97";
    const FOUNDER_B: &str = "02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569";
    const HEIR_A: &str = "03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34";

    fn sample_policy() -> DynastyPolicy {
        DynastyPolicy {
            founder_keys: vec![
                PublicKey::from_str(FOUNDER_A).unwrap(),
                PublicKey::from_str(FOUNDER_B).unwrap(),
            ],
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: vec![PublicKey::from_str(HEIR_A).unwrap()],
            heir_quorum: 1,
            recovery_after: 100_000,
            inheritance_after: 200_000,
            protector_keys: vec![],
            protector_quorum: None,
            protector_after: None,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        }
    }

    const BACKUP_A: &str = "025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc";
    const BACKUP_B: &str = "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
    const BACKUP_C: &str = "03fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556";

    /// Same shape as sample_policy() but with recovery_after cleared and
    /// a 2-of-3 backup branch (own key set, no timelock) in its place --
    /// the "anytime, harder" fallback.
    fn sample_backup_policy() -> DynastyPolicy {
        let mut p = sample_policy();
        p.recovery_after = 0;
        p.backup_keys = vec![
            PublicKey::from_str(BACKUP_A).unwrap(),
            PublicKey::from_str(BACKUP_B).unwrap(),
            PublicKey::from_str(BACKUP_C).unwrap(),
        ];
        p.backup_quorum = Some(2);
        p
    }

    fn xonly_bytes(pk_hex: &str) -> [u8; 32] {
        PublicKey::from_str(pk_hex).unwrap().inner.x_only_public_key().0.serialize()
    }

    async fn build_psbt(path: &str, key_origins: Vec<KeyOrigin>) -> Psbt {
        build_psbt_with_policy(sample_policy(), path, key_origins).await
    }

    async fn build_psbt_with_policy(policy: DynastyPolicy, path: &str, key_origins: Vec<KeyOrigin>) -> Psbt {
        let compiled = compile_dynasty_policy_tr_multileaf(policy.clone(), Network::Testnet).unwrap();
        let addr = compiled.address.to_string();
        let spk_hex = hex::encode(compiled.address.script_pubkey().as_bytes());

        let req = PsbtBinaryRequest {
            inputs: vec![UtxoInput {
                txid: "0000000000000000000000000000000000000000000000000000000000000001".into(),
                vout: 0,
                value_sats: 100_000,
                script_pubkey: spk_hex,
            }],
            destination: addr.clone(),
            amount_sats: 50_000,
            fee_sats: 1_000,
            change_address: addr,
            network: "testnet".into(),
            founder_keys: Some(policy.founder_keys.iter().map(|k| k.to_string()).collect()),
            founder_quorum: Some(policy.founder_quorum),
            heir_keys: Some(policy.heir_keys.iter().map(|k| k.to_string()).collect()),
            heir_quorum: Some(policy.heir_quorum),
            recovery_after: Some(policy.recovery_after),
            inheritance_after: Some(policy.inheritance_after),
            address_type: Some("tr_multileaf".into()),
            consent_keys: vec![],
            consent_quorum: None,
            recovery_quorum: None,
            protector_keys: vec![],
            protector_quorum: None,
            protector_after: None,
            backup_keys: policy.backup_keys.iter().map(|k| k.to_string()).collect(),
            backup_quorum: policy.backup_quorum,
            second_heir_keys: policy.second_heir_keys.iter().map(|k| k.to_string()).collect(),
            second_heir_quorum: policy.second_heir_quorum,
            second_inheritance_after: policy.second_inheritance_after,
            path: Some(path.into()),
            witness_script_hex: None,
            key_origins,
            leaves: None,
        };
        let (state, headers) = test_auth_state_and_headers();
        let Json(resp) = psbt_binary(State(state), headers, Json(req)).await.unwrap();
        let bytes = hex::decode(resp.psbt_hex).unwrap();
        Psbt::deserialize(&bytes).unwrap()
    }

    #[tokio::test]
    async fn change_address_not_matching_the_compiled_policy_is_rejected() {
        // A caller-supplied change_address that isn't actually the
        // policy's own compiled address must never get that policy's
        // real tap_internal_key / tap_tree / tap_key_origins stamped
        // onto it -- that would describe a vault the output doesn't
        // pay into. Build a legitimate policy + PSBT request but swap
        // in an unrelated vault's address as change_address, and
        // confirm the request is rejected rather than silently
        // attaching mismatched metadata (or, worse, succeeding).
        let policy = sample_policy();
        let compiled = compile_dynasty_policy_tr_multileaf(policy.clone(), Network::Testnet).unwrap();
        let addr = compiled.address.to_string();
        let spk_hex = hex::encode(compiled.address.script_pubkey().as_bytes());

        // A different vault entirely -- same shape, different keys, so
        // its compiled address is provably not this vault's.
        let mut other_policy = policy.clone();
        other_policy.founder_keys = vec![
            PublicKey::from_str(BACKUP_A).unwrap(),
            PublicKey::from_str(BACKUP_B).unwrap(),
        ];
        let unrelated_addr = compile_dynasty_policy_tr_multileaf(other_policy, Network::Testnet)
            .unwrap().address.to_string();
        assert_ne!(addr, unrelated_addr, "test setup needs two genuinely different addresses");

        let req = PsbtBinaryRequest {
            inputs: vec![UtxoInput {
                txid: "0000000000000000000000000000000000000000000000000000000000000001".into(),
                vout: 0,
                value_sats: 100_000,
                script_pubkey: spk_hex,
            }],
            destination: addr,
            amount_sats: 50_000,
            fee_sats: 1_000,
            change_address: unrelated_addr,
            network: "testnet".into(),
            founder_keys: Some(policy.founder_keys.iter().map(|k| k.to_string()).collect()),
            founder_quorum: Some(policy.founder_quorum),
            heir_keys: Some(policy.heir_keys.iter().map(|k| k.to_string()).collect()),
            heir_quorum: Some(policy.heir_quorum),
            recovery_after: Some(policy.recovery_after),
            inheritance_after: Some(policy.inheritance_after),
            address_type: Some("tr_multileaf".into()),
            consent_keys: vec![],
            consent_quorum: None,
            recovery_quorum: None,
            protector_keys: vec![],
            protector_quorum: None,
            protector_after: None,
            backup_keys: policy.backup_keys.iter().map(|k| k.to_string()).collect(),
            backup_quorum: policy.backup_quorum,
            second_heir_keys: policy.second_heir_keys.iter().map(|k| k.to_string()).collect(),
            second_heir_quorum: policy.second_heir_quorum,
            second_inheritance_after: policy.second_inheritance_after,
            path: Some("founders_now".into()),
            witness_script_hex: None,
            key_origins: vec![],
            leaves: None,
        };
        let (state, headers) = test_auth_state_and_headers();
        let result = psbt_binary(State(state), headers, Json(req)).await;
        assert!(result.is_err(), "a change_address for a different vault must be rejected");
    }

    #[tokio::test]
    async fn founders_now_path_attaches_the_founders_leaf() {
        let psbt = build_psbt("founders_now", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        assert!(leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(FOUNDER_A)));
    }

    #[tokio::test]
    async fn unrecognized_path_is_rejected_not_defaulted_to_founders_now() {
        // psbt_builder.rs's build_bloc_spend_psbt / build_tranche_spend_psbt
        // both reject an unknown path with PsbtError::UnknownPath. This
        // handler used to be the one exception, silently treating a typo
        // or garbage path string as founders_now instead of erroring.
        let policy = sample_policy();
        let compiled = compile_dynasty_policy_tr_multileaf(policy.clone(), Network::Testnet).unwrap();
        let addr = compiled.address.to_string();
        let spk_hex = hex::encode(compiled.address.script_pubkey().as_bytes());

        let req = PsbtBinaryRequest {
            inputs: vec![UtxoInput {
                txid: "0000000000000000000000000000000000000000000000000000000000000001".into(),
                vout: 0,
                value_sats: 100_000,
                script_pubkey: spk_hex,
            }],
            destination: addr.clone(),
            amount_sats: 50_000,
            fee_sats: 1_000,
            change_address: addr,
            network: "testnet".into(),
            founder_keys: Some(policy.founder_keys.iter().map(|k| k.to_string()).collect()),
            founder_quorum: Some(policy.founder_quorum),
            heir_keys: Some(policy.heir_keys.iter().map(|k| k.to_string()).collect()),
            heir_quorum: Some(policy.heir_quorum),
            recovery_after: Some(policy.recovery_after),
            inheritance_after: Some(policy.inheritance_after),
            address_type: Some("tr_multileaf".into()),
            consent_keys: vec![],
            consent_quorum: None,
            recovery_quorum: None,
            protector_keys: vec![],
            protector_quorum: None,
            protector_after: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
            path: Some("definitely_not_a_path".into()),
            witness_script_hex: None,
            key_origins: vec![],
            leaves: None,
        };
        let (state, headers) = test_auth_state_and_headers();
        match psbt_binary(State(state), headers, Json(req)).await {
            Ok(_) => panic!("an unrecognized path must be rejected, not silently treated as founders_now"),
            Err(err) => assert_eq!(err.0, StatusCode::BAD_REQUEST),
        }
    }

    #[tokio::test]
    async fn inheritance_path_attaches_the_inheritance_leaf_not_founders() {
        // This is the actual bug: before the fix, this always attached
        // the founders-now leaf, so an heir's key was never found in it.
        let psbt = build_psbt("inheritance", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        assert!(
            leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(HEIR_A)),
            "inheritance spend must attach the inheritance leaf (containing the heir's key), not founders_now"
        );
        assert!(
            !leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(FOUNDER_A)),
            "the inheritance leaf must not be the founders leaf"
        );
    }

    const SECOND_HEIR_A: &str = "03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe";

    fn sample_second_inheritance_policy() -> DynastyPolicy {
        let mut p = sample_policy();
        p.second_heir_keys = vec![PublicKey::from_str(SECOND_HEIR_A).unwrap()];
        p.second_heir_quorum = Some(1);
        p.second_inheritance_after = Some(500_000);
        p
    }

    #[tokio::test]
    async fn second_inheritance_path_attaches_its_own_leaf_and_locktime() {
        // Mirrors the inheritance-vs-founders regression test above: an
        // independent second heir cohort must attach ITS OWN leaf (not
        // founders_now, not the primary inheritance leaf) and set
        // tx.lock_time to second_inheritance_after, not inheritance_after.
        let psbt = build_psbt_with_policy(sample_second_inheritance_policy(), "second_inheritance", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        assert!(
            leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(SECOND_HEIR_A)),
            "second_inheritance spend must attach the second inheritance leaf"
        );
        assert!(
            !leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(HEIR_A)),
            "must not be the primary inheritance leaf"
        );
        assert!(
            !leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(FOUNDER_A)),
            "must not be the founders leaf"
        );
        assert_eq!(
            psbt.unsigned_tx.lock_time.to_consensus_u32(),
            500_000,
            "lock_time must be second_inheritance_after, not inheritance_after"
        );
    }

    #[tokio::test]
    async fn founders_now_still_works_unchanged_on_a_second_inheritance_policy() {
        let psbt = build_psbt_with_policy(sample_second_inheritance_policy(), "founders_now", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        assert!(leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(FOUNDER_A)));
        assert_eq!(psbt.unsigned_tx.lock_time.to_consensus_u32(), 0);
    }

    #[tokio::test]
    async fn recovery_path_attaches_the_recovery_leaf() {
        let psbt = build_psbt("recovery", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        // Recovery spends via the founders' own keys (thresh over founders),
        // so the founder key IS expected here -- but on a DIFFERENT leaf
        // than founders_now (proven indirectly: recovery has a locktime,
        // founders_now does not).
        assert!(leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(FOUNDER_A)));
        assert_ne!(psbt.unsigned_tx.lock_time, bitcoin::absolute::LockTime::ZERO);
    }

    #[tokio::test]
    async fn backup_path_attaches_the_backup_leaf_with_no_locktime() {
        // "Anytime, harder" -- the backup leaf uses a SEPARATE key set
        // from founders (never the founder keys) and, unlike recovery,
        // is spendable immediately: no CLTV, same as founders_now.
        let psbt = build_psbt_with_policy(sample_backup_policy(), "backup", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        assert!(
            leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(BACKUP_A)),
            "backup spend must attach the backup leaf (containing a backup key)"
        );
        assert!(
            !leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(FOUNDER_A)),
            "the backup leaf must use the SEPARATE backup key set, never the founder keys"
        );
        assert_eq!(
            psbt.unsigned_tx.lock_time,
            bitcoin::absolute::LockTime::ZERO,
            "backup is never timelocked -- the friction is retrieving enough keys, not waiting"
        );
    }

    #[tokio::test]
    async fn founders_now_path_still_works_unchanged_on_a_backup_policy() {
        // Adding a backup leaf must not disturb founders_now for a vault
        // that has one configured.
        let psbt = build_psbt_with_policy(sample_backup_policy(), "founders_now", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        assert!(leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(FOUNDER_A)));
        assert_eq!(psbt.unsigned_tx.lock_time, bitcoin::absolute::LockTime::ZERO);
    }

    #[tokio::test]
    async fn inheritance_path_still_works_unchanged_on_a_backup_policy() {
        let psbt = build_psbt_with_policy(sample_backup_policy(), "inheritance", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        assert!(leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(HEIR_A)));
        assert_ne!(psbt.unsigned_tx.lock_time, bitcoin::absolute::LockTime::ZERO);
    }

    #[tokio::test]
    async fn compile_response_labels_the_middle_leaf_backup_not_recovery_when_configured() {
        let policy = sample_backup_policy();
        let req = CompileRequest {
            name: None, network: "testnet".into(),
            founder_keys: policy.founder_keys.iter().map(|k| k.to_string()).collect(),
            founder_quorum: policy.founder_quorum,
            recovery_quorum: None,
            heir_keys: policy.heir_keys.iter().map(|k| k.to_string()).collect(),
            heir_quorum: policy.heir_quorum,
            recovery_after: policy.recovery_after,
            inheritance_after: policy.inheritance_after,
            address_type: "tr_multileaf".into(),
            protector_keys: vec![],
            protector_quorum: None,
            protector_after: None,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: policy.backup_keys.iter().map(|k| k.to_string()).collect(),
            backup_quorum: policy.backup_quorum,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        };
        let (state, headers) = test_auth_state_and_headers();
        let Json(resp) = compile(State(state), headers, Json(req)).await.unwrap();
        let leaf_scripts = resp.leaf_scripts.expect("tr_multileaf compile must return leaf_scripts");

        assert!(leaf_scripts.contains_key("backup"), "middle leaf must be labeled 'backup'");
        assert!(!leaf_scripts.contains_key("recovery"), "must never carry both labels for the same slot");

        // Byte-consistency, same discipline as the recovery/inheritance
        // version of this test: the labeled hex must match what
        // psbt_binary actually attaches for that path.
        let backup_psbt = build_psbt_with_policy(sample_backup_policy(), "backup", vec![]).await;
        let (backup_leaf, _) = backup_psbt.inputs[0].tap_scripts.values().next().unwrap();
        assert_eq!(leaf_scripts["backup"], hex::encode(backup_leaf.as_bytes()));
    }

    /// The ACTUAL Tapit Circle shape: a phone-verified circle for
    /// founders_now, the owner's own harder key set for backup, no third
    /// leaf -- no heirs, no estate-planning timelock at all.
    fn sample_tapit_circle_policy() -> DynastyPolicy {
        let mut p = sample_backup_policy();
        p.heir_keys = vec![];
        p.heir_quorum = 0;
        p.inheritance_after = 0;
        p
    }

    #[tokio::test]
    async fn tapit_circle_shape_compiles_and_spends_via_both_leaves_end_to_end() {
        let policy = sample_tapit_circle_policy();
        let req = CompileRequest {
            name: None, network: "testnet".into(),
            founder_keys: policy.founder_keys.iter().map(|k| k.to_string()).collect(),
            founder_quorum: policy.founder_quorum,
            recovery_quorum: None,
            heir_keys: vec![],
            heir_quorum: 0,
            recovery_after: 0,
            inheritance_after: 0,
            address_type: "tr_multileaf".into(),
            protector_keys: vec![],
            protector_quorum: None,
            protector_after: None,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: policy.backup_keys.iter().map(|k| k.to_string()).collect(),
            backup_quorum: policy.backup_quorum,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        };
        let (state, headers) = test_auth_state_and_headers();
        let Json(resp) = compile(State(state), headers, Json(req)).await.unwrap();
        let leaf_scripts = resp.leaf_scripts.expect("tr_multileaf compile must return leaf_scripts");
        assert!(leaf_scripts.contains_key("founders_now"));
        assert!(leaf_scripts.contains_key("backup"));
        assert!(!leaf_scripts.contains_key("inheritance"), "this shape has no third leaf");

        let founders_psbt = build_psbt_with_policy(sample_tapit_circle_policy(), "founders_now", vec![]).await;
        let (f_leaf, _) = founders_psbt.inputs[0].tap_scripts.values().next().unwrap();
        assert!(f_leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(FOUNDER_A)));
        assert_eq!(founders_psbt.unsigned_tx.lock_time, bitcoin::absolute::LockTime::ZERO);

        let backup_psbt = build_psbt_with_policy(sample_tapit_circle_policy(), "backup", vec![]).await;
        let (b_leaf, _) = backup_psbt.inputs[0].tap_scripts.values().next().unwrap();
        assert!(b_leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(BACKUP_A)));
        assert!(
            !b_leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(FOUNDER_A)),
            "backup leaf must use the separate backup key set, never founder keys"
        );
        assert_eq!(
            backup_psbt.unsigned_tx.lock_time,
            bitcoin::absolute::LockTime::ZERO,
            "backup is never timelocked, same as founders_now"
        );
    }

    #[tokio::test]
    async fn compile_leaf_scripts_match_the_leaf_bytes_psbt_binary_actually_attaches() {
        // Cut C3 (DynastyTrust -> Tapit vault-membership attestation) will
        // mint each signer's `leaf_scripts` field straight from this
        // endpoint's response. If those hex strings ever drifted from the
        // leaf bytes psbt_binary actually attaches at spend time, a wallet
        // holding the attestation would never recognize a real spend's
        // tapLeafScript (vaultTrail.ts's isKnownLeafScript, Tapit repo) --
        // silently refusing every legitimate signature forever. This test
        // is the tripwire for that drift.
        let policy = sample_policy();
        let req = CompileRequest {
            name: None, network: "testnet".into(),
            founder_keys: policy.founder_keys.iter().map(|k| k.to_string()).collect(),
            founder_quorum: policy.founder_quorum,
            recovery_quorum: None,
            heir_keys: policy.heir_keys.iter().map(|k| k.to_string()).collect(),
            heir_quorum: policy.heir_quorum,
            recovery_after: policy.recovery_after,
            inheritance_after: policy.inheritance_after,
            address_type: "tr_multileaf".into(),
            protector_keys: vec![],
            protector_quorum: None,
            protector_after: None,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        };
        let (state, headers) = test_auth_state_and_headers();
        let Json(resp) = compile(State(state), headers, Json(req)).await.unwrap();
        let leaf_scripts = resp.leaf_scripts.expect("tr_multileaf compile must return leaf_scripts");

        let founders_psbt = build_psbt("founders_now", vec![]).await;
        let (founders_leaf, _) = founders_psbt.inputs[0].tap_scripts.values().next().unwrap();
        assert_eq!(leaf_scripts["founders_now"], hex::encode(founders_leaf.as_bytes()));

        let inheritance_psbt = build_psbt("inheritance", vec![]).await;
        let (inheritance_leaf, _) = inheritance_psbt.inputs[0].tap_scripts.values().next().unwrap();
        assert_eq!(leaf_scripts["inheritance"], hex::encode(inheritance_leaf.as_bytes()));

        let recovery_psbt = build_psbt("recovery", vec![]).await;
        let (recovery_leaf, _) = recovery_psbt.inputs[0].tap_scripts.values().next().unwrap();
        assert_eq!(leaf_scripts["recovery"], hex::encode(recovery_leaf.as_bytes()));

        assert!(!leaf_scripts.contains_key("protector"), "sample_policy has no protector configured");
    }

    #[tokio::test]
    async fn hardware_wallet_key_origin_is_attached_for_the_heir_on_the_inheritance_leaf() {
        let psbt = build_psbt(
            "inheritance",
            vec![KeyOrigin {
                pubkey: HEIR_A.to_string(),
                fingerprint: "deadbeef".into(),
                derivation_path: "m/48'/1'/0'/2'/0/0".into(),
            }],
        )
        .await;
        assert_eq!(
            psbt.inputs[0].tap_key_origins.len(),
            1,
            "the heir's key must get a tap_key_origins entry so a hardware wallet can recognize it"
        );
    }

    #[tokio::test]
    async fn hardware_wallet_key_origin_for_a_founder_is_not_attached_on_the_inheritance_leaf() {
        // A founder's key is not part of the inheritance leaf -- it must
        // not get an origin entry there, even though it's a real vault
        // signer key overall.
        let psbt = build_psbt(
            "inheritance",
            vec![KeyOrigin {
                pubkey: FOUNDER_A.to_string(),
                fingerprint: "deadbeef".into(),
                derivation_path: "m/48'/1'/0'/2'/0/0".into(),
            }],
        )
        .await;
        assert!(psbt.inputs[0].tap_key_origins.is_empty());
    }

    #[tokio::test]
    async fn change_output_carries_the_vault_internal_key() {
        // Change always lands back at this same vault's tr_multileaf
        // address (change_address == the funding address), but the change
        // TxOut never carried any taproot metadata at all -- a bare
        // scriptPubkey a signer has nothing to verify against. output[1]
        // is change here since amount_sats (50_000) + fee_sats (1_000) <
        // value_sats (100_000).
        let psbt = build_psbt("founders_now", vec![]).await;
        assert_eq!(psbt.unsigned_tx.output.len(), 2, "this scenario must produce a change output");
        assert!(
            psbt.outputs[1].tap_internal_key.is_some(),
            "change output must carry tap_internal_key so a signer can identify the tree it belongs to"
        );
    }

    #[tokio::test]
    async fn change_output_tap_tree_reconstructs_the_real_change_scriptpubkey() {
        // 2026-08-11 fix: tap_internal_key + tap_key_origins alone are
        // enough for a signer that trusts its own key match, but a
        // stronger signer (SeedSigner) independently rebuilds the whole
        // tree from PSBT_OUT_TAP_TREE and tweaks it, then compares
        // byte-for-byte against the real scriptPubkey -- exactly what
        // this test does, so a regression that drops tap_tree (or attaches
        // a tree that doesn't match spend_info) fails here, not just in
        // a live SeedSigner scan.
        let psbt = build_psbt("founders_now", vec![]).await;
        assert_eq!(psbt.unsigned_tx.output.len(), 2);

        let tap_tree = psbt.outputs[1]
            .tap_tree
            .clone()
            .expect("change output must carry PSBT_OUT_TAP_TREE for a signer to verify against");
        let internal_key = psbt.outputs[1]
            .tap_internal_key
            .expect("change output must carry tap_internal_key");

        let secp = Secp256k1::verification_only();
        let node_info = bitcoin::taproot::NodeInfo::from(tap_tree);
        let spend_info = bitcoin::taproot::TaprootSpendInfo::from_node_info(&secp, internal_key, node_info);
        let real_output_script = bitcoin::ScriptBuf::new_p2tr_tweaked(spend_info.output_key());

        assert_eq!(
            real_output_script, psbt.unsigned_tx.output[1].script_pubkey,
            "tap_tree + tap_internal_key must independently reconstruct the change output's real scriptPubkey"
        );
    }

    #[tokio::test]
    async fn change_output_tap_key_origins_covers_every_leaf_a_founder_key_is_in() {
        // FOUNDER_A sits in both the founders-now leaf and the recovery
        // leaf (recovery falls back to the founder quorum when
        // recovery_quorum is unset, same as sample_policy() here) -- the
        // change output's origin entry must list both leaf hashes, not
        // just one, unlike the single-leaf input-side attachment.
        let psbt = build_psbt(
            "founders_now",
            vec![KeyOrigin {
                pubkey: FOUNDER_A.to_string(),
                fingerprint: "deadbeef".into(),
                derivation_path: "m/86'/1'/0'/0/0".into(),
            }],
        )
        .await;
        assert_eq!(psbt.outputs[1].tap_key_origins.len(), 1);
        let (leaves, _) = psbt.outputs[1].tap_key_origins.values().next().unwrap();
        assert_eq!(leaves.len(), 2, "founder key is in both founders-now and recovery leaves");
    }

    #[tokio::test]
    async fn change_output_tap_key_origins_covers_only_the_inheritance_leaf_for_the_heir() {
        let psbt = build_psbt(
            "founders_now",
            vec![KeyOrigin {
                pubkey: HEIR_A.to_string(),
                fingerprint: "deadbeef".into(),
                derivation_path: "m/86'/1'/0'/0/0".into(),
            }],
        )
        .await;
        assert_eq!(psbt.outputs[1].tap_key_origins.len(), 1);
        let (leaves, _) = psbt.outputs[1].tap_key_origins.values().next().unwrap();
        assert_eq!(leaves.len(), 1, "heir key is only in the inheritance leaf");
    }
}

// 2026-08-11 fix regression coverage. Operator report: a real finalize
// failure ("PSBT is missing both witness and non-witness UTXO at index 0")
// was reported back as "Not enough signatures. Collect more signers" --
// miniscript's InputError::MissingUtxo is a distinct, named error from a
// quorum shortfall, and the generic fallback hint sent the operator
// chasing more signers for a problem that had nothing to do with signer
// count. This test proves the branch in psbt_finalize's error mapping
// actually matches the REAL text miniscript::psbt::Psbt::finalize_mut
// produces for this specific failure -- not just a plausible-looking
// string check that happens to never fire in practice.
#[cfg(test)]
mod psbt_finalize_hint_tests {
    use super::*;
    use bitcoin::{OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
    use std::str::FromStr;

    #[test]
    fn missing_utxo_error_text_matches_the_hint_branchs_own_check() {
        // A minimal unsigned PSBT: one input with NO witness_utxo and NO
        // non_witness_utxo attached at all (deliberately, unlike every
        // real input this compiler builds -- witness_utxo is set
        // unconditionally in psbt_binary). finalize_mut has nothing to
        // determine this input's prevout value/script from, which is
        // exactly InputError::MissingUtxo's trigger condition.
        let txid = Txid::from_str(&"11".repeat(32)).unwrap();
        let tx = Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint { txid, vout: 0 },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: Witness::default(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(50_000),
                script_pubkey: ScriptBuf::new(),
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();

        let secp = Secp256k1::verification_only();
        let err = psbt.finalize_mut(&secp).unwrap_err();
        let msgs: Vec<String> = err.iter().map(|e| e.to_string()).collect();
        let joined = msgs.join("; ");
        let lower = joined.to_lowercase();

        assert!(
            lower.contains("missing both witness and non-witness utxo"),
            "miniscript's real error text for a UTXO-less input changed shape -- \
             got: {joined}. Update psbt_finalize's hint branch to match."
        );
    }
}

#[cfg(test)]
mod validate_address_tests {
    use super::*;
    use dynastytrust_protocol::DynastyPolicy;

    async fn check(address: &str, network: &str) -> bool {
        let (state, headers) = test_auth_state_and_headers();
        let req = ValidateAddressRequest { address: address.to_string(), network: network.to_string() };
        let Json(resp) = validate_address(State(state), headers, Json(req)).await.unwrap();
        resp.valid
    }

    fn real_address(network: Network) -> String {
        let policy = DynastyPolicy {
            founder_keys: vec![
                PublicKey::from_str("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97").unwrap(),
                PublicKey::from_str("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569").unwrap(),
            ],
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: vec![],
            heir_quorum: 1,
            recovery_after: 0,
            inheritance_after: 0,
            protector_keys: vec![],
            protector_quorum: None,
            protector_after: None,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        };
        compile_dynasty_policy_tr_multileaf(policy, network).unwrap().address.to_string()
    }

    #[tokio::test]
    async fn accepts_a_real_testnet_taproot_address() {
        assert!(check(&real_address(Network::Testnet), "testnet").await);
    }

    #[tokio::test]
    async fn rejects_garbage() {
        assert!(!check("not-a-real-address", "testnet").await);
        assert!(!check("", "testnet").await);
    }

    #[tokio::test]
    async fn rejects_a_mainnet_address_claimed_as_testnet() {
        // A syntactically real address, but for the WRONG network -- this
        // is exactly the shape of bug this endpoint exists to catch:
        // vaults.js persisting a client-claimed network alongside an
        // address that doesn't actually belong to it.
        assert!(!check(&real_address(Network::Bitcoin), "testnet").await);
    }
}

// 2026-08-06 tranche-claim build. There was previously no endpoint at all
// for spending a matured tranche -- a beneficiary or trustee had no way to
// build a PSBT against a tranche's script through this service. These
// tests call the handler directly, same shape as psbt_binary_tests above,
// to prove both spend paths attach the correct leaf and locktime rather
// than trusting the wiring by inspection.
#[cfg(test)]
mod psbt_binary_tranche_tests {
    use super::*;
    use dynastytrust_protocol::compile_tranche_tr_multileaf;

    const BENEFICIARY: &str = "03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34";
    const TRUSTEE_A: &str = "02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97";
    const TRUSTEE_B: &str = "02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569";

    fn sample_policy() -> TranchePolicy {
        TranchePolicy {
            beneficiary_key: PublicKey::from_str(BENEFICIARY).unwrap(),
            trustee_keys: vec![
                PublicKey::from_str(TRUSTEE_A).unwrap(),
                PublicKey::from_str(TRUSTEE_B).unwrap(),
            ],
            trustee_quorum: 2,
            unlock_block: 300_000,
        }
    }

    fn xonly_bytes(pk_hex: &str) -> [u8; 32] {
        PublicKey::from_str(pk_hex).unwrap().inner.x_only_public_key().0.serialize()
    }

    async fn build_psbt(path: &str, key_origins: Vec<KeyOrigin>) -> Psbt {
        let policy = sample_policy();
        let compiled = compile_tranche_tr_multileaf(policy.clone(), Network::Testnet).unwrap();
        let addr = compiled.address.to_string();
        let spk_hex = hex::encode(compiled.address.script_pubkey().as_bytes());

        let req = PsbtBinaryTrancheRequest {
            inputs: vec![UtxoInput {
                txid: "0000000000000000000000000000000000000000000000000000000000000001".into(),
                vout: 0,
                value_sats: 100_000,
                script_pubkey: spk_hex,
            }],
            destination: addr.clone(),
            amount_sats: 50_000,
            fee_sats: 1_000,
            change_address: addr,
            network: "testnet".into(),
            beneficiary_key: policy.beneficiary_key.to_string(),
            trustee_keys: policy.trustee_keys.iter().map(|k| k.to_string()).collect(),
            trustee_quorum: policy.trustee_quorum,
            unlock_block: policy.unlock_block,
            path: path.into(),
            key_origins,
        };
        let (state, headers) = test_auth_state_and_headers();
        let Json(resp) = psbt_binary_tranche(State(state), headers, Json(req)).await.unwrap();
        let bytes = hex::decode(resp.psbt_hex).unwrap();
        Psbt::deserialize(&bytes).unwrap()
    }

    #[tokio::test]
    async fn beneficiary_path_attaches_the_beneficiary_leaf_and_the_unlock_height() {
        let psbt = build_psbt("beneficiary", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        assert!(leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(BENEFICIARY)));
        assert_eq!(
            psbt.unsigned_tx.lock_time,
            bitcoin::absolute::LockTime::from_height(300_000).unwrap(),
        );
    }

    #[tokio::test]
    async fn trustee_path_attaches_the_trustee_leaf_with_zero_locktime() {
        let psbt = build_psbt("trustee", vec![]).await;
        let (leaf, _) = psbt.inputs[0].tap_scripts.values().next().expect("a leaf must be attached");
        assert!(leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(TRUSTEE_A)));
        assert!(
            !leaf.as_bytes().windows(32).any(|w| w == xonly_bytes(BENEFICIARY)),
            "the trustee escape hatch must not be the beneficiary leaf"
        );
        assert_eq!(psbt.unsigned_tx.lock_time, bitcoin::absolute::LockTime::ZERO);
    }

    #[tokio::test]
    async fn hardware_wallet_key_origin_is_attached_for_the_beneficiary_on_their_leaf() {
        let psbt = build_psbt(
            "beneficiary",
            vec![KeyOrigin {
                pubkey: BENEFICIARY.to_string(),
                fingerprint: "deadbeef".into(),
                derivation_path: "m/86'/1'/0'/0/0".into(),
            }],
        )
        .await;
        assert_eq!(psbt.inputs[0].tap_key_origins.len(), 1);
    }

    #[tokio::test]
    async fn trustee_key_origin_not_attached_on_the_beneficiary_leaf() {
        let psbt = build_psbt(
            "beneficiary",
            vec![KeyOrigin {
                pubkey: TRUSTEE_A.to_string(),
                fingerprint: "deadbeef".into(),
                derivation_path: "m/48'/1'/0'/2'/0/0".into(),
            }],
        )
        .await;
        assert!(
            psbt.inputs[0].tap_key_origins.is_empty(),
            "a trustee key must not be attached to the beneficiary leaf"
        );
    }
}
