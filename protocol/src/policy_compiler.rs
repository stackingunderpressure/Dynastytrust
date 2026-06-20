use bitcoin::{Address, Network, PublicKey};
use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use bitcoin::taproot::{TaprootBuilder, TaprootSpendInfo};
use miniscript::policy::{Concrete, Liftable};
use miniscript::{Descriptor, Miniscript};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use thiserror::Error;

pub const MIN_RECOVERY_BLOCKS: u32 = 26_000;

const NUMS_HEX: &str =
    "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DynastyPolicy {
    pub founder_keys: Vec<PublicKey>,
    pub founder_quorum: usize,
    /// Quorum for the timelocked recovery branch. When set and
    /// different from `founder_quorum`, Path 2 becomes materially
    /// distinct from Path 1: e.g. 3-of-3 now, 2-of-3 after 3 months
    /// as insurance against a lost device. Null = fall back to
    /// `founder_quorum` (legacy behavior).
    #[serde(default)]
    pub recovery_quorum: Option<usize>,
    pub heir_keys: Vec<PublicKey>,
    pub heir_quorum: usize,
    pub recovery_after: u32,
    pub inheritance_after: u32,

    /// Optional protector branch -- an independent party (often a
    /// trust lawyer) who can spend after their own timelock.
    /// Typically set BETWEEN recovery_after and inheritance_after
    /// so: trustees recover first, then protector can rescue
    /// funds if trustees failed, then finally successor trustees
    /// take over for true incapacitation. All three fields must
    /// be set together.
    #[serde(default)]
    pub protector_keys: Vec<PublicKey>,
    #[serde(default)]
    pub protector_quorum: Option<usize>,
    #[serde(default)]
    pub protector_after: Option<u32>,

    /// Optional beneficiary-consent gate on Path 1 (founders-now).
    /// When set, every "normal" spend needs both the trustee quorum
    /// AND a beneficiary quorum to sign. Recovery / inheritance /
    /// protector paths are unaffected -- those exist precisely to
    /// rescue funds when a beneficiary won't or can't cosign.
    #[serde(default)]
    pub consent_keys: Vec<PublicKey>,
    #[serde(default)]
    pub consent_quorum: Option<usize>,
}

impl DynastyPolicy {
    pub fn is_plain(&self) -> bool {
        self.heir_keys.is_empty()
            && self.recovery_after == 0
            && self.inheritance_after == 0
            && self.protector_keys.is_empty()
    }

    pub fn has_protector(&self) -> bool {
        !self.protector_keys.is_empty()
            && self.protector_quorum.is_some()
            && self.protector_after.is_some()
    }

    pub fn has_consent(&self) -> bool {
        !self.consent_keys.is_empty() && self.consent_quorum.is_some()
    }
}

#[derive(Debug, Clone)]
pub struct CompiledVault {
    pub miniscript_policy: String,
    pub descriptor: String,
    pub address: Address,
    pub address_type: AddressType,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AddressType {
    Wsh,
    Tr,
    TrMultileaf,
}

impl std::fmt::Display for AddressType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Wsh => write!(f, "wsh"),
            Self::Tr => write!(f, "tr"),
            Self::TrMultileaf => write!(f, "tr_multileaf"),
        }
    }
}

#[derive(Error, Debug)]
pub enum PolicyError {
    #[error("invalid quorum: quorum must be > 0 and ≤ number of keys")]
    InvalidQuorum,
    #[error("recovery_after must be ≥ MIN_RECOVERY_BLOCKS ({MIN_RECOVERY_BLOCKS})")]
    RecoveryTooSoon,
    #[error("inheritance_after must be > recovery_after")]
    InheritanceTooSoon,
    #[error("miniscript policy error: {0}")]
    Miniscript(String),
    #[error("descriptor error: {0}")]
    Descriptor(String),
    #[error("invalid dynasty bloc policy: {0}")]
    InvalidBloc(String),
}

