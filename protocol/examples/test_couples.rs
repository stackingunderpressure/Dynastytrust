use dynastytrust_protocol::{DynastyPolicy, compile_dynasty_policy_tr_multileaf};
use bitcoin::{Network, PublicKey};
use std::str::FromStr;

fn main() {
    // Two different valid public keys
    let pk1 = PublicKey::from_str("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97").unwrap();
    let pk2 = PublicKey::from_str("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569").unwrap();
    let policy = DynastyPolicy {
        founder_keys: vec![pk1, pk2],
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
    let r = compile_dynasty_policy_tr_multileaf(policy, Network::Testnet);
    match r {
        Ok(v) => println!("OK: {}", v.address),
        Err(e) => println!("ERR: {}", e),
    }
}
