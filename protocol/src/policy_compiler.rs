use bitcoin::{Address, Network, PublicKey};
use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use bitcoin::taproot::TaprootBuilder;
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
}

impl DynastyPolicy {
    /// Plain mode: no heirs, no timelocks. The compiled vault is a
    /// straight M-of-N multisig (or single-sig) with no recovery or
    /// inheritance paths. Intended for users who want a normal
    /// Bitcoin wallet or co-signer setup, without the estate-planning
    /// machinery.
    pub fn is_plain(&self) -> bool {
        self.heir_keys.is_empty() && self.recovery_after == 0 && self.inheritance_after == 0
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

pub fn compile_dynasty_policy_tr_multileaf(
    policy: DynastyPolicy,
    network: Network,
) -> Result<CompiledVault, PolicyError> {
    verify(&policy)?;

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

    let founder_thresh = format!("thresh({},{})", policy.founder_quorum, founders.join(","));

    let compile_leaf =
        |policy_str: &str| -> Result<Miniscript<PublicKey, miniscript::Tap>, PolicyError> {
            let concrete = policy_str
                .parse::<Concrete<PublicKey>>()
                .map_err(|e| PolicyError::Miniscript(format!("parse {policy_str}: {e:?}")))?;

            concrete
                .compile()
                .map_err(|e| PolicyError::Miniscript(format!("compile {policy_str}: {e:?}")))
        };

    // Plain mode: single leaf, no recovery or inheritance branch.
    if policy.is_plain() {
        let ms_founder = compile_leaf(&founder_thresh)?;

        let builder = TaprootBuilder::new()
            .add_leaf(0, ms_founder.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?;

        let spend_info = builder
            .finalize(&secp, internal_key)
            .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;

        let addr = Address::p2tr_tweaked(spend_info.output_key(), network);
        let descriptor = format!("tr({},{{{}}})", internal_key, ms_founder);

        return Ok(CompiledVault {
            miniscript_policy: founder_thresh,
            descriptor,
            address: addr,
            address_type: AddressType::TrMultileaf,
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
        heirs.join(",")
    );

    let ms_founder = compile_leaf(&founder_thresh)?;
    let ms_recovery = compile_leaf(&recovery_branch)?;
    let ms_inheritance = compile_leaf(&inheritance_branch)?;

    let builder = TaprootBuilder::new()
        .add_leaf(1, ms_founder.encode())
        .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?
        .add_leaf(2, ms_recovery.encode())
        .map_err(|e| PolicyError::Descriptor(format!("leaf recovery: {e:?}")))?
        .add_leaf(2, ms_inheritance.encode())
        .map_err(|e| PolicyError::Descriptor(format!("leaf inheritance: {e:?}")))?;

    let spend_info = builder
        .finalize(&secp, internal_key)
        .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;

    let addr = Address::p2tr_tweaked(spend_info.output_key(), network);

    let descriptor = format!(
        "tr({},{{{},{{{},{}}}}})",
        internal_key, ms_founder, ms_recovery, ms_inheritance
    );

    let miniscript_policy = format!(
        "or({},or({},{}))",
        founder_thresh, recovery_branch, inheritance_branch
    );

    Ok(CompiledVault {
        miniscript_policy,
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

    let founder_thresh = format!("thresh({},{})", policy.founder_quorum, founders.join(","));

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

    format!(
        "or({},or({},{}))",
        founder_thresh, recovery_branch, inheritance_branch
    )
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
