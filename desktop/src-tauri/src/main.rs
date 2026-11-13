//! DynastyTrust desktop (docs/download-and-run-build-note.md).
//!
//! The window shows the web app's download build. Everything a vault needs
//! runs inside it -- keys, the vault compiler (compiler-wasm), signing --
//! except ONE thing a web page cannot do: talk to Bitcoin Core on this
//! computer. That is `bitcoin_rpc` below, and it is deliberately narrow:
//!
//! * It logs in with Core's own cookie file, read fresh on each call, never
//!   stored and never handed to the page.
//! * Only the methods in `ALLOWED` pass. Reading the chain, checksumming a
//!   descriptor, estimating fees,
//!   broadcasting a finished transaction, and keeping WATCH-ONLY wallets
//!   whose names start with `dynastytrust-` (Core's wallet RPCs are how it
//!   finds a vault's coins quickly). Nothing that spends from a Core wallet,
//!   stops Core, or changes its settings is reachable from the page.
//! * A wallet call must name a `dynastytrust-` wallet, and such a wallet
//!   can only be created watch-only (no private keys, blank).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Methods the page may call on Core, and whether each is wallet-scoped.
const ALLOWED: &[(&str, bool)] = &[
    ("getblockchaininfo", false),
    ("getdescriptorinfo", false),
    ("getblockcount", false),
    ("getblockhash", false),
    ("getblockheader", false),
    ("getrawtransaction", false),
    ("estimatesmartfee", false),
    ("testmempoolaccept", false),
    ("sendrawtransaction", false),
    ("gettxout", false),
    ("listwallets", false),
    ("loadwallet", false),
    ("createwallet", false),
    ("importdescriptors", true),
    ("listunspent", true),
    ("listtransactions", true),
    ("gettransaction", true),
    ("getwalletinfo", true),
    ("rescanblockchain", true),
];
const WALLET_PREFIX: &str = "dynastytrust-";

#[derive(Deserialize)]
struct CoreConn {
    /// 'bitcoin' | 'testnet' | 'testnet4' | 'signet' | 'regtest'
    network: String,
    /// Core's data directory, when not the usual one.
    datadir: Option<String>,
    /// Core's RPC port, when not the usual one for the network.
    port: Option<u16>,
}

fn default_datadir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library/Application Support/Bitcoin"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Bitcoin"))
    } else {
        home.map(|h| h.join(".bitcoin"))
    }
}

/// (subdirectory of the data dir, default RPC port) for a network.
fn network_layout(network: &str) -> Result<(&'static str, u16), String> {
    match network {
        "bitcoin" | "mainnet" => Ok(("", 8332)),
        "testnet" => Ok(("testnet3", 18332)),
        "testnet4" => Ok(("testnet4", 48332)),
        "signet" => Ok(("signet", 38332)),
        "regtest" => Ok(("regtest", 18443)),
        other => Err(format!("unknown network '{other}'")),
    }
}

/// Is this call allowed, and for which wallet (if any)?
fn check_call(method: &str, params: &Value, wallet: &Option<String>) -> Result<(), String> {
    let Some((_, scoped)) = ALLOWED.iter().find(|(m, _)| *m == method) else {
        return Err(format!("DynastyTrust does not use Core's '{method}'"));
    };
    let named = |name: &str| name.starts_with(WALLET_PREFIX);
    if *scoped {
        match wallet {
            Some(w) if named(w) => {}
            _ => return Err(format!("'{method}' is only allowed on a DynastyTrust watch-only wallet")),
        }
    } else if wallet.is_some() {
        return Err(format!("'{method}' does not take a wallet"));
    }
    match method {
        "createwallet" => {
            // createwallet name disable_private_keys blank ... : must be ours,
            // watch-only and blank.
            let a = params.as_array().ok_or("createwallet takes a list")?;
            let name = a.first().and_then(Value::as_str).unwrap_or("");
            if !named(name) || a.get(1) != Some(&json!(true)) || a.get(2) != Some(&json!(true)) {
                return Err("only a blank, watch-only DynastyTrust wallet may be created".into());
            }
        }
        "loadwallet" => {
            let name = params.as_array().and_then(|a| a.first()).and_then(Value::as_str).unwrap_or("");
            if !named(name) {
                return Err("only DynastyTrust wallets may be loaded".into());
            }
        }
        _ => {}
    }
    Ok(())
}

