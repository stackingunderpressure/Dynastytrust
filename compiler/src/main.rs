use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use dynastytrust_protocol::service as svc;
// The request types the thin wrappers below name (and every helper the
// tests use) now live in dynastytrust_protocol::service.
#[allow(unused_imports)]
use dynastytrust_protocol::service::*;
use serde::Serialize;
use std::{net::SocketAddr, sync::Arc};

// Used only by the tests at the bottom of this file (they `use super::*`):
// the request logic itself moved to dynastytrust_protocol::service.
#[cfg(test)]
use anyhow::Result;
#[cfg(test)]
use bitcoin::{absolute::LockTime, Amount, Network, PublicKey};
#[cfg(test)]
use bitcoin::{psbt::Psbt, secp256k1::Secp256k1};
#[cfg(test)]
use dynastytrust_protocol::{
    build_leaf_multileaf, compile_dynasty_policy_tr_multileaf, DynastyPolicy, KeyOrigin,
    TranchePolicy,
};
#[cfg(test)]
use miniscript::psbt::PsbtExt;
#[cfg(test)]
use std::str::FromStr;

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
    // An explicitly empty secret (COMPILER_SECRET="", distinct from unset)
    // must fail closed the same way -- otherwise a request with no
    // Authorization header at all supplies token="" via the unwrap_or
    // below, and constant_time_eq(b"", b"") trivially passes.
    if secret.is_empty() {
        return Err(api_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "Compiler is configured with an empty secret -- refusing all requests until COMPILER_SECRET is set to a real value",
        ));
    }
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

    // Kimi K3 scan #37: Some("") -- an operator explicitly setting
    // COMPILER_SECRET="" -- is distinct from None (unset), and previously
    // fell through to constant_time_eq(b"", b""), which a request with
    // NO Authorization header at all satisfies (token defaults to "").
    #[test]
    fn empty_secret_rejects_every_request_even_with_no_auth_header() {
        let state = AppState { secret: Some(String::new()) };
        let result_no_header = check_auth(&HeaderMap::new(), &state);
        assert!(result_no_header.is_err(), "an empty secret must fail closed, not open");
        let result_empty_bearer = check_auth(&headers_with_bearer(""), &state);
        assert!(result_empty_bearer.is_err());
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

// ── /health ───────────────────────────────────────────────────────────────────

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true, "service": "dynastytrust-compiler",
        "endpoints": ["/health","/compile","/compile-bloc","/compile-tranche","/compile-leaves","/psbt-binary","/psbt-binary-bloc","/psbt-binary-tranche","/psbt-finalize","/psbt-merge","/governance/status","/governance/audit"]
    }))
}

// ── Requests: thin wrappers over dynastytrust_protocol::service ─────────────
// Every handler checks the shared secret, then runs the ONE copy of the
// request logic the browser module also runs (sovereign slice 1). Same names
// and signatures as before the move, so the tests below call them unchanged.

fn from_service(e: svc::ServiceError) -> ApiError {
    let status = StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    api_err(status, e.error)
}

async fn compile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CompileRequest>,
) -> Result<Json<CompileResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::compile(req).map(Json).map_err(from_service)
}

async fn compile_tranche(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<TrancheRequest>,
) -> Result<Json<TrancheResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::compile_tranche(req).map(Json).map_err(from_service)
}

async fn compile_bloc(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CompileBlocRequest>,
) -> Result<Json<CompileResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::compile_bloc(req).map(Json).map_err(from_service)
}

async fn compile_leaves(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CompileLeavesRequest>,
) -> Result<Json<CompileResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::compile_leaves(req).map(Json).map_err(from_service)
}

async fn psbt_binary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<PsbtBinaryRequest>,
) -> Result<Json<PsbtBinaryResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::psbt_binary(req).map(Json).map_err(from_service)
}

async fn psbt_binary_bloc(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<PsbtBinaryBlocRequest>,
) -> Result<Json<PsbtBinaryResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::psbt_binary_bloc(req).map(Json).map_err(from_service)
}

