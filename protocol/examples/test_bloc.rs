// Dynasty Bloc shape: 2 parents + 4 kids, decaying kid ladder.
//   A  parents together (2-of-2)                         now
//   B  one parent + every kid (1-of-2 AND 4-of-4)        now
//   C  one parent alone                       after ~1yr (T1)
//   D+ kids alone, 4-of-4 -> 1-of-4, one rung per year   after ~2yr (T2)
use bitcoin::{Network, PublicKey};
use dynastytrust_protocol::{compile_dynasty_bloc_tr_multileaf, DynastyBlocPolicy};
use std::str::FromStr;

fn main() {
    let p = |s: &str| PublicKey::from_str(s).unwrap();
    let policy = DynastyBlocPolicy {
        parent_keys: vec![
            p("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97"),
            p("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569"),
        ],
        parents_together_quorum: 2,
        coparent_quorum: 1,
        kid_keys: vec![
            p("03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34"),
            p("025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"),
            p("03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe"),
            p("02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"),
        ],
        kids_with_parent_quorum: 4,
        parent_solo_after: 100_000,
        parent_solo_quorum: 1,
        kids_decay_start_after: 200_000,
        kids_decay_step_blocks: 52_560,
        kids_decay_start_quorum: 4,
        kids_decay_floor_quorum: 1,
    };
    match compile_dynasty_bloc_tr_multileaf(policy, Network::Testnet) {
        Ok(v) => {
            println!("address:    {}", v.address);
            println!("policy:     {}", v.miniscript_policy);
            println!("descriptor: {}", v.descriptor);
        }
        Err(e) => println!("ERR: {e}"),
    }
}
