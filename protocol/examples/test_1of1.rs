use dynastytrust_protocol::{DynastyPolicy, compile_dynasty_policy_tr_multileaf};
use bitcoin::{Network, PublicKey};
use std::str::FromStr;

fn main() {
    let pk = PublicKey::from_str("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97").unwrap();
    let policy = DynastyPolicy {
        founder_keys: vec![pk],
        founder_quorum: 1,
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
    };
    let r = compile_dynasty_policy_tr_multileaf(policy, Network::Testnet);
    match r {
        Ok(v) => println!("OK: {}", v.address),
        Err(e) => println!("ERR: {}", e),
    }
}