pub fn compile_dynasty_policy(
    policy: DynastyPolicy,
    network: Network,
) -> Result<CompiledVault, PolicyError> {
    verify(&policy)?;

    let miniscript_policy = build_policy_string(&policy);

    let concrete: Concrete<PublicKey> = miniscript_policy
        .parse()
        .map_err(|e| PolicyError::Miniscript(format!("{e:?}")))?;

    let ms: Miniscript<PublicKey, miniscript::Segwitv0> = concrete
        .compile()
        .map_err(|e| PolicyError::Miniscript(format!("{e:?}")))?;

    let desc_str = format!("wsh({})", ms);

    let desc: Descriptor<PublicKey> = Descriptor::from_str(&desc_str)
        .map_err(|e| PolicyError::Descriptor(format!("{e:?}")))?;

    let addr = desc
        .address(network)
        .map_err(|e| PolicyError::Descriptor(format!("{e:?}")))?;

    Ok(CompiledVault {
        miniscript_policy,
        descriptor: desc.to_string(),
        address: addr,
        address_type: AddressType::Wsh,
    })
}

pub fn compile_dynasty_policy_tr(
    policy: DynastyPolicy,
    network: Network,
) -> Result<CompiledVault, PolicyError> {
    verify(&policy)?;

    let miniscript_policy = build_policy_string(&policy);

    let concrete: Concrete<PublicKey> = miniscript_policy
        .parse()
        .map_err(|e| PolicyError::Miniscript(format!("{e:?}")))?;

    let ms: Miniscript<PublicKey, miniscript::Tap> = concrete
        .compile()
        .map_err(|e| PolicyError::Miniscript(format!("{e:?}")))?;

    let secp = Secp256k1::verification_only();

    let nums_bytes = hex::decode(NUMS_HEX)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS decode: {e}")))?;
    let internal_key = XOnlyPublicKey::from_slice(&nums_bytes)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS xonly: {e}")))?;

    let leaf_script = ms.encode();

    let builder = TaprootBuilder::new()
        .add_leaf(0, leaf_script)
        .map_err(|e| PolicyError::Descriptor(format!("add_leaf: {e:?}")))?;

    let spend_info = builder
        .finalize(&secp, internal_key)
        .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;

    let addr = Address::p2tr_tweaked(spend_info.output_key(), network);

    let descriptor = format!("tr({},{{{}}})", internal_key, ms);

    Ok(CompiledVault {
        miniscript_policy,
        descriptor,
        address: addr,
        address_type: AddressType::Tr,
    })
}

/// Everything downstream consumers need from a multileaf compile.
/// Keeping this in one struct + one function (build_multileaf) is
/// how we guarantee the spend_info that the PSBT builder uses for
/// control blocks is the same spend_info the compile handler used
/// for the address. If they ever drift, finalize explodes with
/// "Control block verification failed at index 0".
pub struct MultileafOutput {
    pub spend_info: TaprootSpendInfo,
    pub founder_leaf: bitcoin::ScriptBuf,
    pub descriptor: String,
    pub miniscript_policy: String,
}