async fn psbt_binary_tranche(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<PsbtBinaryTrancheRequest>,
) -> Result<Json<PsbtBinaryResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::psbt_binary_tranche(req).map(Json).map_err(from_service)
}

async fn psbt_finalize(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<FinalizeRequest>,
) -> Result<Json<FinalizeResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::psbt_finalize(req).map(Json).map_err(from_service)
}

async fn psbt_merge(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<PsbtMergeRequest>,
) -> Result<Json<PsbtMergeResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::psbt_merge(req).map(Json).map_err(from_service)
}

async fn governance_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<GovernanceStatusRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    check_auth(&headers, &state)?;
    svc::governance_status(req).map(Json).map_err(from_service)
}

async fn governance_audit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<GovernanceAuditRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    check_auth(&headers, &state)?;
    svc::governance_audit(req).map(Json).map_err(from_service)
}

async fn validate_address(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ValidateAddressRequest>,
) -> Result<Json<ValidateAddressResponse>, ApiError> {
    check_auth(&headers, &state)?;
    svc::validate_address(req).map(Json).map_err(from_service)
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
        .route("/compile-leaves",    post(compile_leaves))
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

    // ── Generic leaf-list vault (req.leaves) ────────────────────────────
    // Exercises the branch added alongside the named-field path above:
    // leaf lookup by id, tx.lock_time for an After leaf, and -- new here
    // -- nSequence for an OlderThan leaf, which the named-field path
    // never sets at all (BIP68 CSV is enforced through nSequence, never
    // lock_time).

    fn sample_leaves() -> Vec<LeafSpecWire> {
        vec![
            LeafSpecWire {
                required_keys: vec![],
                id: "primary".into(),
                label: "Founders".into(),
                keys: vec![FOUNDER_A.into(), FOUNDER_B.into()],
                quorum: 2,
                unlock: LeafUnlockWire { kind: "immediate".into(), blocks: None },
                decay: None,
            },
            LeafSpecWire {
                required_keys: vec![],
                id: "refresh".into(),
                label: "If untouched".into(),
                keys: vec![FOUNDER_A.into(), FOUNDER_B.into()],
                quorum: 1,
                unlock: LeafUnlockWire { kind: "older".into(), blocks: Some(52_560) },
                decay: None,
            },
            LeafSpecWire {
                required_keys: vec![],
                id: "recovery".into(),
                label: "Recovery".into(),
                keys: vec![FOUNDER_A.into(), FOUNDER_B.into()],
                quorum: 1,
                unlock: LeafUnlockWire { kind: "after".into(), blocks: Some(100_000) },
                decay: None,
            },
        ]
    }

    async fn build_leaf_psbt(path: &str) -> Result<Psbt, ApiError> {
        let policy = parse_leaf_policy(&sample_leaves(), &[], None).unwrap();
        let out = build_leaf_multileaf(&policy).unwrap();
        let addr = bitcoin::Address::p2tr_tweaked(out.spend_info.output_key(), Network::Testnet);
        let addr_str = addr.to_string();
        let spk_hex = hex::encode(addr.script_pubkey().as_bytes());

        let req = PsbtBinaryRequest {
            inputs: vec![UtxoInput {
                txid: "0000000000000000000000000000000000000000000000000000000000000001".into(),
                vout: 0,
                value_sats: 100_000,
                script_pubkey: spk_hex,
            }],
            destination: addr_str.clone(),
            amount_sats: 50_000,
            fee_sats: 1_000,
            change_address: addr_str,
            network: "testnet".into(),
            founder_keys: None,
            founder_quorum: None,
            heir_keys: None,
            heir_quorum: None,
            recovery_after: None,
            inheritance_after: None,
            address_type: Some("tr_multileaf".into()),
            consent_keys: vec![],
            consent_quorum: None,
            recovery_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
            path: Some(path.into()),
            witness_script_hex: None,
            key_origins: vec![],
            leaves: Some(sample_leaves()),
        };
        let (state, headers) = test_auth_state_and_headers();
        psbt_binary(State(state), headers, Json(req)).await.map(|Json(resp)| {
            let bytes = hex::decode(resp.psbt_hex).unwrap();
            Psbt::deserialize(&bytes).unwrap()
        })
    }

    #[tokio::test]
    async fn leaf_list_immediate_path_has_zero_locktime_and_no_relative_sequence() {
        let psbt = build_leaf_psbt("primary").await.unwrap();
        assert_eq!(psbt.unsigned_tx.lock_time, LockTime::ZERO);
        assert_eq!(
            psbt.unsigned_tx.input[0].sequence,
            bitcoin::Sequence::ENABLE_RBF_NO_LOCKTIME,
            "an Immediate leaf must not touch nSequence"
        );
    }

    #[tokio::test]
    async fn leaf_list_after_path_stamps_tx_lock_time_not_sequence() {
        let psbt = build_leaf_psbt("recovery").await.unwrap();
        assert_eq!(psbt.unsigned_tx.lock_time, LockTime::from_height(100_000).unwrap());
        assert_eq!(
            psbt.unsigned_tx.input[0].sequence,
            bitcoin::Sequence::ENABLE_RBF_NO_LOCKTIME,
            "CLTV (after) is enforced through lock_time, never nSequence"
        );
    }

    #[tokio::test]
    async fn leaf_list_older_path_stamps_sequence_on_every_input_not_lock_time() {
        let psbt = build_leaf_psbt("refresh").await.unwrap();
        assert_eq!(
            psbt.unsigned_tx.lock_time,
            LockTime::ZERO,
            "CSV (older) is enforced through nSequence, never lock_time"
        );
        assert_eq!(psbt.unsigned_tx.input[0].sequence, bitcoin::Sequence::from_height(52_560));
    }

    #[tokio::test]
    async fn leaf_list_unknown_path_is_rejected_not_defaulted_to_primary() {
        let err = build_leaf_psbt("nonexistent").await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }
}

