// Inputs for the ranged-address test vectors (protocol/tests/vectors/ranged.json).
//
//   cargo run -q -p dynastytrust_protocol --example ranged_vectors > /tmp/ranged-shapes.json
//   python3 -I scripts/ranged-vectors/generate.py /tmp/ranged-shapes.json   # needs bitcoind + embit
//
// This prints each shape's keys and policy, plus what THIS crate derives.
// The generator then asks Bitcoin Core (deriveaddresses) and embit (the
// library SeedSigner uses) for the same addresses independently, refuses to
// write anything unless all three agree, and stores Core's answers as the
// expected values. The Rust test reads the stored file, never this output.
use std::str::FromStr;

use bitcoin::bip32::{DerivationPath, Xpriv, Xpub};
use bitcoin::secp256k1::{Secp256k1, SecretKey};
use bitcoin::{Network, PublicKey};
use dynastytrust_protocol::ranged::{Branch, KeyOrigin, RangedVault};
use dynastytrust_protocol::{build_leaf_multileaf, Leaf, LeafPolicy, Unlock};
use serde_json::{json, Value};

const PATH: &str = "m/48'/1'/0'/2'";

struct Key {
    origin: KeyOrigin,
    first: PublicKey,
}

fn key(n: u8) -> Key {
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(Network::Regtest, &[n; 32]).unwrap();
    let path = DerivationPath::from_str(PATH).unwrap();
    let account = master.derive_priv(&secp, &path).unwrap();
    let xpub = Xpub::from_priv(&secp, &account);
    let first = xpub.derive_pub(&secp, &DerivationPath::from_str("m/0/0").unwrap()).unwrap().public_key;
    Key {
        origin: KeyOrigin { fingerprint: master.fingerprint(&secp), account_path: path, xpub },
        first: PublicKey::new(first),
    }
}

/// A bare key with no xpub, as a Tapit Wallet key arrives.
fn tapit(n: u8) -> PublicKey {
    let secp = Secp256k1::new();
    PublicKey::new(SecretKey::from_slice(&[n; 32]).unwrap().public_key(&secp))
}

fn leaf(id: &str, keys: Vec<PublicKey>, quorum: usize, unlock: Unlock) -> Leaf {
    Leaf { id: id.into(), label: id.into(), keys, quorum, unlock, decay: None, required_keys: vec![] }
}

fn shape(name: &str, about: &str, leaves: Vec<Leaf>, origins: Vec<&Key>) -> Value {
    let policy = LeafPolicy { leaves, consent_keys: vec![], consent_quorum: None };
    let compiled = build_leaf_multileaf(&policy).unwrap();
    let origins: Vec<KeyOrigin> = origins.iter().map(|k| k.origin.clone()).collect();
    let vault = RangedVault::from_template(&compiled.descriptor, &origins, Network::Regtest).unwrap();
    json!({
        "name": name,
        "about": about,
        "network": "regtest",
        "policy": serde_json::to_value(&policy).unwrap(),
        "origins": origins.iter().map(|o| json!({
            "fingerprint": o.fingerprint.to_string(),
            "account_path": o.account_path.to_string(),
            "xpub": o.xpub.to_string(),
        })).collect::<Vec<_>>(),
        "template_descriptor": compiled.descriptor,
        "multipath_descriptor": vault.multipath_descriptor(),
        "receive_descriptor": vault.branch_descriptor(Branch::Receive),
        "change_descriptor": vault.branch_descriptor(Branch::Change),
        "rust_receive": vault.addresses(Branch::Receive, 0, 10).unwrap(),
        "rust_change": vault.addresses(Branch::Change, 0, 10).unwrap(),
    })
}

fn main() {
    let k: Vec<Key> = (1..=6).map(key).collect();
    let (t1, t2) = (tapit(41), tapit(42));
    let shapes = vec![
        shape(
            "poc",
            "The PoC shape: everyday 1-of-1, two fixed-date paths.",
            vec![
                leaf("everyday", vec![k[0].first], 1, Unlock::Immediate),
                leaf("recovery", vec![k[1].first], 1, Unlock::After { blocks: 400_000 }),
                leaf("inheritance", vec![k[2].first], 1, Unlock::After { blocks: 500_000 }),
            ],
            vec![&k[0], &k[1], &k[2]],
        ),
        shape(
            "family",
            "2-of-2 now, 2-of-3 after a year, two long-horizon inheritance paths; keys shared across paths.",
            vec![
                leaf("everyday", vec![k[0].first, k[1].first], 2, Unlock::Immediate),
                leaf("recovery", vec![k[0].first, k[1].first, k[2].first], 2, Unlock::After { blocks: 352_560 }),
                leaf("heirs", vec![k[3].first, k[4].first], 1, Unlock::After { blocks: 500_000 }),
                leaf("backstop", vec![k[5].first], 1, Unlock::After { blocks: 600_000 }),
            ],
            vec![&k[0], &k[1], &k[2], &k[3], &k[4], &k[5]],
        ),
        shape(
            "untouched",
            "An if-left-untouched path (older) beside a fixed date.",
            vec![
                leaf("everyday", vec![k[0].first, k[1].first, k[2].first], 2, Unlock::Immediate),
                leaf("quiet", vec![k[0].first, k[1].first, k[2].first], 1, Unlock::OlderThan { blocks: 52_560 }),
                leaf("heirs", vec![k[3].first], 1, Unlock::After { blocks: 400_000 }),
            ],
            vec![&k[0], &k[1], &k[2], &k[3]],
        ),
        shape(
            "tapit",
            "A Tapit-only everyday path (two bare keys), an owner path, and a path mixing a Tapit key with an owner key.",
            vec![
                leaf("circle", vec![t1, t2], 2, Unlock::Immediate),
                leaf("owner", vec![k[0].first], 1, Unlock::After { blocks: 400_000 }),
                leaf("mixed", vec![t1, k[1].first], 2, Unlock::After { blocks: 500_000 }),
            ],
            vec![&k[0], &k[1]],
        ),
    ];
    println!("{}", serde_json::to_string_pretty(&json!({ "shapes": shapes })).unwrap());
}
