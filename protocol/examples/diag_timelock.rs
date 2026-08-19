// Diagnostic: confirm whether miniscript's `after()` emits CLTV
// (absolute height) or CSV (relative). DynastyTrust's policy
// compiler uses `after()` for recovery / inheritance
// branches with small block counts (26_280 = ~6mo). If that ends
// up as CLTV, every vault on mainnet/testnet/signet has the
// timelock paths already unlocked because those heights are long
// past.

use bitcoin::PublicKey;
use miniscript::policy::concrete::Policy;
use miniscript::Miniscript;
use std::str::FromStr;

fn dump(name: &str, policy_str: &str) {
    let pol: Policy<PublicKey> = policy_str.parse().unwrap();
    let ms: Miniscript<PublicKey, miniscript::Tap> = pol.compile().unwrap();
    let script = ms.encode();
    let bytes = script.as_bytes();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let has_cltv = bytes.contains(&0xb1); // OP_CHECKLOCKTIMEVERIFY
    let has_csv = bytes.contains(&0xb2); // OP_CHECKSEQUENCEVERIFY
    println!("{name}: {policy_str}");
    println!("  script hex: {hex}");
    println!("  has CLTV (0xb1, absolute): {has_cltv}");
    println!("  has CSV  (0xb2, relative): {has_csv}");
    println!();
}

fn main() {
    let pk = PublicKey::from_str(
        "02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97",
    )
    .unwrap();
    let policy_after = format!("and(after(26280),pk({pk}))");
    let policy_older = format!("and(older(26280),pk({pk}))");

    dump("after(26280)", &policy_after);
    dump("older(26280)", &policy_older);
}
