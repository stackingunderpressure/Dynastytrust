// cargo run -q -p dynastytrust_protocol --example ranged_poc < in.json
use std::io::Read;
use std::str::FromStr;
use bitcoin::{Network, PublicKey};
use dynastytrust_protocol::ranged::*;
use dynastytrust_protocol::{build_leaf_multileaf, Leaf, LeafPolicy, Unlock};
use serde_json::{json, Value};

fn net(s: &str) -> Network { match s { "signet" => Network::Signet, "regtest" => Network::Regtest, "testnet" => Network::Testnet, _ => panic!("network") } }

fn leaves_from(v: &Value, keyset: &str) -> LeafPolicy {
    let leaves = v["leaves"].as_array().unwrap().iter().map(|l| Leaf {
        id: l["id"].as_str().unwrap().into(),
        label: l["id"].as_str().unwrap().into(),
        keys: l[keyset].as_array().unwrap().iter().map(|k| PublicKey::from_str(k.as_str().unwrap()).unwrap()).collect(),
        quorum: 1,
        unlock: match l["after"].as_u64() { Some(h) => Unlock::After { blocks: h as u32 }, None => Unlock::Immediate },
        decay: None,
        required_keys: vec![],
    }).collect();
    LeafPolicy { leaves, consent_keys: vec![], consent_quorum: None }
}

fn main() {
    let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap();
    let v: Value = serde_json::from_str(&s).unwrap();
    let network = net(v["network"].as_str().unwrap());
    let t0 = std::time::Instant::now();
    // 1. compile the policy ONCE with the /0/0 keys -> template
    let tmpl = build_leaf_multileaf(&leaves_from(&v, "keys")).unwrap();
    let compile_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let keys: Vec<KeyExpr> = v["key_exprs"].as_array().unwrap().iter().map(|k| KeyExpr {
        template_pubkey: k["pubkey"].as_str().unwrap().into(), fingerprint: k["fp"].as_str().unwrap().into(),
        account_path: k["path"].as_str().unwrap().into(), xpub: k["xpub"].as_str().unwrap().into() }).collect();
    let ranged = ranged_from_template(&tmpl.descriptor, &keys).unwrap();
    let n = v["count"].as_u64().unwrap_or(5) as u32;
    let t1 = std::time::Instant::now();
    let recv = derive_addresses(&ranged, network, 0, 0, n).unwrap();
    let chg = derive_addresses(&ranged, network, 1, 0, n).unwrap();
    let derive_ms = t1.elapsed().as_secs_f64() * 1000.0;
    // 2. cross-check: recompiling the whole policy with the index-i child keys gives the same address
    let mut recompile = vec![];
    if let Some(per) = v["per_index_keys"].as_array() {
        for p in per {
            let pol = leaves_from(&json!({"leaves": p["leaves"]}), "keys");
            let out = build_leaf_multileaf(&pol).unwrap();
            recompile.push(bitcoin::Address::p2tr_tweaked(out.spend_info.output_key(), network).to_string());
        }
    }
    let mut res = json!({"template_address": bitcoin::Address::p2tr_tweaked(tmpl.spend_info.output_key(), network).to_string(),
        "ranged_descriptor": ranged, "receive": recv, "change": chg, "recompile_per_index": recompile,
        "compile_ms": compile_ms, "derive_10_addresses_ms": derive_ms});
    if let Some(sp) = v.get("spend") {
        let ins: Vec<RangedInput> = sp["inputs"].as_array().unwrap().iter().map(|i| RangedInput {
            txid: i["txid"].as_str().unwrap().into(), vout: i["vout"].as_u64().unwrap() as u32, value_sats: i["value"].as_u64().unwrap(),
            branch: i["branch"].as_u64().unwrap() as usize, index: i["index"].as_u64().unwrap() as u32 }).collect();
        let p = build_ranged_spend_psbt(&ranged, network, &ins, sp["dest"].as_str().unwrap(), sp["amount"].as_u64().unwrap(),
            sp["fee"].as_u64().unwrap(), sp["change_index"].as_u64().unwrap() as u32, sp["lock_time"].as_u64().unwrap_or(0) as u32).unwrap();
        res["psbt_hex"] = json!(hex::encode(p.serialize()));
    }
    println!("{}", serde_json::to_string_pretty(&res).unwrap());
}
