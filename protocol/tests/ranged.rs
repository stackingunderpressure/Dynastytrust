//! Ranged (v2) vaults: addresses against independent implementations, the
//! safety checks on building one, a multi-input spend, and exactly what a
//! path made only of Tapit (bare) keys gives away.
//!
//! The expected addresses in tests/vectors/ranged.json come from Bitcoin
//! Core's deriveaddresses, confirmed by embit (SeedSigner's library); see
//! scripts/ranged-vectors/generate.py. Never edit that file by hand.

use std::collections::HashSet;
use std::str::FromStr;

use bitcoin::bip32::{ChildNumber, DerivationPath, Fingerprint, Xpub};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::taproot::{LeafVersion, TapLeafHash, TapNodeHash};
use bitcoin::{Network, PublicKey};
use dynastytrust_protocol::ranged::{Branch, KeyOrigin, RangedError, RangedInput, RangedVault, MAX_ADDRESS_BATCH, MAX_INDEX};
use dynastytrust_protocol::{build_leaf_multileaf, LeafPolicy};
use miniscript::descriptor::Descriptor;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/ranged.json")).unwrap()
}

fn shape(name: &str) -> Value {
    vectors()["shapes"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone()
}

fn origins(s: &Value) -> Vec<KeyOrigin> {
    s["origins"].as_array().unwrap().iter().map(|o| KeyOrigin {
        fingerprint: Fingerprint::from_str(o["fingerprint"].as_str().unwrap()).unwrap(),
        account_path: DerivationPath::from_str(o["account_path"].as_str().unwrap()).unwrap(),
        xpub: Xpub::from_str(o["xpub"].as_str().unwrap()).unwrap(),
    }).collect()
}

fn policy(s: &Value) -> LeafPolicy {
    serde_json::from_value(s["policy"].clone()).unwrap()
}

fn vault(s: &Value) -> RangedVault {
    let compiled = build_leaf_multileaf(&policy(s)).unwrap();
    RangedVault::from_template(&compiled.descriptor, &origins(s), Network::Regtest).unwrap()
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
}

// 1. Every shape: the same descriptors (checksums Core accepted) and the same
//    20 addresses Core derived.
#[test]
fn addresses_match_bitcoin_core_and_embit() {
    let v = vectors();
    let shapes = v["shapes"].as_array().unwrap();
    assert!(shapes.len() >= 4);
    for s in shapes {
        let name = s["name"].as_str().unwrap();
        let compiled = build_leaf_multileaf(&policy(s)).unwrap();
        assert_eq!(compiled.descriptor, s["template_descriptor"].as_str().unwrap(), "{name}: compile changed");
        let vlt = vault(s);
        assert_eq!(vlt.multipath_descriptor(), s["multipath_descriptor"].as_str().unwrap(), "{name}");
        assert_eq!(vlt.branch_descriptor(Branch::Receive), s["receive_descriptor"].as_str().unwrap(), "{name}");
        assert_eq!(vlt.branch_descriptor(Branch::Change), s["change_descriptor"].as_str().unwrap(), "{name}");
        assert_eq!(vlt.addresses(Branch::Receive, 0, 10).unwrap(), strs(&s["receive"]), "{name}: receive");
        assert_eq!(vlt.addresses(Branch::Change, 0, 10).unwrap(), strs(&s["change"]), "{name}: change");
        // All 20 different.
        let all: HashSet<_> = strs(&s["receive"]).into_iter().chain(strs(&s["change"])).collect();
        assert_eq!(all.len(), 20, "{name}: an address repeats");
    }
}

// 2. Receive/0 is the vault a v1 compile would have made.
#[test]
fn receive_zero_is_the_compiled_v1_address() {
    for name in ["poc", "family", "untouched", "tapit"] {
        let s = shape(name);
        let compiled = build_leaf_multileaf(&policy(&s)).unwrap();
        let v1 = bitcoin::Address::p2tr_tweaked(compiled.spend_info.output_key(), Network::Regtest).to_string();
        assert_eq!(vault(&s).address(Branch::Receive, 0).unwrap(), v1, "{name}");
    }
}

// 3. Swapping keys in the descriptor is the same as compiling the whole
//    policy again with each key's /0/i child -- at several indexes.
#[test]
fn derived_address_equals_a_full_recompile_at_that_index() {
    let secp = Secp256k1::verification_only();
    let s = shape("family");
    let base = policy(&s);
    let os = origins(&s);
    let first = |o: &KeyOrigin, i: u32| {
        let p = [ChildNumber::Normal { index: 0 }, ChildNumber::Normal { index: i }];
        PublicKey::new(o.xpub.derive_pub(&secp, &p).unwrap().public_key)
    };
    let vlt = vault(&s);
    for i in [1u32, 3, 9, 250] {
        let mut p = base.clone();
        for leaf in &mut p.leaves {
            for k in &mut leaf.keys {
                let o = os.iter().find(|o| first(o, 0) == *k).unwrap();
                *k = first(o, i);
            }
        }
        let out = build_leaf_multileaf(&p).unwrap();
        let recompiled = bitcoin::Address::p2tr_tweaked(out.spend_info.output_key(), Network::Regtest).to_string();
        assert_eq!(vlt.address(Branch::Receive, i).unwrap(), recompiled, "receive/{i}");
    }
}

// 4. The checks that keep a v2 vault the same vault.
#[test]
fn refuses_what_would_not_be_the_same_vault() {
    let s = shape("family");
    let template = s["template_descriptor"].as_str().unwrap();
    let os = origins(&s);
    let net = Network::Regtest;

    // An xpub whose /0/0 key is not in the vault.
    let other = origins(&shape("tapit"));
    let stranger = other.iter().find(|o| !os.iter().any(|x| x.xpub == o.xpub));
    if let Some(st) = stranger {
        let mut bad = os.clone();
        bad.push(st.clone());
        assert_eq!(RangedVault::from_template(template, &bad, net).unwrap_err(), RangedError::OriginNotInVault(os.len()));
    }
    let mut wrong_path = os.clone();
    wrong_path[0].xpub = wrong_path[1].xpub; // two origins, one key
    assert!(matches!(RangedVault::from_template(template, &wrong_path, net).unwrap_err(), RangedError::DuplicateOrigin(_, _)));

    // A test-network xpub on a Bitcoin vault.
    assert!(matches!(RangedVault::from_template(template, &os, Network::Bitcoin).unwrap_err(), RangedError::OriginNetwork(0, _, _)));

    // No xpubs at all: every address would be the same.
    assert_eq!(RangedVault::from_template(template, &[], net).unwrap_err(), RangedError::NothingRanged);

    // An internal key someone could spend with.
    let spendable = template.replace("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0", "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    let spendable = spendable.split('#').next().unwrap();
    assert_eq!(RangedVault::from_template(spendable, &os, net).unwrap_err(), RangedError::InternalKeyNotNums);

    // Index and batch bounds.
    let vlt = vault(&s);
    assert_eq!(vlt.addresses(Branch::Receive, 0, MAX_ADDRESS_BATCH + 1).unwrap_err(), RangedError::Count(MAX_ADDRESS_BATCH + 1));
    assert!(matches!(vlt.addresses(Branch::Receive, MAX_INDEX, 2).unwrap_err(), RangedError::Index(_)));
    assert!(matches!(vlt.address(Branch::Change, MAX_INDEX + 1).unwrap_err(), RangedError::Index(_)));
    assert!(vlt.address(Branch::Change, MAX_INDEX).is_ok());
}

// 5. One spend from three different addresses, change to the change branch:
//    every input and the change output carry their own per-index origins.
#[test]
fn multi_input_spend_carries_each_coins_own_derivation() {
    let s = shape("family");
    let vlt = vault(&s);
    let txid = |n: u8| format!("{:064x}", n);
    let ins = vec![
        RangedInput { txid: txid(1), vout: 0, value_sats: 40_000, branch: Branch::Receive, index: 1 },
        RangedInput { txid: txid(2), vout: 1, value_sats: 50_000, branch: Branch::Receive, index: 7 },
        RangedInput { txid: txid(3), vout: 0, value_sats: 30_000, branch: Branch::Change, index: 2 },
    ];
    let dest = vlt.address(Branch::Receive, 0).unwrap(); // any valid regtest address
    let psbt = vlt.build_spend_psbt(&ins, &dest, 100_000, 1_000, 4, 352_560).unwrap();
    assert_eq!(psbt.unsigned_tx.lock_time.to_consensus_u32(), 352_560);
    for (n, i) in ins.iter().enumerate() {
        let inp = &psbt.inputs[n];
        let want = vlt.definite(i.branch, i.index).unwrap().script_pubkey();
        assert_eq!(inp.witness_utxo.as_ref().unwrap().script_pubkey, want, "input {n} script");
        assert!(!inp.tap_scripts.is_empty() && inp.tap_internal_key.is_some(), "input {n} leaves");
        let suffix = [ChildNumber::Normal { index: i.branch as u32 }, ChildNumber::Normal { index: i.index }];
        assert!(!inp.tap_key_origins.is_empty());
        // Every key with an origin is at this coin's branch/index; the only
        // entry without a path is the NUMS internal key.
        let mut no_path = 0;
        for (_, (_, (_, path))) in &inp.tap_key_origins {
            if path.is_empty() { no_path += 1; continue; }
            assert_eq!(&path[path.len() - 2..], &suffix, "input {n} key path");
        }
        assert!(no_path <= 1, "input {n}: more than the internal key without a path");
    }
    let change = &psbt.outputs[1];
    assert_eq!(psbt.unsigned_tx.output[1].value.to_sat(), 120_000 - 101_000);
    assert_eq!(psbt.unsigned_tx.output[1].script_pubkey, vlt.definite(Branch::Change, 4).unwrap().script_pubkey());
    assert!(change.tap_tree.is_some() && change.tap_internal_key.is_some());
    for (_, (_, path)) in change.tap_key_origins.values() {
        if path.is_empty() { continue; } // the NUMS internal key
        assert_eq!(&path[path.len() - 2..], &[ChildNumber::Normal { index: 1 }, ChildNumber::Normal { index: 4 }]);
    }
    // Not enough, and change below dust goes to the fee.
    assert!(matches!(vlt.build_spend_psbt(&ins, &dest, 200_000, 1_000, 4, 0).unwrap_err(), RangedError::Insufficient { .. }));
    let no_change = vlt.build_spend_psbt(&ins, &dest, 118_700, 1_000, 4, 0).unwrap();
    assert_eq!(no_change.unsigned_tx.output.len(), 1);
}

// 6. A path made only of Tapit (bare) keys. Measured, not assumed.
//
// The tree is a chain: the first path sits alone at depth 1, so the hash of
// the first path is a sibling in the proof of EVERY other path.
fn leaf_scripts(vlt: &RangedVault, index: u32) -> Vec<(String, bitcoin::ScriptBuf)> {
    let d = vlt.definite(Branch::Receive, index).unwrap();
    let tr = match d { Descriptor::Tr(t) => t, _ => panic!("tr") };
    tr.iter_scripts().map(|(_, ms)| (ms.to_string(), ms.encode())).collect()
}

fn proofs(vlt: &RangedVault, index: u32) -> Vec<Vec<TapNodeHash>> {
    let d = vlt.definite(Branch::Receive, index).unwrap();
    let tr = match d { Descriptor::Tr(t) => t, _ => panic!("tr") };
    let info = tr.spend_info();
    tr.iter_scripts()
        .map(|(_, ms)| info.control_block(&(ms.encode(), LeafVersion::TapScript)).unwrap().merkle_branch.into_inner())
        .collect()
}

#[test]
fn tapit_only_path_repeats_and_shows_up_in_other_paths_proofs() {
    let vlt = vault(&shape("tapit"));
    let (a, b) = (leaf_scripts(&vlt, 0), leaf_scripts(&vlt, 5));
    // Leaf order in the tree: circle (Tapit only), owner, mixed.
    assert_eq!(a.len(), 3);
    // The Tapit-only path has the SAME script at every address ...
    assert_eq!(a[0].1, b[0].1, "Tapit-only path script");
    // ... while a path with any ranged key changes, the mixed one included.
    assert_ne!(a[1].1, b[1].1, "owner path");
    assert_ne!(a[2].1, b[2].1, "mixed Tapit + owner path");
    // The addresses still differ (the tree as a whole changes).
    assert_ne!(vlt.address(Branch::Receive, 0).unwrap(), vlt.address(Branch::Receive, 5).unwrap());

    // Spending the OWNER or MIXED path reveals a proof whose first sibling is
    // the Tapit-only path's hash: identical at both addresses. So any spend
    // from this vault, through any path, links the addresses it spends from.
    let circle_hash = TapNodeHash::from(TapLeafHash::from_script(&a[0].1, LeafVersion::TapScript));
    let circle_hash_5 = TapNodeHash::from(TapLeafHash::from_script(&b[0].1, LeafVersion::TapScript));
    assert_eq!(circle_hash, circle_hash_5);
    let (p0, p5) = (proofs(&vlt, 0), proofs(&vlt, 5));
    for path in [1usize, 2] {
        assert!(p0[path].contains(&circle_hash), "path {path} at /0/0 proof shows the circle hash");
        assert!(p5[path].contains(&circle_hash), "path {path} at /0/5 proof shows the circle hash");
    }
    // Spending the Tapit-only path itself reveals its script (the same one)
    // plus a sibling that DOES change per address.
    assert_ne!(p0[0], p5[0]);
}

#[test]
fn a_ranged_first_path_hides_a_tapit_only_path_from_other_spends() {
    // Same keys, Tapit-only path moved last: now it is never alone as a
    // sibling of a path with ranged keys except its last neighbour.
    let mut s = shape("tapit");
    let mut p = policy(&s);
    let circle = p.leaves.remove(0);
    p.leaves.push(circle);
    s["policy"] = serde_json::to_value(&p).unwrap();
    let vlt = vault(&s);
    let (a, b) = (leaf_scripts(&vlt, 0), leaf_scripts(&vlt, 5));
    // Order now: owner, mixed, circle.
    assert_eq!(a[2].1, b[2].1, "the Tapit-only script still repeats");
    let circle_hash = TapNodeHash::from(TapLeafHash::from_script(&a[2].1, LeafVersion::TapScript));
    let (p0, p5) = (proofs(&vlt, 0), proofs(&vlt, 5));
    // The owner path (depth 1) proves against the hash of the rest of the
    // tree, which includes ranged keys and so changes: no link from it.
    assert!(!p0[0].contains(&circle_hash) && !p5[0].contains(&circle_hash), "owner spend hides the circle");
    assert_ne!(p0[0], p5[0]);
    // The mixed path is the circle's last-pair neighbour: its proof still
    // carries the circle hash at every address.
    assert!(p0[1].contains(&circle_hash) && p5[1].contains(&circle_hash), "mixed spend still shows the circle");
}

// 7. Rebuilding from what the database stores gives the same addresses, and
//    anything tampered or mismatched is refused.
#[test]
fn from_stored_reproduces_and_refuses_tampering() {
    for s in vectors()["shapes"].as_array().unwrap() {
        let (m, r, c) = (s["multipath_descriptor"].as_str().unwrap(), s["receive_descriptor"].as_str().unwrap(), s["change_descriptor"].as_str().unwrap());
        let v = RangedVault::from_stored(m, r, c, Network::Regtest).unwrap();
        assert_eq!(v.addresses(Branch::Receive, 0, 10).unwrap(), strs(&s["receive"]));
        assert_eq!(v.addresses(Branch::Change, 0, 10).unwrap(), strs(&s["change"]));
        assert_eq!(v.branch_checksum(Branch::Receive), r.rsplit('#').next().unwrap());
    }
    let s = shape("family");
    let (m, r, c) = (s["multipath_descriptor"].as_str().unwrap(), s["receive_descriptor"].as_str().unwrap(), s["change_descriptor"].as_str().unwrap());
    let other = shape("poc");
    // Halves from another vault.
    assert!(RangedVault::from_stored(m, other["receive_descriptor"].as_str().unwrap(), c, Network::Regtest).is_err());
    // Receive and change swapped.
    assert!(RangedVault::from_stored(m, c, r, Network::Regtest).is_err());
    // A wrong checksum, and none at all.
    let bad = format!("{}#qqqqqqqq", m.split('#').next().unwrap());
    assert!(RangedVault::from_stored(&bad, r, c, Network::Regtest).is_err());
    assert!(RangedVault::from_stored(m.split('#').next().unwrap(), r, c, Network::Regtest).is_err());
    // A fixed (v1) descriptor is not a ranged vault.
    let v1 = s["template_descriptor"].as_str().unwrap();
    let v1 = format!("{}", miniscript::Descriptor::<miniscript::DescriptorPublicKey>::from_str(v1).unwrap());
    assert_eq!(RangedVault::from_stored(&v1, &v1, &v1, Network::Regtest).unwrap_err(), RangedError::NothingRanged);
}

// 8. The /ranged-address route (what the address-issuing function calls,
//    through the compiler wasm) returns the vector's script and the branch
//    descriptor's checksum, and refuses a bad branch.
#[test]
fn ranged_address_route_matches_the_vectors() {
    use dynastytrust_protocol::service::handle;
    let s = shape("family");
    let req = |branch: u8, index: u32| serde_json::json!({
        "multipath": s["multipath_descriptor"], "receive": s["receive_descriptor"], "change": s["change_descriptor"],
        "network": "signet", "branch": branch, "index": index,
    }).to_string();
    for (branch, key) in [(0u8, "receive"), (1, "change")] {
        for i in [0u32, 4, 9] {
            let (status, body) = handle("/ranged-address", &req(branch, i));
            assert_eq!(status, 200, "{body}");
            let v: Value = serde_json::from_str(&body).unwrap();
            // Signet and regtest share the witness program; compare scripts.
            let want = bitcoin::Address::from_str(s[key][i as usize].as_str().unwrap()).unwrap().assume_checked().script_pubkey();
            assert_eq!(v["script_pubkey"].as_str().unwrap(), hex::encode(want.as_bytes()), "{key}/{i}");
            assert!(v["address"].as_str().unwrap().starts_with("tb1p"));
            let desc = s[format!("{key}_descriptor")].as_str().unwrap();
            assert_eq!(v["descriptor_checksum"].as_str().unwrap(), desc.rsplit('#').next().unwrap());
        }
    }
    assert_eq!(handle("/ranged-address", &req(2, 0)).0, 400);
    assert_eq!(handle("/ranged-address", &req(0, MAX_INDEX + 1)).0, 400);
}

// 9. The /ranged-compile route (what the compile functions call, slice 3)
//    turns the compiled vault into exactly the vector's descriptors, and
//    refuses an xpub that is not one of the vault's keys.
#[test]
fn ranged_compile_route_makes_the_vectors_descriptors() {
    use dynastytrust_protocol::service::handle;
    let s = shape("family");
    let compiled = build_leaf_multileaf(&policy(&s)).unwrap();
    let wire: Vec<Value> = s["origins"].as_array().unwrap().iter().map(|o| serde_json::json!({
        "fingerprint": o["fingerprint"], "account_path": o["account_path"], "xpub": o["xpub"],
    })).collect();
    let req = |origins: &Vec<Value>| serde_json::json!({
        "template": compiled.descriptor, "network": "signet", "origins": origins,
    }).to_string();
    let (status, body) = handle("/ranged-compile", &req(&wire));
    assert_eq!(status, 200, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["multipath"], s["multipath_descriptor"]);
    assert_eq!(v["receive"], s["receive_descriptor"]);
    assert_eq!(v["change"], s["change_descriptor"]);
    let want0 = bitcoin::Address::from_str(s["receive"][0].as_str().unwrap()).unwrap().assume_checked().script_pubkey();
    let got0 = bitcoin::Address::from_str(v["receive0"].as_str().unwrap()).unwrap().assume_checked().script_pubkey();
    assert_eq!(got0, want0, "receive/0 is the compiled address");

    // An xpub that is not one of this vault's keys (a different seed; every
    // vector shape shares the same test keys, so one is made here): refused.
    let secp = Secp256k1::new();
    let master = bitcoin::bip32::Xpriv::new_master(Network::Testnet, &[7u8; 32]).unwrap();
    let path = DerivationPath::from_str("m/48'/1'/0'/2'").unwrap();
    let foreign = Xpub::from_priv(&secp, &master.derive_priv(&secp, &path).unwrap());
    let mut wrong = wire.clone();
    wrong[0] = serde_json::json!({ "fingerprint": master.fingerprint(&secp).to_string(), "account_path": "m/48'/1'/0'/2'", "xpub": foreign.to_string() });
    let (status, body) = handle("/ranged-compile", &req(&wrong));
    assert_eq!(status, 422, "{body}");
    // And a set that leaves one of the vault's xpub keys fixed still works
    // only if every given origin is in the vault: dropping one is allowed.
    let fewer: Vec<Value> = wire[1..].to_vec();
    assert_eq!(handle("/ranged-compile", &req(&fewer)).0, 200);

    // /ranged-addresses lists the same change addresses as the vectors.
    let list = serde_json::json!({
        "multipath": v["multipath"], "receive": v["receive"], "change": v["change"],
        "network": "signet", "branch": 1, "start": 0, "count": 10,
    }).to_string();
    let (status, body) = handle("/ranged-addresses", &list);
    assert_eq!(status, 200, "{body}");
    let l: Value = serde_json::from_str(&body).unwrap();
    for i in 0..10usize {
        let want = bitcoin::Address::from_str(s["change"][i].as_str().unwrap()).unwrap().assume_checked().script_pubkey();
        assert_eq!(l["addresses"][i]["script_pubkey"].as_str().unwrap(), hex::encode(want.as_bytes()), "change/{i}");
    }
    let too_many = serde_json::json!({ "multipath": v["multipath"], "receive": v["receive"], "change": v["change"], "network": "signet", "branch": 0, "start": 0, "count": 201 }).to_string();
    assert_eq!(handle("/ranged-addresses", &too_many).0, 400);
}