#[cfg(test)]
mod compile_leaves_tests {
    use super::*;

    fn wire_leaves() -> Vec<LeafSpecWire> {
        vec![
            LeafSpecWire {
                required_keys: vec![],
                id: "primary".into(),
                label: "Founders".into(),
                keys: vec![
                    "02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97".into(),
                    "02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569".into(),
                ],
                quorum: 2,
                unlock: LeafUnlockWire { kind: "immediate".into(), blocks: None },
                decay: None,
            },
            LeafSpecWire {
                required_keys: vec![],
                id: "inheritance".into(),
                label: "Inheritance".into(),
                keys: vec!["03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34".into()],
                quorum: 1,
                unlock: LeafUnlockWire { kind: "after".into(), blocks: Some(200_000) },
                decay: None,
            },
        ]
    }

    #[tokio::test]
    async fn compiles_a_valid_leaf_list_and_returns_leaf_scripts_by_id() {
        let (state, headers) = test_auth_state_and_headers();
        let req = CompileLeavesRequest {
            name: Some("Test Vault".into()),
            network: "testnet".into(),
            leaves: wire_leaves(),
            consent_keys: vec![],
            consent_quorum: None,
        };
        let Json(resp) = compile_leaves(State(state), headers, Json(req)).await.unwrap();
        assert!(resp.ok);
        assert_eq!(resp.address_type, "tr_multileaf");
        assert!(!resp.address.is_empty());
        let scripts = resp.leaf_scripts.expect("leaf_scripts must be populated");
        assert!(scripts.contains_key("primary"));
        assert!(scripts.contains_key("inheritance"));
    }

    #[tokio::test]
    async fn a_leaf_list_with_no_immediate_leaf_is_rejected() {
        let (state, headers) = test_auth_state_and_headers();
        let mut leaves = wire_leaves();
        leaves[0].unlock = LeafUnlockWire { kind: "after".into(), blocks: Some(100_000) };
        let req = CompileLeavesRequest {
            name: None,
            network: "testnet".into(),
            leaves,
            consent_keys: vec![],
            consent_quorum: None,
        };
        match compile_leaves(State(state), headers, Json(req)).await {
            Ok(_) => panic!("a leaf policy with no Immediate leaf must be rejected"),
            Err(err) => assert_eq!(err.0, StatusCode::BAD_REQUEST),
        }
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