/// Sole source of truth for multileaf tree construction. Used by
/// both `compile_dynasty_policy_tr_multileaf` (for address +
/// descriptor) and by the PSBT builder (for control blocks).
pub fn build_multileaf(policy: &DynastyPolicy) -> Result<MultileafOutput, PolicyError> {
    verify(policy)?;

    let secp = Secp256k1::verification_only();
    let nums_bytes = hex::decode(NUMS_HEX)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS decode: {e}")))?;
    let internal_key = XOnlyPublicKey::from_slice(&nums_bytes)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS xonly: {e}")))?;

    let founders: Vec<String> = policy
        .founder_keys
        .iter()
        .map(|k| format!("pk({k})"))
        .collect();

    let trustee_thresh = format!("thresh({},{})", policy.founder_quorum, founders.join(","));
    let founder_thresh = if policy.has_consent() {
        let consenters: Vec<String> = policy
            .consent_keys
            .iter()
            .map(|k| format!("pk({k})"))
            .collect();
        let consent_thresh = format!(
            "thresh({},{})",
            policy.consent_quorum.unwrap(),
            consenters.join(","),
        );
        format!("and({},{})", trustee_thresh, consent_thresh)
    } else {
        trustee_thresh
    };

    let compile_leaf =
        |policy_str: &str| -> Result<Miniscript<PublicKey, miniscript::Tap>, PolicyError> {
            policy_str
                .parse::<Concrete<PublicKey>>()
                .map_err(|e| PolicyError::Miniscript(format!("parse {policy_str}: {e:?}")))?
                .compile()
                .map_err(|e| PolicyError::Miniscript(format!("compile {policy_str}: {e:?}")))
        };

    let ms_founder = compile_leaf(&founder_thresh)?;
    let founder_leaf = ms_founder.encode();

    if policy.is_plain() {
        let builder = TaprootBuilder::new()
            .add_leaf(0, founder_leaf.clone())
            .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?;
        let spend_info = builder
            .finalize(&secp, internal_key)
            .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;
        // Single-leaf Taproot descriptor has no {} braces: those
        // denote a tap_branch (internal node). rust-miniscript
        // rejects tr(key,{leaf}) as "unknown format for script
        // spending paths". Only use braces for 2+ leaf trees.
        let descriptor = format!("tr({},{})", internal_key, ms_founder);
        return Ok(MultileafOutput {
            spend_info,
            founder_leaf,
            descriptor,
            miniscript_policy: founder_thresh,
        });
    }

    let heirs: Vec<String> = policy
        .heir_keys
        .iter()
        .map(|k| format!("pk({k})"))
        .collect();
    let recovery_quorum = policy.recovery_quorum.unwrap_or(policy.founder_quorum);
    let recovery_thresh = format!("thresh({},{})", recovery_quorum, founders.join(","));
    let recovery_branch = format!("and(after({}),{})", policy.recovery_after, recovery_thresh);
    let inheritance_branch = format!(
        "and(after({}),thresh({},{}))",
        policy.inheritance_after,
        policy.heir_quorum,
        heirs.join(","),
    );
    let ms_recovery = compile_leaf(&recovery_branch)?;
    let ms_inheritance = compile_leaf(&inheritance_branch)?;

    if policy.has_protector() {
        let protectors: Vec<String> = policy
            .protector_keys
            .iter()
            .map(|k| format!("pk({k})"))
            .collect();
        let protector_branch = format!(
            "and(after({}),thresh({},{}))",
            policy.protector_after.unwrap(),
            policy.protector_quorum.unwrap(),
            protectors.join(","),
        );
        let ms_protector = compile_leaf(&protector_branch)?;

        let builder = TaprootBuilder::new()
            .add_leaf(1, founder_leaf.clone())
            .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?
            .add_leaf(2, ms_recovery.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf recovery: {e:?}")))?
            .add_leaf(3, ms_inheritance.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf inheritance: {e:?}")))?
            .add_leaf(3, ms_protector.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf protector: {e:?}")))?;
        let spend_info = builder
            .finalize(&secp, internal_key)
            .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;
        let descriptor = format!(
            "tr({},{{{},{{{},{{{},{}}}}}}})",
            internal_key, ms_founder, ms_recovery, ms_inheritance, ms_protector
        );
        let miniscript_policy = format!(
            "or({},or({},or({},{})))",
            founder_thresh, recovery_branch, inheritance_branch, protector_branch
        );
        Ok(MultileafOutput {
            spend_info,
            founder_leaf,
            descriptor,
            miniscript_policy,
        })
    } else {
        let builder = TaprootBuilder::new()
            .add_leaf(1, founder_leaf.clone())
            .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?
            .add_leaf(2, ms_recovery.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf recovery: {e:?}")))?
            .add_leaf(2, ms_inheritance.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf inheritance: {e:?}")))?;
        let spend_info = builder
            .finalize(&secp, internal_key)
            .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;
        let descriptor = format!(
            "tr({},{{{},{{{},{}}}}})",
            internal_key, ms_founder, ms_recovery, ms_inheritance
        );
        let miniscript_policy = format!(
            "or({},or({},{}))",
            founder_thresh, recovery_branch, inheritance_branch
        );
        Ok(MultileafOutput {
            spend_info,
            founder_leaf,
            descriptor,
            miniscript_policy,
        })
    }
}

/// Back-compat shim: the previous helper returned just the
/// spend_info + founder leaf. Keep it wired to `build_multileaf` so
/// the PSBT builder path is unchanged.
pub fn build_multileaf_spend_info(
    policy: &DynastyPolicy,
) -> Result<(TaprootSpendInfo, bitcoin::ScriptBuf), PolicyError> {
    let out = build_multileaf(policy)?;
    Ok((out.spend_info, out.founder_leaf))
}

pub fn compile_dynasty_policy_tr_multileaf(
    policy: DynastyPolicy,
    network: Network,
) -> Result<CompiledVault, PolicyError> {
    let out = build_multileaf(&policy)?;
    let addr = Address::p2tr_tweaked(out.spend_info.output_key(), network);
    // Round-trip the descriptor through rust-miniscript's parser so
    // a malformed string (e.g. nested-brace mistake) fails here
    // instead of producing an unspendable address. Use
    // DescriptorPublicKey so the parser accepts the x-only internal
    // key format used by `tr(...)` descriptors.
    use miniscript::{Descriptor, DescriptorPublicKey};
    let _: Descriptor<DescriptorPublicKey> = Descriptor::from_str(&out.descriptor)
        .map_err(|e| PolicyError::Descriptor(format!("descriptor round-trip: {e:?}")))?;
    Ok(CompiledVault {
        miniscript_policy: out.miniscript_policy,
        descriptor: out.descriptor,
        address: addr,
        address_type: AddressType::TrMultileaf,
    })
}

// // -- Tranche vault (T-vesting)
// A child "distribution wallet" address that unlocks a single
// tranche at an absolute block height. Beneficiary can claim alone
// after the timelock; trustees retain an escape hatch any time so
// unclaimed funds aren't stranded.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranchePolicy {
    pub beneficiary_key: PublicKey,
    pub trustee_keys: Vec<PublicKey>,
    pub trustee_quorum: usize,
    /// Absolute block height at which the beneficiary path unlocks.
    pub unlock_block: u32,
}

pub fn compile_tranche_tr_multileaf(
    policy: TranchePolicy,
    network: Network,
) -> Result<CompiledVault, PolicyError> {
    if policy.trustee_quorum == 0 || policy.trustee_quorum > policy.trustee_keys.len() {
        return Err(PolicyError::InvalidQuorum);
    }

    let secp = Secp256k1::verification_only();

    let nums_bytes = hex::decode(NUMS_HEX)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS decode: {e}")))?;
    let internal_key = XOnlyPublicKey::from_slice(&nums_bytes)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS xonly: {e}")))?;

    let trustees: Vec<String> = policy
        .trustee_keys
        .iter()
        .map(|k| format!("pk({k})"))
        .collect();
    let trustee_thresh = format!("thresh({},{})", policy.trustee_quorum, trustees.join(","));
    let beneficiary_branch = format!(
        "and(after({}),pk({}))",
        policy.unlock_block, policy.beneficiary_key,
    );

    let compile_leaf = |s: &str| -> Result<Miniscript<PublicKey, miniscript::Tap>, PolicyError> {
        s.parse::<Concrete<PublicKey>>()
            .map_err(|e| PolicyError::Miniscript(format!("parse {s}: {e:?}")))?
            .compile()
            .map_err(|e| PolicyError::Miniscript(format!("compile {s}: {e:?}")))
    };

    let ms_beneficiary = compile_leaf(&beneficiary_branch)?;
    let ms_trustees = compile_leaf(&trustee_thresh)?;

    let builder = TaprootBuilder::new()
        .add_leaf(1, ms_beneficiary.encode())
        .map_err(|e| PolicyError::Descriptor(format!("leaf beneficiary: {e:?}")))?
        .add_leaf(1, ms_trustees.encode())
        .map_err(|e| PolicyError::Descriptor(format!("leaf trustees: {e:?}")))?;

    let spend_info = builder
        .finalize(&secp, internal_key)
        .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;

    let addr = Address::p2tr_tweaked(spend_info.output_key(), network);
    let descriptor = format!("tr({},{{{},{}}})", internal_key, ms_beneficiary, ms_trustees);
    let miniscript_policy = format!("or({},{})", beneficiary_branch, trustee_thresh);

    Ok(CompiledVault {
        miniscript_policy,
        descriptor,
        address: addr,
        address_type: AddressType::TrMultileaf,
    })
}

// // -- Dynasty Bloc vault (decaying-multisig family tree)
// A richer family shape than the founders/heirs vault. Five+ spend
// paths, each its own Taproot leaf (tr_multileaf), so a key may
// appear in several leaves without tripping DuplicatePubKeys:
//
//   Path A   parents together (n-of-n parents)             immediate
//   Path B   one parent + every kid (q-of-p AND n-of-n)    immediate
//   Path C   one parent alone                  after parent_solo_after
//   Path D+  kids alone, DECAYING threshold,   after kids_decay_start
//            starting at kids_decay_start_quorum and dropping by one
//            every kids_decay_step_blocks down to kids_decay_floor.
//
// Heights here are ABSOLUTE CLTV block heights (same convention as
// DynastyPolicy): callers bake tip + relative-offset before calling.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DynastyBlocPolicy {
    pub parent_keys: Vec<PublicKey>,
    /// Parents required in the parents-together immediate path (A).
    /// Typically all parents (e.g. 2-of-2).
    pub parents_together_quorum: usize,
    /// Parents required alongside the kids in the parent-plus-kids
    /// immediate path (B). Typically 1 (one parent).
    pub coparent_quorum: usize,
    pub kid_keys: Vec<PublicKey>,
    /// Kids required in path B. Typically all kids (n-of-n).
    pub kids_with_parent_quorum: usize,
    /// Absolute height after which a reduced parent quorum can spend
    /// alone (path C).
    pub parent_solo_after: u32,
    pub parent_solo_quorum: usize,
    /// Absolute height at which the kids-alone decay ladder begins.
    pub kids_decay_start_after: u32,
    /// Blocks between successive decay rungs.
    pub kids_decay_step_blocks: u32,
    /// Kid quorum at the first (highest) rung -- typically n-of-n.
    pub kids_decay_start_quorum: usize,
    /// Kid quorum at the last (lowest) rung -- the ladder stops here
    /// (>= 1, <= start).
    pub kids_decay_floor_quorum: usize,
}

fn verify_bloc(p: &DynastyBlocPolicy) -> Result<(), PolicyError> {
    let np = p.parent_keys.len();
    let nk = p.kid_keys.len();
    if np == 0 {
        return Err(PolicyError::InvalidBloc("at least one parent key required".into()));
    }
    if nk == 0 {
        return Err(PolicyError::InvalidBloc("at least one kid key required".into()));
    }
    let q_ok = |q: usize, n: usize| q >= 1 && q <= n;
    if !q_ok(p.parents_together_quorum, np) {
        return Err(PolicyError::InvalidBloc(format!(
            "parents_together_quorum {} must be 1..={np}",
            p.parents_together_quorum
        )));
    }
    if !q_ok(p.coparent_quorum, np) {
        return Err(PolicyError::InvalidBloc(format!(
            "coparent_quorum {} must be 1..={np}",
            p.coparent_quorum
        )));
    }
    if !q_ok(p.parent_solo_quorum, np) {
        return Err(PolicyError::InvalidBloc(format!(
            "parent_solo_quorum {} must be 1..={np}",
            p.parent_solo_quorum
        )));
    }
    if !q_ok(p.kids_with_parent_quorum, nk) {
        return Err(PolicyError::InvalidBloc(format!(
            "kids_with_parent_quorum {} must be 1..={nk}",
            p.kids_with_parent_quorum
        )));
    }
    if !q_ok(p.kids_decay_start_quorum, nk) {
        return Err(PolicyError::InvalidBloc(format!(
            "kids_decay_start_quorum {} must be 1..={nk}",
            p.kids_decay_start_quorum
        )));
    }
    if !q_ok(p.kids_decay_floor_quorum, nk) {
        return Err(PolicyError::InvalidBloc(format!(
            "kids_decay_floor_quorum {} must be 1..={nk}",
            p.kids_decay_floor_quorum
        )));
    }
    if p.kids_decay_floor_quorum > p.kids_decay_start_quorum {
        return Err(PolicyError::InvalidBloc(
            "kids_decay_floor_quorum must be <= kids_decay_start_quorum".into(),
        ));
    }
    // A multi-rung ladder needs a positive step so each rung sits at a
    // distinct CLTV height; otherwise two leaves share a height and the
    // decay is meaningless (and the tree would carry duplicate scripts).
    if p.kids_decay_start_quorum > p.kids_decay_floor_quorum && p.kids_decay_step_blocks == 0 {
        return Err(PolicyError::InvalidBloc(
            "kids_decay_step_blocks must be > 0 for a multi-rung ladder".into(),
        ));
    }
    if p.parent_solo_after < MIN_RECOVERY_BLOCKS {
        return Err(PolicyError::RecoveryTooSoon);
    }
    if p.kids_decay_start_after <= p.parent_solo_after {
        return Err(PolicyError::InvalidBloc(
            "kids_decay_start_after must be > parent_solo_after".into(),
        ));
    }
    Ok(())
}

/// Right-leaning Taproot inner descriptor: `{L1,{L2,{...{Ln-1,Ln}}}}`.
/// Matches the depth schedule [1,2,..,n-1,n-1] used to add the leaves.
fn nest_leaves(leaves: &[String]) -> String {
    if leaves.len() == 1 {
        leaves[0].clone()
    } else {
        format!("{{{},{}}}", leaves[0], nest_leaves(&leaves[1..]))
    }
}

/// Human-readable `or(a,or(b,...))` of every spend branch (display only).
fn nest_or(branches: &[String]) -> String {
    if branches.len() == 1 {
        branches[0].clone()
    } else {
        format!("or({},{})", branches[0], nest_or(&branches[1..]))
    }
}

pub fn compile_dynasty_bloc_tr_multileaf(
    policy: DynastyBlocPolicy,
    network: Network,
) -> Result<CompiledVault, PolicyError> {
    verify_bloc(&policy)?;

    let secp = Secp256k1::verification_only();
    let nums_bytes = hex::decode(NUMS_HEX)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS decode: {e}")))?;
    let internal_key = XOnlyPublicKey::from_slice(&nums_bytes)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS xonly: {e}")))?;

    let parents: Vec<String> = policy.parent_keys.iter().map(|k| format!("pk({k})")).collect();
    let kids: Vec<String> = policy.kid_keys.iter().map(|k| format!("pk({k})")).collect();
    let parents_join = parents.join(",");
    let kids_join = kids.join(",");

    // Path A: parents together.
    let path_a = format!("thresh({},{})", policy.parents_together_quorum, parents_join);
    // Path B: one parent + every kid.
    let path_b = format!(
        "and(thresh({},{}),thresh({},{}))",
        policy.coparent_quorum, parents_join, policy.kids_with_parent_quorum, kids_join,
    );
    // Path C: a reduced parent quorum alone, after the first timelock.
    let path_c = format!(
        "and(after({}),thresh({},{}))",
        policy.parent_solo_after, policy.parent_solo_quorum, parents_join,
    );

    let mut branch_strs: Vec<String> = vec![path_a, path_b, path_c];

    // Path D+: the decaying kid ladder. Highest quorum at the earliest
    // height; each rung drops the quorum by one and pushes the height
    // out by one step.
    let mut q = policy.kids_decay_start_quorum;
    let mut rung: u32 = 0;
    loop {
        let height = policy
            .kids_decay_start_after
            .checked_add(
                rung.checked_mul(policy.kids_decay_step_blocks)
                    .ok_or_else(|| PolicyError::InvalidBloc("decay height overflow".into()))?,
            )
            .ok_or_else(|| PolicyError::InvalidBloc("decay height overflow".into()))?;
        branch_strs.push(format!("and(after({}),thresh({},{}))", height, q, kids_join));
        if q == policy.kids_decay_floor_quorum {
            break;
        }
        q -= 1;
        rung += 1;
    }

    let compile_leaf =
        |s: &str| -> Result<Miniscript<PublicKey, miniscript::Tap>, PolicyError> {
            s.parse::<Concrete<PublicKey>>()
                .map_err(|e| PolicyError::Miniscript(format!("parse {s}: {e:?}")))?
                .compile()
                .map_err(|e| PolicyError::Miniscript(format!("compile {s}: {e:?}")))
        };

    let leaves: Vec<Miniscript<PublicKey, miniscript::Tap>> =
        branch_strs.iter().map(|s| compile_leaf(s)).collect::<Result<_, _>>()?;

    let n = leaves.len();
    if n < 2 {
        return Err(PolicyError::InvalidBloc("need at least two leaves".into()));
    }

    // Right-leaning tree: leaf i at depth i+1, last leaf shares the
    // second-to-last's depth (n-1). Proven shape -- the same schedule
    // the founders/heirs/protector tree uses for 3 and 4 leaves.
    let mut builder = TaprootBuilder::new();
    for (i, ms) in leaves.iter().enumerate() {
        let depth = if i + 1 < n { (i + 1) as u8 } else { (n - 1) as u8 };
        builder = builder
            .add_leaf(depth, ms.encode())
            .map_err(|e| PolicyError::Descriptor(format!("add_leaf {i} (depth {depth}): {e:?}")))?;
    }
    let spend_info = builder
        .finalize(&secp, internal_key)
        .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;
    let addr = Address::p2tr_tweaked(spend_info.output_key(), network);

    let leaf_descs: Vec<String> = leaves.iter().map(|ms| ms.to_string()).collect();
    let descriptor = format!("tr({},{})", internal_key, nest_leaves(&leaf_descs));

    // Round-trip through rust-miniscript so a malformed tree fails here
    // instead of producing an unspendable address downstream.
    use miniscript::{Descriptor, DescriptorPublicKey};
    let _: Descriptor<DescriptorPublicKey> = Descriptor::from_str(&descriptor)
        .map_err(|e| PolicyError::Descriptor(format!("descriptor round-trip: {e:?}")))?;

    Ok(CompiledVault {
        miniscript_policy: nest_or(&branch_strs),
        descriptor,
        address: addr,
        address_type: AddressType::TrMultileaf,
    })
}

fn build_policy_string(policy: &DynastyPolicy) -> String {
    let founders: Vec<String> = policy
        .founder_keys
        .iter()
        .map(|k| format!("pk({k})"))
        .collect();

    let trustee_thresh = format!("thresh({},{})", policy.founder_quorum, founders.join(","));
    let founder_thresh = if policy.has_consent() {
        let consenters: Vec<String> = policy
            .consent_keys
            .iter()
            .map(|k| format!("pk({k})"))
            .collect();
        let consent_thresh = format!(
            "thresh({},{})",
            policy.consent_quorum.unwrap(),
            consenters.join(","),
        );
        format!("and({},{})", trustee_thresh, consent_thresh)
    } else {
        trustee_thresh
    };

    if policy.is_plain() {
        return founder_thresh;
    }

    let heirs: Vec<String> = policy
        .heir_keys
        .iter()
        .map(|k| format!("pk({k})"))
        .collect();

    // Recovery branch uses its own quorum when the trust asked for
    // one; otherwise falls back to founder_quorum (legacy rows).
    let recovery_quorum = policy.recovery_quorum.unwrap_or(policy.founder_quorum);
    let recovery_thresh = format!("thresh({},{})", recovery_quorum, founders.join(","));
    let recovery_branch = format!("and(after({}),{})", policy.recovery_after, recovery_thresh);
    let inheritance_branch = format!(
        "and(after({}),thresh({},{}))",
        policy.inheritance_after,
        policy.heir_quorum,
        heirs.join(",")
    );

    let base = format!(
        "or({},or({},{}))",
        founder_thresh, recovery_branch, inheritance_branch
    );

    if policy.has_protector() {
        let protectors: Vec<String> = policy
            .protector_keys
            .iter()
            .map(|k| format!("pk({k})"))
            .collect();
        let protector_branch = format!(
            "and(after({}),thresh({},{}))",
            policy.protector_after.unwrap(),
            policy.protector_quorum.unwrap(),
            protectors.join(",")
        );
        format!("or({},{})", base, protector_branch)
    } else {
        base
    }
}

fn verify(policy: &DynastyPolicy) -> Result<(), PolicyError> {
    if policy.founder_quorum == 0 || policy.founder_quorum > policy.founder_keys.len() {
        return Err(PolicyError::InvalidQuorum);
    }

    if let Some(rq) = policy.recovery_quorum {
        if rq == 0 || rq > policy.founder_keys.len() {
            return Err(PolicyError::InvalidQuorum);
        }
    }

    if policy.has_protector() {
        let pq = policy.protector_quorum.unwrap();
        if pq == 0 || pq > policy.protector_keys.len() {
            return Err(PolicyError::InvalidQuorum);
        }
    }

    if policy.has_consent() {
        let cq = policy.consent_quorum.unwrap();
        if cq == 0 || cq > policy.consent_keys.len() {
            return Err(PolicyError::InvalidQuorum);
        }
    }

    if policy.is_plain() {
        // Plain mode: only the founder threshold matters.
        return Ok(());
    }

    if policy.heir_quorum == 0 || policy.heir_quorum > policy.heir_keys.len() {
        return Err(PolicyError::InvalidQuorum);
    }

    if policy.recovery_after < MIN_RECOVERY_BLOCKS {
        return Err(PolicyError::RecoveryTooSoon);
    }

    if policy.inheritance_after <= policy.recovery_after {
        return Err(PolicyError::InheritanceTooSoon);
    }

    Ok(())
}

#[cfg(test)]
mod bloc_tests {
    use super::*;

    // Two parents, four kids -- the canonical family-bloc shape.
    fn sample(start_q: usize, floor_q: usize) -> DynastyBlocPolicy {
        let parents = vec![
            PublicKey::from_str(
                "02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97",
            )
            .unwrap(),
            PublicKey::from_str(
                "02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569",
            )
            .unwrap(),
        ];
        let kids = vec![
            PublicKey::from_str(
                "03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34",
            )
            .unwrap(),
            PublicKey::from_str(
                "025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc",
            )
            .unwrap(),
            PublicKey::from_str(
                "03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe",
            )
            .unwrap(),
            PublicKey::from_str(
                "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
            )
            .unwrap(),
        ];
        DynastyBlocPolicy {
            parent_keys: parents,
            parents_together_quorum: 2,
            coparent_quorum: 1,
            kid_keys: kids,
            kids_with_parent_quorum: 4,
            parent_solo_after: 100_000,
            parent_solo_quorum: 1,
            kids_decay_start_after: 200_000,
            kids_decay_step_blocks: 52_560,
            kids_decay_start_quorum: start_q,
            kids_decay_floor_quorum: floor_q,
        }
    }

    #[test]
    fn compiles_full_decay_ladder() {
        let v = compile_dynasty_bloc_tr_multileaf(sample(4, 1), Network::Testnet).unwrap();
        // Testnet Taproot addresses are bech32m starting "tb1p".
        assert!(v.address.to_string().starts_with("tb1p"), "addr: {}", v.address);
        assert_eq!(v.address_type, AddressType::TrMultileaf);
        // Branches with a timelock: path C + four decay rungs (4,3,2,1) = 5.
        assert_eq!(v.miniscript_policy.matches("after(").count(), 5);
        // Total leaves = A + B + C + 4 rungs = 7. The descriptor's inner
        // tree therefore opens with six "{" (n-1 internal nodes).
        assert_eq!(v.descriptor.matches('{').count(), 6);
    }

    #[test]
    fn decay_heights_increase_per_rung() {
        let v = compile_dynasty_bloc_tr_multileaf(sample(4, 1), Network::Testnet).unwrap();
        // The four rungs sit at start + k*step for k = 0..3.
        for k in 0..4u32 {
            let h = 200_000 + k * 52_560;
            assert!(
                v.miniscript_policy.contains(&format!("after({h})")),
                "missing rung height {h} in {}",
                v.miniscript_policy
            );
        }
    }

    #[test]
    fn single_rung_ladder_needs_no_step() {
        // start == floor -> one rung, step may be zero.
        let mut p = sample(2, 2);
        p.kids_decay_step_blocks = 0;
        let v = compile_dynasty_bloc_tr_multileaf(p, Network::Testnet).unwrap();
        // path C + single rung = 2 timelocked branches.
        assert_eq!(v.miniscript_policy.matches("after(").count(), 2);
    }

    #[test]
    fn rejects_floor_above_start() {
        let err = compile_dynasty_bloc_tr_multileaf(sample(2, 4), Network::Testnet).unwrap_err();
        assert!(matches!(err, PolicyError::InvalidBloc(_)));
    }

    #[test]
    fn rejects_kid_decay_before_parent_solo() {
        let mut p = sample(4, 1);
        p.kids_decay_start_after = p.parent_solo_after; // not strictly greater
        let err = compile_dynasty_bloc_tr_multileaf(p, Network::Testnet).unwrap_err();
        assert!(matches!(err, PolicyError::InvalidBloc(_)));
    }

    #[test]
    fn rejects_multi_rung_zero_step() {
        let mut p = sample(4, 1);
        p.kids_decay_step_blocks = 0;
        let err = compile_dynasty_bloc_tr_multileaf(p, Network::Testnet).unwrap_err();
        assert!(matches!(err, PolicyError::InvalidBloc(_)));
    }

    #[test]
    fn rejects_too_soon_parent_solo() {
        let mut p = sample(4, 1);
        p.parent_solo_after = 10; // below MIN_RECOVERY_BLOCKS
        let err = compile_dynasty_bloc_tr_multileaf(p, Network::Testnet).unwrap_err();
        assert!(matches!(err, PolicyError::RecoveryTooSoon));
    }
}