fn rpc_blocking(conn: CoreConn, method: String, params: Value, wallet: Option<String>) -> Result<Value, String> {
    check_call(&method, &params, &wallet)?;
    let (sub, default_port) = network_layout(&conn.network)?;
    let datadir = conn.datadir.map(PathBuf::from).or_else(default_datadir).ok_or("could not find Bitcoin Core's data folder")?;
    let cookie_path = if sub.is_empty() { datadir.join(".cookie") } else { datadir.join(sub).join(".cookie") };
    let cookie = std::fs::read_to_string(&cookie_path)
        .map_err(|_| format!("Bitcoin Core is not running for {} (no login file at {})", conn.network, cookie_path.display()))?;
    use base64::Engine;
    let auth = base64::engine::general_purpose::STANDARD.encode(cookie.trim());
    let port = conn.port.unwrap_or(default_port);
    let url = match &wallet {
        Some(w) => format!("http://127.0.0.1:{port}/wallet/{w}"),
        None => format!("http://127.0.0.1:{port}/"),
    };
    let body = json!({ "jsonrpc": "1.0", "id": "dynastytrust", "method": method, "params": params });
    let res = ureq::post(&url)
        .set("Authorization", &format!("Basic {auth}"))
        .set("Content-Type", "application/json")
        .send_json(body);
    let parsed: Value = match res {
        Ok(r) => r.into_json().map_err(|e| format!("Core answered something unreadable: {e}"))?,
        // Core answers RPC errors with a non-2xx status and a JSON body.
        Err(ureq::Error::Status(_, r)) => r.into_json().map_err(|e| format!("Core refused the call: {e}"))?,
        Err(e) => return Err(format!("could not reach Bitcoin Core on port {port}: {e}")),
    };
    if let Some(err) = parsed.get("error").filter(|e| !e.is_null()) {
        return Err(err.get("message").and_then(Value::as_str).unwrap_or("Core returned an error").to_string());
    }
    Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
}

/// Call Bitcoin Core on this computer (see the module note for what is allowed).
#[tauri::command]
async fn bitcoin_rpc(conn: CoreConn, method: String, params: Value, wallet: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || rpc_blocking(conn, method, params, wallet))
        .await
        .map_err(|e| format!("internal error: {e}"))?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![bitcoin_rpc])
        .run(tauri::generate_context!())
        .expect("error while running DynastyTrust");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_methods_pass() {
        assert!(check_call("getblockcount", &json!([]), &None).is_ok());
        assert!(check_call("getdescriptorinfo", &json!(["addr(x)"]), &None).is_ok());
        assert!(check_call("gettransaction", &json!(["00"]), &Some("dynastytrust-a".into())).is_ok());
        assert!(check_call("gettransaction", &json!(["00"]), &Some("savings".into())).is_err());
        for m in ["stop", "walletpassphrase", "sendtoaddress", "dumpprivkey", "setnetworkactive", "importprivkey", "signrawtransactionwithwallet"] {
            assert!(check_call(m, &json!([]), &None).is_err(), "{m} must be refused");
            assert!(check_call(m, &json!([]), &Some("dynastytrust-x".into())).is_err(), "{m} must be refused on our wallet too");
        }
    }

    #[test]
    fn wallet_calls_only_on_our_watch_only_wallets() {
        assert!(check_call("listunspent", &json!([]), &Some("dynastytrust-abc".into())).is_ok());
        assert!(check_call("listunspent", &json!([]), &Some("mywallet".into())).is_err());
        assert!(check_call("listunspent", &json!([]), &None).is_err());
        assert!(check_call("getblockcount", &json!([]), &Some("dynastytrust-abc".into())).is_err());
        assert!(check_call("createwallet", &json!(["dynastytrust-abc", true, true]), &None).is_ok());
        assert!(check_call("createwallet", &json!(["dynastytrust-abc", false, true]), &None).is_err(), "must be watch-only");
        assert!(check_call("createwallet", &json!(["dynastytrust-abc", true, false]), &None).is_err(), "must be blank");
        assert!(check_call("createwallet", &json!(["savings", true, true]), &None).is_err());
        assert!(check_call("loadwallet", &json!(["savings"]), &None).is_err());
        assert!(check_call("loadwallet", &json!(["dynastytrust-abc"]), &None).is_ok());
    }

    #[test]
    fn network_layouts() {
        assert_eq!(network_layout("bitcoin").unwrap(), ("", 8332));
        assert_eq!(network_layout("regtest").unwrap(), ("regtest", 18443));
        assert!(network_layout("litecoin").is_err());
    }
}

/// Against a real Bitcoin Core: `DT_CORE_DATADIR=<regtest datadir> cargo test -- --ignored`.
#[cfg(test)]
mod live_core {
    use super::*;
    fn conn() -> CoreConn {
        CoreConn { network: "regtest".into(), datadir: std::env::var("DT_CORE_DATADIR").ok(), port: std::env::var("DT_CORE_PORT").ok().and_then(|p| p.parse().ok()) }
    }
    #[test]
    #[ignore]
    fn talks_to_core_within_the_allow_list() {
        let n = rpc_blocking(conn(), "getblockcount".into(), json!([]), None).expect("getblockcount");
        assert!(n.as_u64().is_some());
        let w = rpc_blocking(conn(), "createwallet".into(), json!(["dynastytrust-test", true, true]), None).expect("watch-only wallet");
        assert_eq!(w["name"], "dynastytrust-test");
        let info = rpc_blocking(conn(), "getwalletinfo".into(), json!([]), Some("dynastytrust-test".into())).expect("walletinfo");
        assert_eq!(info["private_keys_enabled"], false, "the app's wallet must hold no private keys");
        assert!(rpc_blocking(conn(), "stop".into(), json!([]), None).is_err(), "stop must never reach Core");
        assert!(rpc_blocking(conn(), "getblockcount".into(), json!([]), None).is_ok(), "Core still running");
        let bad = rpc_blocking(CoreConn { network: "regtest".into(), datadir: Some("/nonexistent".into()), port: None }, "getblockcount".into(), json!([]), None);
        assert!(bad.unwrap_err().contains("not running"));
    }
}
