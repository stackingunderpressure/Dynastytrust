use bitcoin::{Address, Network, PublicKey};
use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use bitcoin::taproot::{TapTree, TaprootBuilder, TaprootSpendInfo};
use miniscript::policy::Concrete;
use miniscript::{Descriptor, Miniscript};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use thiserror::Error;

pub const MIN_RECOVERY_BLOCKS: u32 = 26_000;

/// Cap on any relative timelock (older()/BIP68 CSV) leaf, kept
/// comfortably under BIP68's 65,535-block protocol ceiling. CLAUDE.md's
/// "absolute timelocks, not relative" rule is scoped to leaves holding a
/// fixed deadline that must NOT reset regardless of activity (recovery,
/// inheritance) -- BIP68's cap really is too short for those.
/// This is the documented, deliberate exception for a different job: a
/// short, self-refreshing leaf where resetting the clock on every spend
/// is the entire point (e.g. "3-of-3 normally, drops to 2-of-3 if the
/// coin sits untouched for 12 months"). See LeafPolicy/Unlock below.
pub const MAX_RELATIVE_BLOCKS: u32 = 60_000;

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

    /// Optional beneficiary-consent gate on Path 1 (founders-now).
    /// When set, every "normal" spend needs both the trustee quorum
    /// AND a beneficiary quorum to sign. Recovery / inheritance
    /// paths are unaffected -- those exist precisely to
    /// rescue funds when a beneficiary won't or can't cosign.
    /// A "protector" role, if one is wanted, is just another key added
    /// directly to founder_keys -- no separate field: an independent
    /// party who should count as a trustee-equivalent signer needs no
    /// mechanism beyond the one founder_keys already provides
    /// (2026-08-19, operator: "I only like it as an added key to a
    /// quorum... just like trustee... prolly not use much so don't need
    /// it" -- retiring the standalone protector leaf this repo carried
    /// briefly, which gave an independent party its OWN timelocked
    /// spending path rather than folding them into the existing one).
    #[serde(default)]
    pub consent_keys: Vec<PublicKey>,
    #[serde(default)]
    pub consent_quorum: Option<usize>,

    /// Optional backup branch (2026-08-08, "anytime, harder") -- an
    /// always-available fallback using a SEPARATE, harder-to-reach key
    /// set the owner controls directly (e.g. keys physically split
    /// across several locations), at a quorum typically stricter than
    /// founder_quorum. Occupies the SAME tree slot the timelocked
    /// recovery branch would (see build_multileaf) but carries NO
    /// timelock -- the friction here is deliberately physical effort
    /// (retrieving enough of the backup keys) rather than a clock. This
    /// is the answer to "my circle can vouch for me in minutes, or I can
    /// dig up the keys myself if I have to": the founders-now leaf still
    /// needs the circle's phone-verification ritual to feel safe signing;
    /// this leaf needs nobody's cooperation at all, by design. Mutually
    /// exclusive with the timelocked recovery branch above -- setting
    /// both is a config error (BackupConflictsWithRecovery), since only
    /// one can occupy the slot and silently dropping the other would be
    /// a trap for whoever configured it.
    #[serde(default)]
    pub backup_keys: Vec<PublicKey>,
    #[serde(default)]
    pub backup_quorum: Option<usize>,

    /// Optional second inheritance branch (2026-08-11) -- an
    /// INDEPENDENT heir cohort with its own key set, quorum, and
    /// absolute timelock, distinct from the primary `heir_keys` /
    /// `heir_quorum` / `inheritance_after` leaf above. Lets an
    /// operator name two separate heir groups under one vault with
    /// different timing (e.g. a spouse who unlocks sooner on a
    /// shorter horizon, extended family later on a longer one)
    /// rather than folding everyone into a single heir cohort.
    /// Deliberately UNORDERED relative to `inheritance_after` --
    /// "varied timelock" means either shorter or longer is a valid
    /// design, so no relative constraint is enforced between the two.
    /// This is an ADDITIONAL heir path, not a replacement, so it
    /// requires `wants_inheritance()` (the primary leaf must exist).
    /// All three fields must be set together.
    #[serde(default)]
    pub second_heir_keys: Vec<PublicKey>,
    #[serde(default)]
    pub second_heir_quorum: Option<usize>,
    #[serde(default)]
    pub second_inheritance_after: Option<u32>,
}

impl DynastyPolicy {
    pub fn is_plain(&self) -> bool {
        self.heir_keys.is_empty()
            && self.recovery_after == 0
            && self.inheritance_after == 0
            && self.backup_keys.is_empty()
            && self.second_heir_keys.is_empty()
    }

    /// True when the tree has a distinct TIMELOCKED recovery leaf (Path
    /// 2 -- founders, after a delay). False for a "Gift Locker"-style
    /// two-leaf vault: founders-now, OR a single beneficiary key that
    /// unlocks after a specified time, with no separate founders-after-
    /// delay path in between. `recovery_after == 0` is the existing
    /// sentinel `is_plain()` already uses for "no recovery" -- reused
    /// here rather than adding a new field, since a real recovery delay
    /// must clear `MIN_RECOVERY_BLOCKS` and could never legitimately be
    /// zero. See `has_backup()` for the untimelocked alternative that
    /// occupies this same tree slot.
    pub fn has_recovery(&self) -> bool {
        self.recovery_after > 0
    }

    pub fn has_consent(&self) -> bool {
        !self.consent_keys.is_empty() && self.consent_quorum.is_some()
    }

    /// True when the tree has an untimelocked backup leaf -- the
    /// "anytime, harder" alternative to the timelocked recovery branch.
    /// See the field doc comment above for the full rationale.
    pub fn has_backup(&self) -> bool {
        !self.backup_keys.is_empty() && self.backup_quorum.is_some()
    }

    /// True when SOME leaf occupies the middle tree slot between
    /// founders-now and inheritance -- either the timelocked recovery
    /// branch or the untimelocked backup branch. Determines whether the
    /// tree needs the 2-leaf "Gift Locker" shape or the fuller 3-4 leaf
    /// shape; see build_multileaf.
    pub fn has_middle_leaf(&self) -> bool {
        self.has_recovery() || self.has_backup()
    }

    /// False when there is no third-leaf inheritance path at all --
    /// heir_keys empty. A vault can be founders-now + backup ONLY (the
    /// Tapit Circle shape: a phone-verified circle for the easy case, an
    /// owner-only harder key set for "I need to move it myself right
    /// now," and no separate estate-planning leaf) without ever
    /// configuring heirs. `inheritance_after` is irrelevant/ignored when
    /// this is false, same as `recovery_after`/`recovery_quorum` are
    /// ignored when `has_backup()`.
    pub fn wants_inheritance(&self) -> bool {
        !self.heir_keys.is_empty()
    }

    /// True when the tree has the optional second, independent
    /// inheritance leaf -- a distinct heir cohort with its own key
    /// set, quorum, and absolute timelock alongside the primary
    /// inheritance leaf. See the field doc comment above.
    pub fn has_second_inheritance(&self) -> bool {
        !self.second_heir_keys.is_empty()
            && self.second_heir_quorum.is_some()
            && self.second_inheritance_after.is_some()
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
    #[error("inheritance_after must be > 0 when heir_keys is set")]
    InheritanceRequiresDelay,
    #[error("recovery_after and backup_keys are mutually exclusive -- both occupy the same tree slot; pick one")]
    BackupConflictsWithRecovery,
    #[error("a second inheritance branch requires the primary inheritance leaf (heir_keys set); it is an additional heir path, not a replacement")]
    SecondInheritanceRequiresInheritance,
    #[error("second_inheritance_after must be > 0 when second_heir_keys is set")]
    SecondInheritanceRequiresDelay,
    #[error("miniscript policy error: {0}")]
    Miniscript(String),
    #[error("descriptor error: {0}")]
    Descriptor(String),
    #[error("invalid dynasty bloc policy: {0}")]
    InvalidBloc(String),
    #[error("at least one leaf is required")]
    EmptyLeafPolicy,
    #[error("a vault needs at least one immediate (unlock-from-funding) leaf")]
    NoImmediateLeaf,
    #[error("a decaying leaf must have a starting timelock, not Immediate")]
    DecayRequiresTimelock,
    #[error("relative timelock ({0} blocks) exceeds the {MAX_RELATIVE_BLOCKS}-block cap -- use an absolute after() leaf for a long deadline")]
    RelativeTimelockTooLong(u32),
    #[error("a relative-timelock (older()) leaf must not be the vault's only non-immediate fallback -- add an absolute after() leaf too")]
    RelativeTimelockNeedsAbsoluteFallback,
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
///
/// Every leaf the tree can contain is exposed here (2026-08-06 fix) --
/// previously only `founder_leaf` was, which meant the PSBT builder could
/// only ever attach the founders-now leaf's control block, regardless of
/// which path (`recovery` / `inheritance`) the caller
/// actually intended to spend via. That silently mismatched `tap_scripts`
/// against `tx.lock_time` for every non-founders spend: an heir signing
/// an inheritance-path transaction would find their key absent from the
/// (wrong) attached leaf and the signer would report "not a signer for
/// this input" -- masking a server-side leaf-selection bug as a missing
/// key.
#[derive(Debug)]
pub struct MultileafOutput {
    pub spend_info: TaprootSpendInfo,
    /// Same tree as `spend_info`, in the `TapTree` shape a PSBT output's
    /// PSBT_OUT_TAP_TREE field needs (2026-08-11 fix). Without this on a
    /// change output, a signer verifying a multi-leaf change output has
    /// no tree to reconstruct/verify against and correctly refuses to
    /// call it change -- see attach_tap_change_output_metadata's call
    /// site in the compiler for the full account of the bug this closed
    /// ("spending the whole UTXO" turned out to be real change that no
    /// signer could recognize as change). Captured from the SAME builder
    /// that produces spend_info, before it's consumed by finalize(), so
    /// the two can never drift apart the way two separate constructions
    /// could.
    pub tap_tree: TapTree,
    pub founder_leaf: bitcoin::ScriptBuf,
    /// Present when `policy.has_middle_leaf()` -- the timelocked
    /// recovery branch OR the untimelocked backup branch, whichever the
    /// policy set (mutually exclusive). None both for a plain
    /// (founders-only) policy AND for a "Gift Locker"-shaped one
    /// (founders-now OR a single timelocked beneficiary path, no
    /// separate founders-after-a-delay/backup leaf). Callers that need
    /// to know WHICH of the two this is should check
    /// `policy.has_backup()` themselves -- this field alone can't tell.
    pub recovery_leaf: Option<bitcoin::ScriptBuf>,
    /// Present when `policy.wants_inheritance()` (heir_keys non-empty).
    /// A Gift Locker-shaped policy still has this one even with no
    /// middle leaf; a "founders + backup only" policy (Tapit Circle,
    /// `has_backup() && !wants_inheritance()`) has NEITHER a middle leaf
    /// gap nor this one -- exactly two leaves total, founders + backup.
    pub inheritance_leaf: Option<bitcoin::ScriptBuf>,
    /// Present only when `policy.has_second_inheritance()` -- the
    /// independent second heir cohort's leaf.
    pub second_inheritance_leaf: Option<bitcoin::ScriptBuf>,
    pub descriptor: String,
    pub miniscript_policy: String,
    /// (leaf id, script) for every leaf in the tree, generic lookup
    /// alongside the named fields above. Empty for every vault built via
    /// the named-branch `build_multileaf` path below (nothing there needs
    /// it -- PSBT building for those vaults still matches on the named
    /// fields). Populated by `build_leaf_multileaf` for new, leaf-list-
    /// shaped vaults, where it's the ONLY way to look up a leaf's script,
    /// since those vaults have no fixed named roles.
    pub leaf_scripts: Vec<(String, bitcoin::ScriptBuf)>,
    /// (leaf id, unlock) for every leaf in leaf_scripts -- the PSBT
    /// builder needs this to know whether the selected leaf wants
    /// tx.lock_time set (After) or the spending input's nSequence set
    /// (OlderThan), since CLTV and CSV are enforced through two
    /// different transaction fields. Empty for every vault built via the
    /// named-branch `build_multileaf` path (that caller already knows
    /// which absolute-height field to use for each named path).
    pub leaf_unlocks: Vec<(String, Unlock)>,
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
        let tap_tree = TapTree::try_from(builder.clone())
            .map_err(|e| PolicyError::Descriptor(format!("tap_tree: {e:?}")))?;
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
            tap_tree,
            founder_leaf,
            recovery_leaf: None,
            inheritance_leaf: None,
            second_inheritance_leaf: None,
            descriptor,
            miniscript_policy: founder_thresh,
            leaf_scripts: Vec::new(),
            leaf_unlocks: Vec::new(),
        });
    }

    if !policy.wants_inheritance() && policy.has_backup() {
        // "Founders + backup only" -- the Tapit Circle shape. Exactly
        // two leaves, no inheritance leg at all: a phone-verified circle
        // for the easy case, the owner's own harder key set for
        // "I need to move it myself right now."
        let backups: Vec<String> = policy
            .backup_keys
            .iter()
            .map(|k| format!("pk({k})"))
            .collect();
        let backup_branch = format!("thresh({},{})", policy.backup_quorum.unwrap(), backups.join(","));
        let ms_backup = compile_leaf(&backup_branch)?;

        let builder = TaprootBuilder::new()
            .add_leaf(1, founder_leaf.clone())
            .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?
            .add_leaf(1, ms_backup.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf backup: {e:?}")))?;
        let tap_tree = TapTree::try_from(builder.clone())
            .map_err(|e| PolicyError::Descriptor(format!("tap_tree: {e:?}")))?;
        let spend_info = builder
            .finalize(&secp, internal_key)
            .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;
        let descriptor = format!("tr({},{{{},{}}})", internal_key, ms_founder, ms_backup);
        let miniscript_policy = format!("or({},{})", founder_thresh, backup_branch);
        return Ok(MultileafOutput {
            spend_info,
            tap_tree,
            founder_leaf,
            recovery_leaf: Some(ms_backup.encode()),
            inheritance_leaf: None,
            second_inheritance_leaf: None,
            descriptor,
            miniscript_policy,
            leaf_scripts: Vec::new(),
            leaf_unlocks: Vec::new(),
        });
    }

    let heirs: Vec<String> = policy
        .heir_keys
        .iter()
        .map(|k| format!("pk({k})"))
        .collect();
    let inheritance_branch = format!(
        "and(after({}),thresh({},{}))",
        policy.inheritance_after,
        policy.heir_quorum,
        heirs.join(","),
    );
    let ms_inheritance = compile_leaf(&inheritance_branch)?;

    // Second, independent inheritance leaf (optional) -- computed once
    // here since the Gift Locker branch and both middle-slot branches
    // below all need it when present.
    let second_inheritance: Option<(String, Miniscript<PublicKey, miniscript::Tap>)> =
        if policy.has_second_inheritance() {
            let second_heirs: Vec<String> = policy
                .second_heir_keys
                .iter()
                .map(|k| format!("pk({k})"))
                .collect();
            let second_inheritance_branch = format!(
                "and(after({}),thresh({},{}))",
                policy.second_inheritance_after.unwrap(),
                policy.second_heir_quorum.unwrap(),
                second_heirs.join(","),
            );
            let ms = compile_leaf(&second_inheritance_branch)?;
            Some((second_inheritance_branch, ms))
        } else {
            None
        };

    if !policy.has_middle_leaf() {
        // "Gift Locker" shape: founders-now OR a single beneficiary
        // path that unlocks after a specified time -- exactly two
        // leaves, no founders-after-a-delay (or backup) path in between.
        // When a second inheritance leaf is also configured, it takes the
        // third leaf slot alongside inheritance (same depth-2/depth-2
        // pairing the "standard 3-leaf" shape below uses for
        // recovery+inheritance, just applied to the two heir leaves
        // here instead).
        if let Some((second_inheritance_branch, ms_second_inheritance)) = &second_inheritance {
            let builder = TaprootBuilder::new()
                .add_leaf(1, founder_leaf.clone())
                .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?
                .add_leaf(2, ms_inheritance.encode())
                .map_err(|e| PolicyError::Descriptor(format!("leaf inheritance: {e:?}")))?
                .add_leaf(2, ms_second_inheritance.encode())
                .map_err(|e| PolicyError::Descriptor(format!("leaf second inheritance: {e:?}")))?;
            let tap_tree = TapTree::try_from(builder.clone())
                .map_err(|e| PolicyError::Descriptor(format!("tap_tree: {e:?}")))?;
            let spend_info = builder
                .finalize(&secp, internal_key)
                .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;
            let descriptor = format!(
                "tr({},{{{},{{{},{}}}}})",
                internal_key, ms_founder, ms_inheritance, ms_second_inheritance
            );
            let miniscript_policy = format!(
                "or({},or({},{}))",
                founder_thresh, inheritance_branch, second_inheritance_branch
            );
            return Ok(MultileafOutput {
                spend_info,
                tap_tree,
                founder_leaf,
                recovery_leaf: None,
                inheritance_leaf: Some(ms_inheritance.encode()),
                second_inheritance_leaf: Some(ms_second_inheritance.encode()),
                descriptor,
                miniscript_policy,
                leaf_scripts: Vec::new(),
                leaf_unlocks: Vec::new(),
            });
        }

        let builder = TaprootBuilder::new()
            .add_leaf(1, founder_leaf.clone())
            .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?
            .add_leaf(1, ms_inheritance.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf inheritance: {e:?}")))?;
        let tap_tree = TapTree::try_from(builder.clone())
            .map_err(|e| PolicyError::Descriptor(format!("tap_tree: {e:?}")))?;
        let spend_info = builder
            .finalize(&secp, internal_key)
            .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;
        let descriptor = format!(
            "tr({},{{{},{}}})",
            internal_key, ms_founder, ms_inheritance
        );
        let miniscript_policy = format!("or({},{})", founder_thresh, inheritance_branch);
        return Ok(MultileafOutput {
            spend_info,
            tap_tree,
            founder_leaf,
            recovery_leaf: None,
            inheritance_leaf: Some(ms_inheritance.encode()),
            second_inheritance_leaf: None,
            descriptor,
            miniscript_policy,
            leaf_scripts: Vec::new(),
            leaf_unlocks: Vec::new(),
        });
    }

    // Middle slot: the untimelocked backup branch (own key set, own
    // quorum, no after()) when configured, else the timelocked recovery
    // branch (founders' own keys, own quorum falling back to
    // founder_quorum) -- mutually exclusive, see has_backup's doc
    // comment and BackupConflictsWithRecovery.
    let recovery_branch = if policy.has_backup() {
        let backups: Vec<String> = policy
            .backup_keys
            .iter()
            .map(|k| format!("pk({k})"))
            .collect();
        format!("thresh({},{})", policy.backup_quorum.unwrap(), backups.join(","))
    } else {
        let recovery_quorum = policy.recovery_quorum.unwrap_or(policy.founder_quorum);
        let recovery_thresh = format!("thresh({},{})", recovery_quorum, founders.join(","));
        format!("and(after({}),{})", policy.recovery_after, recovery_thresh)
    };
    let ms_recovery = compile_leaf(&recovery_branch)?;

    if let Some((second_inheritance_branch, ms_second_inheritance)) = &second_inheritance {
        // 4-leaf tree: founder(d1) / recovery(d2) /
        // {inheritance, second_inheritance}(d3,d3).
        let builder = TaprootBuilder::new()
            .add_leaf(1, founder_leaf.clone())
            .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?
            .add_leaf(2, ms_recovery.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf recovery: {e:?}")))?
            .add_leaf(3, ms_inheritance.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf inheritance: {e:?}")))?
            .add_leaf(3, ms_second_inheritance.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf second inheritance: {e:?}")))?;
        let tap_tree = TapTree::try_from(builder.clone())
            .map_err(|e| PolicyError::Descriptor(format!("tap_tree: {e:?}")))?;
        let spend_info = builder
            .finalize(&secp, internal_key)
            .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;
        let descriptor = format!(
            "tr({},{{{},{{{},{{{},{}}}}}}})",
            internal_key, ms_founder, ms_recovery, ms_inheritance, ms_second_inheritance
        );
        let miniscript_policy = format!(
            "or({},or({},or({},{})))",
            founder_thresh, recovery_branch, inheritance_branch, second_inheritance_branch
        );
        Ok(MultileafOutput {
            spend_info,
            tap_tree,
            founder_leaf,
            recovery_leaf: Some(ms_recovery.encode()),
            inheritance_leaf: Some(ms_inheritance.encode()),
            second_inheritance_leaf: Some(ms_second_inheritance.encode()),
            descriptor,
            miniscript_policy,
            leaf_scripts: Vec::new(),
            leaf_unlocks: Vec::new(),
        })
    } else {
        let builder = TaprootBuilder::new()
            .add_leaf(1, founder_leaf.clone())
            .map_err(|e| PolicyError::Descriptor(format!("leaf founders: {e:?}")))?
            .add_leaf(2, ms_recovery.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf recovery: {e:?}")))?
            .add_leaf(2, ms_inheritance.encode())
            .map_err(|e| PolicyError::Descriptor(format!("leaf inheritance: {e:?}")))?;
        let tap_tree = TapTree::try_from(builder.clone())
            .map_err(|e| PolicyError::Descriptor(format!("tap_tree: {e:?}")))?;
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
            tap_tree,
            founder_leaf,
            recovery_leaf: Some(ms_recovery.encode()),
            inheritance_leaf: Some(ms_inheritance.encode()),
            second_inheritance_leaf: None,
            descriptor,
            miniscript_policy,
            leaf_scripts: Vec::new(),
            leaf_unlocks: Vec::new(),
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

/// Every leaf of a tranche's tree, exposed the same way
/// `MultileafOutput` exposes the main vault's leaves -- so a PSBT
/// builder can attach the control block matching whichever path
/// (`beneficiary` or `trustee`) the caller actually intends to
/// spend via, instead of only ever knowing the address.
pub struct TrancheOutput {
    pub spend_info: TaprootSpendInfo,
    pub internal_key: XOnlyPublicKey,
    pub beneficiary_leaf: bitcoin::ScriptBuf,
    pub trustee_leaf: bitcoin::ScriptBuf,
    pub descriptor: String,
    pub miniscript_policy: String,
    /// Same tree as `spend_info`, in the `TapTree` shape a PSBT output's
    /// PSBT_OUT_TAP_TREE field needs -- see attach_tap_change_output_metadata
    /// in psbt_builder.rs. Must come from the same builder spend_info did,
    /// captured before .finalize() consumes it, so the two can never drift.
    pub tap_tree: TapTree,
}

/// Sole source of truth for a tranche's tree construction. Used by
/// both `compile_tranche_tr_multileaf` (for address + descriptor)
/// and by the PSBT builder (for control blocks).
pub fn build_tranche(policy: &TranchePolicy) -> Result<TrancheOutput, PolicyError> {
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

    let tap_tree = TapTree::try_from(builder.clone())
        .map_err(|e| PolicyError::Descriptor(format!("tap_tree: {e:?}")))?;

    let spend_info = builder
        .finalize(&secp, internal_key)
        .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;

    let descriptor = format!("tr({},{{{},{}}})", internal_key, ms_beneficiary, ms_trustees);
    let miniscript_policy = format!("or({},{})", beneficiary_branch, trustee_thresh);

    Ok(TrancheOutput {
        spend_info,
        internal_key,
        beneficiary_leaf: ms_beneficiary.encode(),
        trustee_leaf: ms_trustees.encode(),
        descriptor,
        miniscript_policy,
        tap_tree,
    })
}

pub fn compile_tranche_tr_multileaf(
    policy: TranchePolicy,
    network: Network,
) -> Result<CompiledVault, PolicyError> {
    let out = build_tranche(&policy)?;
    let addr = Address::p2tr_tweaked(out.spend_info.output_key(), network);
    Ok(CompiledVault {
        miniscript_policy: out.miniscript_policy,
        descriptor: out.descriptor,
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
    let out = build_bloc_multileaf(&policy)?;
    let addr = Address::p2tr_tweaked(out.spend_info.output_key(), network);
    Ok(CompiledVault {
        miniscript_policy: out.miniscript_policy,
        descriptor: out.descriptor,
        address: addr,
        address_type: AddressType::TrMultileaf,
    })
}

/// Stable identifiers for each Bloc spend path. The PSBT builder uses
/// `path` (+ `quorum` to disambiguate decay rungs) to pick the leaf to
/// attach and the `locktime` to stamp on the transaction.
#[derive(Debug, Clone)]
pub struct BlocLeaf {
    pub path: String,
    pub quorum: usize,
    pub locktime: u32,
    pub leaf_script: bitcoin::ScriptBuf,
}

pub const BLOC_PATH_PARENTS_NOW: &str = "parents_now";
pub const BLOC_PATH_COPARENT_KIDS: &str = "coparent_kids";
pub const BLOC_PATH_PARENT_SOLO: &str = "parent_solo";
pub const BLOC_PATH_KIDS_DECAY: &str = "kids_decay";

/// Everything downstream consumers need from a Bloc compile. As with
/// `build_multileaf`, this is the SOLE source of truth for the Bloc
/// Taproot tree: the address-compile and the PSBT builder both derive
/// the spend_info from here, so the merkle root they prove against can
/// never drift (drift = "Control block verification failed").
pub struct BlocMultileafOutput {
    pub spend_info: TaprootSpendInfo,
    /// NUMS internal key -- spending is script-path only, so the PSBT
    /// builder stamps this as tap_internal_key to signal "keypath
    /// disabled". Exposed here so consumers never re-derive it.
    pub internal_key: XOnlyPublicKey,
    pub leaves: Vec<BlocLeaf>,
    pub descriptor: String,
    pub miniscript_policy: String,
    /// Same tree as `spend_info`, in the `TapTree` shape a PSBT output's
    /// PSBT_OUT_TAP_TREE field needs -- see attach_tap_change_output_metadata
    /// in psbt_builder.rs. Must come from the same builder spend_info did,
    /// captured before .finalize() consumes it, so the two can never drift.
    pub tap_tree: TapTree,
}

pub fn build_bloc_multileaf(policy: &DynastyBlocPolicy) -> Result<BlocMultileafOutput, PolicyError> {
    verify_bloc(policy)?;

    let secp = Secp256k1::verification_only();
    let nums_bytes = hex::decode(NUMS_HEX)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS decode: {e}")))?;
    let internal_key = XOnlyPublicKey::from_slice(&nums_bytes)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS xonly: {e}")))?;

    let parents: Vec<String> = policy.parent_keys.iter().map(|k| format!("pk({k})")).collect();
    let kids: Vec<String> = policy.kid_keys.iter().map(|k| format!("pk({k})")).collect();
    let parents_join = parents.join(",");
    let kids_join = kids.join(",");

    // (path, quorum, locktime, policy_string) for every spend branch,
    // in the exact leaf order the tree is built. Order is load-bearing:
    // the descriptor nesting and the add_leaf depth schedule both follow
    // it, and the PSBT builder relies on leaf_script identity, not order.
    let mut branches: Vec<(String, usize, u32, String)> = vec![
        (
            BLOC_PATH_PARENTS_NOW.to_string(),
            policy.parents_together_quorum,
            0,
            format!("thresh({},{})", policy.parents_together_quorum, parents_join),
        ),
        (
            BLOC_PATH_COPARENT_KIDS.to_string(),
            policy.kids_with_parent_quorum,
            0,
            format!(
                "and(thresh({},{}),thresh({},{}))",
                policy.coparent_quorum, parents_join, policy.kids_with_parent_quorum, kids_join,
            ),
        ),
        (
            BLOC_PATH_PARENT_SOLO.to_string(),
            policy.parent_solo_quorum,
            policy.parent_solo_after,
            format!(
                "and(after({}),thresh({},{}))",
                policy.parent_solo_after, policy.parent_solo_quorum, parents_join,
            ),
        ),
    ];

    // Decaying kid ladder: highest quorum at the earliest height; each
    // rung drops the quorum by one and pushes the height out by a step.
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
        branches.push((
            BLOC_PATH_KIDS_DECAY.to_string(),
            q,
            height,
            format!("and(after({}),thresh({},{}))", height, q, kids_join),
        ));
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

    let compiled: Vec<Miniscript<PublicKey, miniscript::Tap>> =
        branches.iter().map(|(_, _, _, s)| compile_leaf(s)).collect::<Result<_, _>>()?;

    let n = compiled.len();
    if n < 2 {
        return Err(PolicyError::InvalidBloc("need at least two leaves".into()));
    }

    // Right-leaning tree: leaf i at depth i+1, last leaf shares the
    // second-to-last's depth (n-1). Proven shape -- the same schedule
    // the founders/heirs/protector tree uses for 3 and 4 leaves.
    let mut builder = TaprootBuilder::new();
    for (i, ms) in compiled.iter().enumerate() {
        let depth = if i + 1 < n { (i + 1) as u8 } else { (n - 1) as u8 };
        builder = builder
            .add_leaf(depth, ms.encode())
            .map_err(|e| PolicyError::Descriptor(format!("add_leaf {i} (depth {depth}): {e:?}")))?;
    }
    let tap_tree = TapTree::try_from(builder.clone())
        .map_err(|e| PolicyError::Descriptor(format!("tap_tree: {e:?}")))?;

    let spend_info = builder
        .finalize(&secp, internal_key)
        .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;

    let leaf_descs: Vec<String> = compiled.iter().map(|ms| ms.to_string()).collect();
    let descriptor = format!("tr({},{})", internal_key, nest_leaves(&leaf_descs));

    // Round-trip through rust-miniscript so a malformed tree fails here
    // instead of producing an unspendable address downstream.
    use miniscript::{Descriptor, DescriptorPublicKey};
    let _: Descriptor<DescriptorPublicKey> = Descriptor::from_str(&descriptor)
        .map_err(|e| PolicyError::Descriptor(format!("descriptor round-trip: {e:?}")))?;

    let branch_strs: Vec<String> = branches.iter().map(|(_, _, _, s)| s.clone()).collect();
    let leaves: Vec<BlocLeaf> = branches
        .iter()
        .zip(compiled.iter())
        .map(|((path, quorum, locktime, _), ms)| BlocLeaf {
            path: path.clone(),
            quorum: *quorum,
            locktime: *locktime,
            leaf_script: ms.encode(),
        })
        .collect();

    Ok(BlocMultileafOutput {
        spend_info,
        internal_key,
        leaves,
        descriptor,
        miniscript_policy: nest_or(&branch_strs),
        tap_tree,
    })
}

// // -- Generic leaf-list vault (toggle-a-leaf builder)
// Replaces the named-field DynastyPolicy shape above with one generic
// mechanism, for NEW vaults only: a vault is an ordered list of leaves,
// each independently "who" (a quorum of keys) and "when" (immediate, an
// absolute deadline, or a short self-refreshing relative window).
// build_multileaf's 7 hand-written branches above collapse into the one
// loop below -- the same generalization build_bloc_multileaf already
// proved out for the Bloc shape, applied to the standard vault. Every
// already-compiled vault keeps working through the named-field path
// above, untouched and forever -- nothing here changes it.

/// When a leaf unlocks.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Unlock {
    /// Spendable from funding onward.
    Immediate,
    /// OP_CHECKLOCKTIMEVERIFY -- a fixed absolute block height that never
    /// resets. Use for any leaf meant to hold a deadline regardless of
    /// activity (recovery, inheritance, protector).
    After { blocks: u32 },
    /// OP_CHECKSEQUENCEVERIFY (BIP68 relative locktime) -- measured from
    /// this specific UTXO's confirmation height, resets on every spend.
    /// Capped at MAX_RELATIVE_BLOCKS; `verify_leaf_policy` rejects a
    /// larger value and rejects a vault that relies on this as its only
    /// non-immediate fallback.
    #[serde(rename = "older")]
    OlderThan { blocks: u32 },
}

/// Expands one leaf into a ladder of leaves sharing the same key pool,
/// quorum stepping down by one every `step_blocks` starting from the
/// leaf's own unlock height, down to `floor_quorum`. Generalizes the
/// decay mechanic `build_bloc_multileaf` already implements for one
/// hardcoded key group (kids) to any leaf.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecayConfig {
    pub step_blocks: u32,
    pub floor_quorum: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Leaf {
    /// Stable identifier, unique within the vault. Used for PSBT path
    /// selection and governance lookups instead of a named field.
    pub id: String,
    /// Plain-language role name shown to the user (never "leaf N" or
    /// "quorum" -- see docs/ux-coherence-redesign.md section 5).
    pub label: String,
    pub keys: Vec<PublicKey>,
    pub quorum: usize,
    pub unlock: Unlock,
    #[serde(default)]
    pub decay: Option<DecayConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeafPolicy {
    pub leaves: Vec<Leaf>,
    /// Beneficiary-consent gate on the PRIMARY leaf only (the first
    /// Immediate leaf) -- same "and(trustee_thresh,consent_thresh)"
    /// semantics DynastyPolicy.consent_keys already has. Stays a modifier
    /// here rather than folding into the leaf list, since it's
    /// structurally an AND on one leaf's condition, not an alternative
    /// OR-branch.
    #[serde(default)]
    pub consent_keys: Vec<PublicKey>,
    #[serde(default)]
    pub consent_quorum: Option<usize>,
}

/// A key appearing in more than one leaf -- informational, never a
/// rejection. docs/green-ladder-spec.md already names this as a real,
/// sometimes-deliberate security choice ("a single key reused across legs
/// can spend via ANY leg whose timelock has elapsed") that needs "the
/// teaching beside it," not a ban. Consumed by the frontend to render an
/// inline plain-language note as the operator builds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyReuseNote {
    pub pubkey: PublicKey,
    pub leaf_ids: Vec<String>,
}

/// Every key used in 2+ leaves, keyed by the key's own string form so no
/// PartialOrd/Ord bound on PublicKey is required.
pub fn find_key_reuse(leaves: &[Leaf]) -> Vec<KeyReuseNote> {
    use std::collections::BTreeMap;
    let mut by_key: BTreeMap<String, (PublicKey, Vec<String>)> = BTreeMap::new();
    for leaf in leaves {
        for k in &leaf.keys {
            let entry = by_key
                .entry(k.to_string())
                .or_insert_with(|| (*k, Vec::new()));
            entry.1.push(leaf.id.clone());
        }
    }
    by_key
        .into_values()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(pubkey, leaf_ids)| KeyReuseNote { pubkey, leaf_ids })
        .collect()
}

/// Expands a single leaf into the ladder its `decay` config describes. A
/// leaf with no `decay` expands to itself, unchanged.
fn expand_decay(leaf: &Leaf) -> Result<Vec<Leaf>, PolicyError> {
    let Some(cfg) = &leaf.decay else {
        return Ok(vec![leaf.clone()]);
    };
    let (start_blocks, is_relative) = match leaf.unlock {
        Unlock::After { blocks } => (blocks, false),
        Unlock::OlderThan { blocks } => (blocks, true),
        Unlock::Immediate => return Err(PolicyError::DecayRequiresTimelock),
    };
    if cfg.floor_quorum == 0 || cfg.floor_quorum > leaf.quorum {
        return Err(PolicyError::InvalidQuorum);
    }
    let mut out = Vec::new();
    let mut q = leaf.quorum;
    let mut rung: u32 = 0;
    loop {
        let height = start_blocks
            .checked_add(
                rung.checked_mul(cfg.step_blocks)
                    .ok_or(PolicyError::RelativeTimelockTooLong(u32::MAX))?,
            )
            .ok_or(PolicyError::RelativeTimelockTooLong(u32::MAX))?;
        out.push(Leaf {
            id: format!("{}_{}", leaf.id, rung),
            label: leaf.label.clone(),
            keys: leaf.keys.clone(),
            quorum: q,
            unlock: if is_relative {
                Unlock::OlderThan { blocks: height }
            } else {
                Unlock::After { blocks: height }
            },
            decay: None,
        });
        if q == cfg.floor_quorum {
            break;
        }
        q -= 1;
        rung += 1;
    }
    Ok(out)
}

fn verify_leaf_policy(policy: &LeafPolicy) -> Result<(), PolicyError> {
    if policy.leaves.is_empty() {
        return Err(PolicyError::EmptyLeafPolicy);
    }
    if let Some(cq) = policy.consent_quorum {
        if cq == 0 || cq > policy.consent_keys.len() {
            return Err(PolicyError::InvalidQuorum);
        }
    }
    if !policy.leaves.iter().any(|l| matches!(l.unlock, Unlock::Immediate)) {
        return Err(PolicyError::NoImmediateLeaf);
    }
    for leaf in &policy.leaves {
        if leaf.quorum == 0 || leaf.quorum > leaf.keys.len() {
            return Err(PolicyError::InvalidQuorum);
        }
        if let Unlock::OlderThan { blocks } = leaf.unlock {
            if blocks > MAX_RELATIVE_BLOCKS {
                return Err(PolicyError::RelativeTimelockTooLong(blocks));
            }
        }
        if let Some(cfg) = &leaf.decay {
            if cfg.floor_quorum == 0 || cfg.floor_quorum > leaf.quorum {
                return Err(PolicyError::InvalidQuorum);
            }
        }
    }
    // A relative-timelock leaf is a quality-of-life relaxation on an
    // already-adequate vault, never a substitute for a real fixed-deadline
    // fallback -- see MAX_RELATIVE_BLOCKS's doc comment and the amended
    // CLAUDE.md absolute-timelock section.
    let has_relative = policy
        .leaves
        .iter()
        .any(|l| matches!(l.unlock, Unlock::OlderThan { .. }));
    let has_absolute = policy
        .leaves
        .iter()
        .any(|l| matches!(l.unlock, Unlock::After { .. }));
    if has_relative && !has_absolute {
        return Err(PolicyError::RelativeTimelockNeedsAbsoluteFallback);
    }
    Ok(())
}

/// Sole source of truth for the generic leaf-list tree, for new vaults
/// only. One loop over the (decay-expanded) leaf list, the way
/// `build_bloc_multileaf` is already written -- replaces the old
/// `build_multileaf`'s 7 hand-written branches for anything that goes
/// through this function. `build_multileaf` itself is untouched and keeps
/// serving every vault compiled before this existed.
pub fn build_leaf_multileaf(policy: &LeafPolicy) -> Result<MultileafOutput, PolicyError> {
    verify_leaf_policy(policy)?;

    let secp = Secp256k1::verification_only();
    let nums_bytes = hex::decode(NUMS_HEX)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS decode: {e}")))?;
    let internal_key = XOnlyPublicKey::from_slice(&nums_bytes)
        .map_err(|e| PolicyError::Descriptor(format!("NUMS xonly: {e}")))?;

    let mut flat: Vec<Leaf> = Vec::new();
    for leaf in &policy.leaves {
        flat.extend(expand_decay(leaf)?);
    }

    let compile_leaf =
        |s: &str| -> Result<Miniscript<PublicKey, miniscript::Tap>, PolicyError> {
            s.parse::<Concrete<PublicKey>>()
                .map_err(|e| PolicyError::Miniscript(format!("parse {s}: {e:?}")))?
                .compile()
                .map_err(|e| PolicyError::Miniscript(format!("compile {s}: {e:?}")))
        };

    let has_consent = policy.consent_quorum.is_some() && !policy.consent_keys.is_empty();
    let consent_thresh = if has_consent {
        let consenters: Vec<String> = policy
            .consent_keys
            .iter()
            .map(|k| format!("pk({k})"))
            .collect();
        Some(format!(
            "thresh({},{})",
            policy.consent_quorum.unwrap(),
            consenters.join(","),
        ))
    } else {
        None
    };

    // The FIRST immediate leaf is the vault's primary spend path -- the
    // one consent (if configured) gates, matching consent's existing
    // "beneficiary consent on every normal spend" semantics.
    let mut primary_seen = false;
    let mut compiled: Vec<(String, String, Miniscript<PublicKey, miniscript::Tap>)> = Vec::new();
    for leaf in &flat {
        let keys: Vec<String> = leaf.keys.iter().map(|k| format!("pk({k})")).collect();
        let thresh = format!("thresh({},{})", leaf.quorum, keys.join(","));
        let is_primary = matches!(leaf.unlock, Unlock::Immediate) && !primary_seen;
        if is_primary {
            primary_seen = true;
        }
        let gated = if is_primary && has_consent {
            format!("and({},{})", thresh, consent_thresh.as_ref().unwrap())
        } else {
            thresh
        };
        let policy_str = match leaf.unlock {
            Unlock::Immediate => gated,
            Unlock::After { blocks } => format!("and(after({blocks}),{gated})"),
            Unlock::OlderThan { blocks } => format!("and(older({blocks}),{gated})"),
        };
        let ms = compile_leaf(&policy_str)?;
        compiled.push((leaf.id.clone(), policy_str, ms));
    }

    let n = compiled.len();
    let mut builder = TaprootBuilder::new();
    for (i, (_, _, ms)) in compiled.iter().enumerate() {
        let depth = if n == 1 {
            0
        } else if i + 1 < n {
            (i + 1) as u8
        } else {
            (n - 1) as u8
        };
        builder = builder
            .add_leaf(depth, ms.encode())
            .map_err(|e| PolicyError::Descriptor(format!("add_leaf {i} (depth {depth}): {e:?}")))?;
    }
    let tap_tree = TapTree::try_from(builder.clone())
        .map_err(|e| PolicyError::Descriptor(format!("tap_tree: {e:?}")))?;
    let spend_info = builder
        .finalize(&secp, internal_key)
        .map_err(|e| PolicyError::Descriptor(format!("finalize: {e:?}")))?;

    let leaf_scripts: Vec<(String, bitcoin::ScriptBuf)> = compiled
        .iter()
        .map(|(id, _, ms)| (id.clone(), ms.encode()))
        .collect();

    let descriptor_leaves: Vec<String> = compiled.iter().map(|(_, _, ms)| ms.to_string()).collect();
    let descriptor = if n == 1 {
        format!("tr({},{})", internal_key, descriptor_leaves[0])
    } else {
        format!("tr({},{})", internal_key, nest_leaves(&descriptor_leaves))
    };

    // Round-trip through rust-miniscript so a malformed tree fails here
    // instead of producing an unspendable address downstream -- same
    // guard `build_bloc_multileaf` already uses.
    use miniscript::{Descriptor, DescriptorPublicKey};
    let _: Descriptor<DescriptorPublicKey> = Descriptor::from_str(&descriptor)
        .map_err(|e| PolicyError::Descriptor(format!("descriptor round-trip: {e:?}")))?;

    // founder_leaf is read directly by some MultileafOutput consumers
    // (e.g. change-output detection) -- populate it with the primary
    // leaf's script so those keep working unmodified; every leaf,
    // including this one, is also in leaf_scripts by id.
    let founder_leaf = compiled[0].2.encode();

    let policy_strs: Vec<String> = compiled.iter().map(|(_, s, _)| s.clone()).collect();
    let leaf_unlocks: Vec<(String, Unlock)> =
        flat.iter().map(|leaf| (leaf.id.clone(), leaf.unlock)).collect();

    Ok(MultileafOutput {
        spend_info,
        tap_tree,
        founder_leaf,
        recovery_leaf: None,
        inheritance_leaf: None,
        second_inheritance_leaf: None,
        descriptor,
        miniscript_policy: nest_or(&policy_strs),
        leaf_scripts,
        leaf_unlocks,
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

    if !policy.wants_inheritance() && policy.has_backup() {
        // "Founders + backup only" -- no inheritance leg to fold in.
        let backups: Vec<String> = policy
            .backup_keys
            .iter()
            .map(|k| format!("pk({k})"))
            .collect();
        let backup_branch = format!("thresh({},{})", policy.backup_quorum.unwrap(), backups.join(","));
        return format!("or({},{})", founder_thresh, backup_branch);
    }

    let heirs: Vec<String> = policy
        .heir_keys
        .iter()
        .map(|k| format!("pk({k})"))
        .collect();
    let inheritance_branch = format!(
        "and(after({}),thresh({},{}))",
        policy.inheritance_after,
        policy.heir_quorum,
        heirs.join(",")
    );

    if !policy.has_middle_leaf() {
        // Gift Locker shape: no recovery/backup branch to fold in.
        return format!("or({},{})", founder_thresh, inheritance_branch);
    }

    // The middle slot is either the untimelocked backup branch (its own
    // key set, no after()) or the timelocked recovery branch (founders'
    // own keys again, own quorum falling back to founder_quorum when the
    // trust never declared one) -- mutually exclusive, see has_backup's
    // doc comment.
    let recovery_branch = if policy.has_backup() {
        let backups: Vec<String> = policy
            .backup_keys
            .iter()
            .map(|k| format!("pk({k})"))
            .collect();
        format!("thresh({},{})", policy.backup_quorum.unwrap(), backups.join(","))
    } else {
        let recovery_quorum = policy.recovery_quorum.unwrap_or(policy.founder_quorum);
        let recovery_thresh = format!("thresh({},{})", recovery_quorum, founders.join(","));
        format!("and(after({}),{})", policy.recovery_after, recovery_thresh)
    };

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

    if policy.has_consent() {
        let cq = policy.consent_quorum.unwrap();
        if cq == 0 || cq > policy.consent_keys.len() {
            return Err(PolicyError::InvalidQuorum);
        }
    }

    if policy.has_backup() {
        let bq = policy.backup_quorum.unwrap();
        if bq == 0 || bq > policy.backup_keys.len() {
            return Err(PolicyError::InvalidQuorum);
        }
    }

    if policy.has_second_inheritance() {
        let shq = policy.second_heir_quorum.unwrap();
        if shq == 0 || shq > policy.second_heir_keys.len() {
            return Err(PolicyError::InvalidQuorum);
        }
        if policy.second_inheritance_after.unwrap() == 0 {
            return Err(PolicyError::SecondInheritanceRequiresDelay);
        }
    }

    if policy.has_recovery() && policy.has_backup() {
        return Err(PolicyError::BackupConflictsWithRecovery);
    }

    if policy.is_plain() {
        // Plain mode: only the founder threshold matters.
        return Ok(());
    }

    // "Founders + backup only" -- the Tapit Circle shape: a phone-
    // verified circle for the easy case, the owner's own harder key set
    // for "I need to move it myself right now," no third leaf at all.
    // heir_quorum/inheritance_after are irrelevant here (ignored, not
    // validated) since there's no inheritance leaf to apply them to.
    if !policy.wants_inheritance() && policy.has_backup() {
        if policy.has_second_inheritance() {
            return Err(PolicyError::SecondInheritanceRequiresInheritance);
        }
        return Ok(());
    }

    if policy.has_second_inheritance() && !policy.wants_inheritance() {
        return Err(PolicyError::SecondInheritanceRequiresInheritance);
    }

    if policy.heir_quorum == 0 || policy.heir_quorum > policy.heir_keys.len() {
        return Err(PolicyError::InvalidQuorum);
    }

    if policy.has_recovery() {
        if policy.recovery_after < MIN_RECOVERY_BLOCKS {
            return Err(PolicyError::RecoveryTooSoon);
        }

        if policy.inheritance_after <= policy.recovery_after {
            return Err(PolicyError::InheritanceTooSoon);
        }
    } else if policy.inheritance_after == 0 {
        // "Gift Locker" shape (founders-now OR a single beneficiary key
        // after a delay, no separate recovery leaf): still needs a real
        // timelock on the one delayed path that exists.
        return Err(PolicyError::InheritanceRequiresDelay);
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

    // Phase 2 anchor: every leaf in the Bloc tree must yield a control
    // block against the SAME spend_info the address was built from.
    // This is exactly what the PSBT builder will do per chosen path; if
    // any leaf failed here, finalize would later die with "Control block
    // verification failed at index 0".
    #[test]
    fn every_leaf_has_a_control_block() {
        use bitcoin::taproot::LeafVersion;
        let out = build_bloc_multileaf(&sample(4, 1)).unwrap();
        // 7 leaves: parents_now, coparent_kids, parent_solo, + 4 decay rungs.
        assert_eq!(out.leaves.len(), 7);
        for leaf in &out.leaves {
            let script_ver = (leaf.leaf_script.clone(), LeafVersion::TapScript);
            assert!(
                out.spend_info.control_block(&script_ver).is_some(),
                "no control block for path {} quorum {}",
                leaf.path,
                leaf.quorum,
            );
        }
    }

    #[test]
    fn leaf_metadata_matches_paths_and_locktimes() {
        let out = build_bloc_multileaf(&sample(4, 1)).unwrap();
        // Immediate paths carry locktime 0.
        let parents_now = out.leaves.iter().find(|l| l.path == BLOC_PATH_PARENTS_NOW).unwrap();
        assert_eq!(parents_now.locktime, 0);
        let coparent = out.leaves.iter().find(|l| l.path == BLOC_PATH_COPARENT_KIDS).unwrap();
        assert_eq!(coparent.locktime, 0);
        // Parent-solo carries the first timelock.
        let solo = out.leaves.iter().find(|l| l.path == BLOC_PATH_PARENT_SOLO).unwrap();
        assert_eq!(solo.locktime, 100_000);
        // Decay rungs: quorum q sits at start + (start-q)*step.
        let rungs: Vec<_> = out.leaves.iter().filter(|l| l.path == BLOC_PATH_KIDS_DECAY).collect();
        assert_eq!(rungs.len(), 4);
        for r in rungs {
            let expected = 200_000 + (4 - r.quorum as u32) * 52_560;
            assert_eq!(r.locktime, expected, "rung quorum {}", r.quorum);
        }
    }
}

// Regression coverage for the 2026-08-06 fix: MultileafOutput now exposes
// every leaf the tree contains, not just founder_leaf. Before this fix,
// compiler/src/main.rs's /psbt-binary handler could only ever attach the
// founders-now leaf's control block to a PSBT regardless of the caller's
// intended spend path -- an heir signing a legitimate inheritance spend,
// or a hardware wallet asked to sign a recovery spend, would find their
// key absent from the (wrong) leaf attached and the failure looked like
// "not a signer for this input" rather than the real server-side bug.
#[cfg(test)]
mod multileaf_leaf_exposure_tests {
    use super::*;

    fn pk(s: &str) -> PublicKey {
        PublicKey::from_str(s).unwrap()
    }

    fn founders() -> Vec<PublicKey> {
        vec![
            pk("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97"),
            pk("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569"),
        ]
    }
    fn heirs() -> Vec<PublicKey> {
        vec![
            pk("03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34"),
            pk("025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"),
        ]
    }

    fn base_policy() -> DynastyPolicy {
        DynastyPolicy {
            founder_keys: founders(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: heirs(),
            heir_quorum: 2,
            recovery_after: 100_000,
            inheritance_after: 200_000,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        }
    }

    #[test]
    fn plain_policy_exposes_only_founder_leaf() {
        let mut p = base_policy();
        p.heir_keys = vec![];
        p.heir_quorum = 0;
        p.recovery_after = 0;
        p.inheritance_after = 0;
        assert!(p.is_plain());
        let out = build_multileaf(&p).unwrap();
        assert!(out.recovery_leaf.is_none());
        assert!(out.inheritance_leaf.is_none());
    }

    #[test]
    fn non_plain_policy_exposes_recovery_and_inheritance() {
        let out = build_multileaf(&base_policy()).unwrap();
        assert!(out.recovery_leaf.is_some(), "recovery leaf must be exposed");
        assert!(out.inheritance_leaf.is_some(), "inheritance leaf must be exposed");
    }

    // The critical regression check: each exposed leaf must actually be
    // part of the SAME tree spend_info was built from, i.e. control_block
    // succeeds for every one of them -- not just founder_leaf. This is
    // exactly what the PSBT builder needs to attach a valid tap_scripts
    // entry for whichever path the caller intends to spend via.
    #[test]
    fn every_exposed_leaf_has_a_valid_control_block_against_the_same_tree() {
        let p = base_policy();
        let out = build_multileaf(&p).unwrap();

        let script_ver = |s: &bitcoin::ScriptBuf| (s.clone(), bitcoin::taproot::LeafVersion::TapScript);
        assert!(
            out.spend_info.control_block(&script_ver(&out.founder_leaf)).is_some(),
            "founder_leaf control block"
        );
        assert!(
            out.spend_info
                .control_block(&script_ver(out.recovery_leaf.as_ref().unwrap()))
                .is_some(),
            "recovery_leaf control block"
        );
        assert!(
            out.spend_info
                .control_block(&script_ver(out.inheritance_leaf.as_ref().unwrap()))
                .is_some(),
            "inheritance_leaf control block"
        );
    }
}

// "Anytime, harder" (2026-08-08) -- the backup branch: a SEPARATE,
// harder-to-reach key set the owner controls directly, occupying the
// same tree slot the timelocked recovery branch would, but with NO
// timelock at all. The friction is retrieving enough of the backup
// keys, not waiting out a clock.
#[cfg(test)]
mod backup_leaf_tests {
    use super::*;

    fn pk(s: &str) -> PublicKey {
        PublicKey::from_str(s).unwrap()
    }

    fn founders() -> Vec<PublicKey> {
        vec![
            pk("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97"),
            pk("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569"),
        ]
    }
    fn heirs() -> Vec<PublicKey> {
        vec![pk("03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34")]
    }
    fn backups() -> Vec<PublicKey> {
        vec![
            pk("025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"),
            pk("02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"),
            pk("03fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556"),
        ]
    }

    fn backup_policy() -> DynastyPolicy {
        DynastyPolicy {
            founder_keys: founders(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: heirs(),
            heir_quorum: 1,
            recovery_after: 0,
            inheritance_after: 200_000,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: backups(),
            backup_quorum: Some(2),
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        }
    }

    #[test]
    fn has_backup_and_has_middle_leaf_reflect_configuration() {
        let p = backup_policy();
        assert!(p.has_backup());
        assert!(!p.has_recovery());
        assert!(p.has_middle_leaf());
        assert!(!p.is_plain(), "backup_keys alone must disqualify is_plain()");
    }

    #[test]
    fn empty_policy_has_neither_recovery_nor_backup() {
        let mut p = backup_policy();
        p.backup_keys = vec![];
        p.backup_quorum = None;
        assert!(!p.has_recovery());
        assert!(!p.has_backup());
        assert!(!p.has_middle_leaf());
    }

    #[test]
    fn setting_both_recovery_and_backup_is_rejected() {
        let mut p = backup_policy();
        p.recovery_after = MIN_RECOVERY_BLOCKS;
        match build_multileaf(&p) {
            Err(PolicyError::BackupConflictsWithRecovery) => {}
            other => panic!("expected BackupConflictsWithRecovery, got {other:?}"),
        }
    }

    #[test]
    fn invalid_backup_quorum_is_rejected() {
        let mut p = backup_policy();
        p.backup_quorum = Some(0);
        assert!(matches!(build_multileaf(&p), Err(PolicyError::InvalidQuorum)));

        let mut p2 = backup_policy();
        p2.backup_quorum = Some(4); // only 3 backup keys
        assert!(matches!(build_multileaf(&p2), Err(PolicyError::InvalidQuorum)));
    }

    #[test]
    fn backup_leaf_uses_the_separate_key_set_not_founder_keys() {
        let out = build_multileaf(&backup_policy()).unwrap();
        let backup_leaf = out.recovery_leaf.as_ref().expect("backup occupies the recovery slot");
        let bytes = backup_leaf.as_bytes();

        for k in backups() {
            let xonly = k.inner.x_only_public_key().0.serialize();
            assert!(bytes.windows(32).any(|w| w == xonly), "backup leaf must contain each backup key");
        }
        for k in founders() {
            let xonly = k.inner.x_only_public_key().0.serialize();
            assert!(
                !bytes.windows(32).any(|w| w == xonly),
                "backup leaf must NEVER contain a founder key -- it's a separate, harder-to-reach set"
            );
        }
    }

    #[test]
    fn backup_leaf_carries_no_timelock() {
        let out = build_multileaf(&backup_policy()).unwrap();
        let backup_leaf = out.recovery_leaf.as_ref().unwrap();
        // A CLTV-gated script always disassembles to an OP_CLTV opcode
        // (0xb1); the pure thresh() backup leaf never emits one.
        assert!(
            !backup_leaf.as_bytes().contains(&0xb1),
            "backup leaf must contain no OP_CHECKLOCKTIMEVERIFY -- it is never timelocked"
        );
    }

    #[test]
    fn backup_leaf_has_a_valid_control_block_against_the_same_tree() {
        let out = build_multileaf(&backup_policy()).unwrap();
        let script_ver = |s: &bitcoin::ScriptBuf| (s.clone(), bitcoin::taproot::LeafVersion::TapScript);
        assert!(out.spend_info.control_block(&script_ver(&out.founder_leaf)).is_some());
        assert!(
            out.spend_info
                .control_block(&script_ver(out.recovery_leaf.as_ref().unwrap()))
                .is_some(),
            "backup leaf (recovery slot) control block"
        );
        assert!(
            out.spend_info
                .control_block(&script_ver(out.inheritance_leaf.as_ref().unwrap()))
                .is_some(),
            "inheritance leaf control block"
        );
    }



    // "Founders + backup only" -- the actual Tapit Circle shape: a
    // phone-verified circle for the easy case, the owner's own harder
    // key set for "I need to move it myself right now," no third leaf
    // (no heirs, no estate-planning timelock) at all.
    fn founders_and_backup_only_policy() -> DynastyPolicy {
        let mut p = backup_policy();
        p.heir_keys = vec![];
        p.heir_quorum = 0;
        p.inheritance_after = 0;
        p
    }

    #[test]
    fn founders_and_backup_only_is_not_plain_and_does_not_want_inheritance() {
        let p = founders_and_backup_only_policy();
        assert!(!p.is_plain());
        assert!(!p.wants_inheritance());
        assert!(p.has_backup());
    }

    #[test]
    fn founders_and_backup_only_compiles_to_exactly_two_leaves() {
        let out = build_multileaf(&founders_and_backup_only_policy()).unwrap();
        assert!(out.recovery_leaf.is_some(), "backup occupies the recovery slot");
        assert!(out.inheritance_leaf.is_none(), "no third leaf at all in this shape");
    }

    #[test]
    fn founders_and_backup_only_both_leaves_have_valid_control_blocks() {
        let out = build_multileaf(&founders_and_backup_only_policy()).unwrap();
        let script_ver = |s: &bitcoin::ScriptBuf| (s.clone(), bitcoin::taproot::LeafVersion::TapScript);
        assert!(out.spend_info.control_block(&script_ver(&out.founder_leaf)).is_some());
        assert!(
            out.spend_info
                .control_block(&script_ver(out.recovery_leaf.as_ref().unwrap()))
                .is_some()
        );
    }

    #[test]
    fn founders_and_backup_only_descriptor_has_no_nested_braces() {
        // Exactly two leaves -> tr(key,{a,b}), never a nested tap_branch.
        let out = build_multileaf(&founders_and_backup_only_policy()).unwrap();
        assert_eq!(out.descriptor.matches('{').count(), 1);
        assert_eq!(out.descriptor.matches('}').count(), 1);
    }


    #[test]
    fn compiles_end_to_end_through_the_real_tr_multileaf_path() {
        let v = compile_dynasty_policy_tr_multileaf(founders_and_backup_only_policy(), Network::Testnet).unwrap();
        assert!(v.address.to_string().starts_with("tb1p"));
        assert_eq!(v.address_type, AddressType::TrMultileaf);
        // A pure thresh() branch never emits OP_CLTV.
        assert!(!v.miniscript_policy.contains("after("));
    }
}

#[cfg(test)]
mod gift_locker_tests {
    //! "Gift Locker" vault shape (decided 2026-08-08): founders-now
    //! (typically 2-of-2: the gifter plus a lawyer/family-member
    //! co-signer) OR a single gifted key that alone unlocks after a
    //! specified absolute time -- no separate founders-after-a-delay
    //! recovery leaf in between. Reuses the existing tr_multileaf
    //! compiler via `DynastyPolicy::has_recovery() == false`, not a
    //! separate wallet type.
    use super::*;

    fn pk(s: &str) -> PublicKey {
        PublicKey::from_str(s).unwrap()
    }

    fn gifter_and_helper() -> Vec<PublicKey> {
        vec![
            pk("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97"),
            pk("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569"),
        ]
    }

    fn gift_key() -> Vec<PublicKey> {
        vec![pk("03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34")]
    }

    fn gift_locker_policy() -> DynastyPolicy {
        DynastyPolicy {
            founder_keys: gifter_and_helper(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: gift_key(),
            heir_quorum: 1,
            recovery_after: 0,
            inheritance_after: 800_000,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        }
    }

    #[test]
    fn is_not_plain_and_has_no_recovery() {
        let p = gift_locker_policy();
        assert!(!p.is_plain());
        assert!(!p.has_recovery());
    }

    #[test]
    fn exposes_exactly_founder_and_inheritance_leaves() {
        let out = build_multileaf(&gift_locker_policy()).unwrap();
        assert!(out.recovery_leaf.is_none(), "no separate recovery leaf in this shape");
        assert!(out.inheritance_leaf.is_some());
    }

    #[test]
    fn both_leaves_have_a_valid_control_block_against_the_same_tree() {
        let out = build_multileaf(&gift_locker_policy()).unwrap();
        let script_ver = |s: &bitcoin::ScriptBuf| (s.clone(), bitcoin::taproot::LeafVersion::TapScript);
        assert!(
            out.spend_info.control_block(&script_ver(&out.founder_leaf)).is_some(),
            "founder_leaf control block"
        );
        assert!(
            out.spend_info
                .control_block(&script_ver(out.inheritance_leaf.as_ref().unwrap()))
                .is_some(),
            "inheritance_leaf control block"
        );
    }

    #[test]
    fn descriptor_has_exactly_two_leaves_no_nested_braces() {
        // Two leaves at the same depth is a single level of braces --
        // tr(key,{a,b}) -- not the nested tr(key,{a,{b,c}}) shape a
        // 3-leaf tree produces.
        let out = build_multileaf(&gift_locker_policy()).unwrap();
        assert_eq!(out.descriptor.matches('{').count(), 1);
        assert_eq!(out.descriptor.matches('}').count(), 1);
    }

    #[test]
    fn compiles_end_to_end_through_the_real_tr_multileaf_path() {
        // The actual function the compiler HTTP service calls
        // (address_type == "tr_multileaf") -- round-trips the
        // descriptor through rust-miniscript's own parser, not just
        // build_multileaf() in isolation.
        let compiled = compile_dynasty_policy_tr_multileaf(gift_locker_policy(), bitcoin::Network::Testnet).unwrap();
        assert_eq!(compiled.address_type, AddressType::TrMultileaf);
        assert!(compiled.miniscript_policy.starts_with("or("));
    }


    #[test]
    fn zero_inheritance_delay_with_no_recovery_is_rejected() {
        // Must still have a real timelock on the one delayed path that
        // exists -- "gift unlocks at a specified time" requires a
        // specified time.
        let mut p = gift_locker_policy();
        p.inheritance_after = 0;
        let err = build_multileaf(&p).unwrap_err();
        assert!(matches!(err, PolicyError::InheritanceRequiresDelay));
    }

    #[test]
    fn build_policy_string_matches_the_two_leaf_shape() {
        let s = build_policy_string(&gift_locker_policy());
        assert!(s.starts_with("or("));
        // No middle recovery clause -- exactly one nested or(...), not two.
        assert_eq!(s.matches("or(").count(), 1);
    }
}

// Second, independent inheritance leaf (2026-08-11) -- a distinct heir
// cohort with its own key set, quorum, and absolute timelock alongside
// the primary inheritance leaf. Covers both tree shapes it can attach
// to: Gift Locker (3 leaves), standard (4 leaves), and the validation
// gates.
#[cfg(test)]
mod second_inheritance_tests {
    use super::*;

    fn pk(s: &str) -> PublicKey {
        PublicKey::from_str(s).unwrap()
    }

    fn founders() -> Vec<PublicKey> {
        vec![
            pk("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97"),
            pk("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569"),
        ]
    }
    fn heirs() -> Vec<PublicKey> {
        vec![pk("03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34")]
    }
    fn second_heirs() -> Vec<PublicKey> {
        vec![
            pk("025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"),
            pk("02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"),
        ]
    }

    fn standard_policy() -> DynastyPolicy {
        DynastyPolicy {
            founder_keys: founders(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: heirs(),
            heir_quorum: 1,
            recovery_after: 100_000,
            inheritance_after: 200_000,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: second_heirs(),
            second_heir_quorum: Some(1),
            second_inheritance_after: Some(500_000),
        }
    }

    fn all_control_blocks_valid(out: &MultileafOutput) {
        let script_ver = |s: &bitcoin::ScriptBuf| (s.clone(), bitcoin::taproot::LeafVersion::TapScript);
        assert!(out.spend_info.control_block(&script_ver(&out.founder_leaf)).is_some(), "founder_leaf");
        if let Some(l) = &out.recovery_leaf {
            assert!(out.spend_info.control_block(&script_ver(l)).is_some(), "recovery_leaf");
        }
        if let Some(l) = &out.inheritance_leaf {
            assert!(out.spend_info.control_block(&script_ver(l)).is_some(), "inheritance_leaf");
        }
        if let Some(l) = &out.second_inheritance_leaf {
            assert!(out.spend_info.control_block(&script_ver(l)).is_some(), "second_inheritance_leaf");
        }
    }

    #[test]
    fn has_second_inheritance_requires_all_three_fields() {
        let mut p = standard_policy();
        assert!(p.has_second_inheritance());
        p.second_heir_quorum = None;
        assert!(!p.has_second_inheritance());
    }

    #[test]
    fn standard_shape_with_second_inheritance_exposes_four_leaves() {
        let out = build_multileaf(&standard_policy()).unwrap();
        assert!(out.recovery_leaf.is_some());
        assert!(out.inheritance_leaf.is_some());
        assert!(out.second_inheritance_leaf.is_some());
        all_control_blocks_valid(&out);
    }

    #[test]
    fn standard_shape_without_second_inheritance_is_unaffected() {
        // Regression: the pre-existing 3-leaf shape must compile exactly
        // as before when second_heir_keys is empty.
        let mut p = standard_policy();
        p.second_heir_keys = vec![];
        p.second_heir_quorum = None;
        p.second_inheritance_after = None;
        let out = build_multileaf(&p).unwrap();
        assert!(out.second_inheritance_leaf.is_none());
        assert_eq!(out.descriptor.matches('{').count(), 2);
        all_control_blocks_valid(&out);
    }


    #[test]
    fn gift_locker_shape_with_second_inheritance_exposes_three_leaves() {
        let mut p = standard_policy();
        p.recovery_after = 0; // no middle leaf -> Gift Locker shape
        let out = build_multileaf(&p).unwrap();
        assert!(out.recovery_leaf.is_none());
        assert!(out.inheritance_leaf.is_some());
        assert!(out.second_inheritance_leaf.is_some());
        all_control_blocks_valid(&out);
    }

    #[test]
    fn second_inheritance_without_primary_inheritance_is_rejected() {
        let mut p = standard_policy();
        p.heir_keys = vec![];
        p.heir_quorum = 0;
        p.inheritance_after = 0;
        let err = build_multileaf(&p).unwrap_err();
        assert!(matches!(err, PolicyError::SecondInheritanceRequiresInheritance));
    }

    #[test]
    fn second_inheritance_zero_delay_is_rejected() {
        let mut p = standard_policy();
        p.second_inheritance_after = Some(0);
        let err = build_multileaf(&p).unwrap_err();
        assert!(matches!(err, PolicyError::SecondInheritanceRequiresDelay));
    }

    #[test]
    fn second_inheritance_invalid_quorum_is_rejected() {
        let mut p = standard_policy();
        p.second_heir_quorum = Some(99);
        let err = build_multileaf(&p).unwrap_err();
        assert!(matches!(err, PolicyError::InvalidQuorum));
    }

    #[test]
    fn compiles_end_to_end_through_the_real_tr_multileaf_path() {
        let compiled = compile_dynasty_policy_tr_multileaf(standard_policy(), Network::Testnet).unwrap();
        assert!(compiled.address.to_string().starts_with("tb1p"));
        assert_eq!(compiled.address_type, AddressType::TrMultileaf);
        assert_eq!(compiled.miniscript_policy.matches("after(").count(), 3);
    }
}

#[cfg(test)]
mod tranche_leaf_exposure_tests {
    use super::*;

    fn pk(s: &str) -> PublicKey {
        PublicKey::from_str(s).unwrap()
    }

    fn beneficiary() -> PublicKey {
        pk("03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34")
    }
    fn trustees() -> Vec<PublicKey> {
        vec![
            pk("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97"),
            pk("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569"),
        ]
    }

    fn base_policy() -> TranchePolicy {
        TranchePolicy {
            beneficiary_key: beneficiary(),
            trustee_keys: trustees(),
            trustee_quorum: 2,
            unlock_block: 300_000,
        }
    }

    #[test]
    fn exposes_both_leaves() {
        let out = build_tranche(&base_policy()).unwrap();
        assert!(!out.beneficiary_leaf.is_empty());
        assert!(!out.trustee_leaf.is_empty());
        assert_ne!(out.beneficiary_leaf, out.trustee_leaf);
    }

    #[test]
    fn invalid_quorum_rejected() {
        let mut p = base_policy();
        p.trustee_quorum = 0;
        assert!(build_tranche(&p).is_err());
        p.trustee_quorum = 99;
        assert!(build_tranche(&p).is_err());
    }

    // Same regression shape as the multileaf test above: both leaves
    // must resolve a control block against the SAME spend_info, or a
    // PSBT builder attaching one would fail to verify on-chain.
    #[test]
    fn both_leaves_have_a_valid_control_block_against_the_same_tree() {
        let out = build_tranche(&base_policy()).unwrap();
        let script_ver = |s: &bitcoin::ScriptBuf| (s.clone(), bitcoin::taproot::LeafVersion::TapScript);
        assert!(
            out.spend_info.control_block(&script_ver(&out.beneficiary_leaf)).is_some(),
            "beneficiary_leaf control block"
        );
        assert!(
            out.spend_info.control_block(&script_ver(&out.trustee_leaf)).is_some(),
            "trustee_leaf control block"
        );
    }

    #[test]
    fn compile_tranche_tr_multileaf_matches_build_tranche_address() {
        let p = base_policy();
        let out = build_tranche(&p).unwrap();
        let addr = Address::p2tr_tweaked(out.spend_info.output_key(), Network::Signet);
        let compiled = compile_tranche_tr_multileaf(p, Network::Signet).unwrap();
        assert_eq!(compiled.address, addr);
        assert_eq!(compiled.descriptor, out.descriptor);
    }
}

// Coverage for the generic leaf-list vault (toggle-a-leaf builder). The
// strongest proof the generalization is behavior-preserving, not just
// "looks right": build_leaf_multileaf must produce byte-identical scripts
// to the old named-branch build_multileaf for equivalent inputs. Full
// coverage of all 7 named-branch shapes is tracked separately; this
// module proves the plain and standard-3-leaf cases (the two most
// load-bearing) plus the new mechanics (decay, older(), key reuse,
// validation) that have no named-branch equivalent to compare against.
#[cfg(test)]
mod leaf_policy_tests {
    use super::*;
    use bitcoin::taproot::LeafVersion;

    fn pk(s: &str) -> PublicKey {
        PublicKey::from_str(s).unwrap()
    }

    fn founders() -> Vec<PublicKey> {
        vec![
            pk("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97"),
            pk("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569"),
        ]
    }
    fn heirs() -> Vec<PublicKey> {
        vec![
            pk("03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34"),
            pk("025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"),
        ]
    }

    #[test]
    fn plain_leaf_policy_produces_a_byte_identical_founder_leaf_to_the_named_branch_path() {
        let old = DynastyPolicy {
            founder_keys: founders(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: vec![],
            heir_quorum: 0,
            recovery_after: 0,
            inheritance_after: 0,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        };
        let old_out = build_multileaf(&old).unwrap();

        let new_policy = LeafPolicy {
            leaves: vec![Leaf {
                id: "primary".into(),
                label: "Founders".into(),
                keys: founders(),
                quorum: 2,
                unlock: Unlock::Immediate,
                decay: None,
            }],
            consent_keys: vec![],
            consent_quorum: None,
        };
        let new_out = build_leaf_multileaf(&new_policy).unwrap();

        assert_eq!(new_out.founder_leaf, old_out.founder_leaf);
        assert_eq!(new_out.descriptor, old_out.descriptor);
        assert_eq!(
            new_out.spend_info.output_key(),
            old_out.spend_info.output_key(),
            "same leaf must tweak to the same output key -- same address"
        );
    }

    #[test]
    fn standard_three_leaf_policy_produces_byte_identical_leaves_to_the_named_branch_path() {
        let old = DynastyPolicy {
            founder_keys: founders(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: heirs(),
            heir_quorum: 2,
            recovery_after: 100_000,
            inheritance_after: 200_000,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        };
        let old_out = build_multileaf(&old).unwrap();

        let new_policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "founders_now".into(),
                    label: "Founders".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "recovery".into(),
                    label: "Recovery".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::After { blocks: 100_000 },
                    decay: None,
                },
                Leaf {
                    id: "inheritance".into(),
                    label: "Inheritance".into(),
                    keys: heirs(),
                    quorum: 2,
                    unlock: Unlock::After { blocks: 200_000 },
                    decay: None,
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        let new_out = build_leaf_multileaf(&new_policy).unwrap();

        assert_eq!(new_out.founder_leaf, old_out.founder_leaf, "founder leaf script");
        assert_eq!(
            new_out.leaf_scripts.iter().find(|(id, _)| id == "recovery").map(|(_, s)| s.clone()),
            old_out.recovery_leaf,
            "recovery leaf script"
        );
        assert_eq!(
            new_out.leaf_scripts.iter().find(|(id, _)| id == "inheritance").map(|(_, s)| s.clone()),
            old_out.inheritance_leaf,
            "inheritance leaf script"
        );
        assert_eq!(
            new_out.spend_info.output_key(),
            old_out.spend_info.output_key(),
            "same three leaves at the same depths must tweak to the same output key"
        );
        assert_eq!(new_out.descriptor, old_out.descriptor);
    }

    #[test]
    fn leaf_scripts_are_keyed_by_the_caller_supplied_id() {
        let policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Founders".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "backstop".into(),
                    label: "Backstop".into(),
                    keys: heirs(),
                    quorum: 1,
                    unlock: Unlock::After { blocks: 100_000 },
                    decay: None,
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        let out = build_leaf_multileaf(&policy).unwrap();
        let ids: Vec<&str> = out.leaf_scripts.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["primary", "backstop"]);
        for (_, script) in &out.leaf_scripts {
            let script_ver = (script.clone(), LeafVersion::TapScript);
            assert!(out.spend_info.control_block(&script_ver).is_some());
        }
    }

    #[test]
    fn leaf_unlocks_reports_the_right_type_per_leaf_including_decay_rungs() {
        let policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Founders".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "recovery".into(),
                    label: "Recovery".into(),
                    keys: founders(),
                    quorum: 1,
                    unlock: Unlock::After { blocks: 100_000 },
                    decay: None,
                },
                Leaf {
                    id: "heirs".into(),
                    label: "Heirs".into(),
                    keys: heirs(),
                    quorum: 2,
                    unlock: Unlock::After { blocks: 200_000 },
                    decay: Some(DecayConfig { step_blocks: 26_280, floor_quorum: 1 }),
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        let out = build_leaf_multileaf(&policy).unwrap();
        let find = |id: &str| out.leaf_unlocks.iter().find(|(i, _)| i == id).map(|(_, u)| *u);

        assert_eq!(find("primary"), Some(Unlock::Immediate));
        assert_eq!(find("recovery"), Some(Unlock::After { blocks: 100_000 }));
        // Decay rungs are id-suffixed by expand_decay ("heirs_0", "heirs_1")
        // and each carries its OWN resolved height, not the leaf's original one.
        assert_eq!(find("heirs_0"), Some(Unlock::After { blocks: 200_000 }));
        assert_eq!(find("heirs_1"), Some(Unlock::After { blocks: 226_280 }));
        assert_eq!(out.leaf_unlocks.len(), out.leaf_scripts.len());
    }

    #[test]
    fn older_leaf_emits_op_csv_and_after_leaf_still_emits_op_cltv() {
        // Same opcode-inspection technique protocol/examples/diag_timelock.rs
        // already established: OP_CHECKLOCKTIMEVERIFY = 0xb1,
        // OP_CHECKSEQUENCEVERIFY = 0xb2.
        let policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Everyone".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "refresh".into(),
                    label: "If untouched".into(),
                    keys: founders(),
                    quorum: 1,
                    unlock: Unlock::OlderThan { blocks: 52_560 },
                    decay: None,
                },
                Leaf {
                    id: "recovery".into(),
                    label: "Recovery".into(),
                    keys: founders(),
                    quorum: 1,
                    unlock: Unlock::After { blocks: 100_000 },
                    decay: None,
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        let out = build_leaf_multileaf(&policy).unwrap();
        let refresh = &out.leaf_scripts.iter().find(|(id, _)| id == "refresh").unwrap().1;
        let recovery = &out.leaf_scripts.iter().find(|(id, _)| id == "recovery").unwrap().1;
        assert!(refresh.as_bytes().contains(&0xb2), "OlderThan leaf must contain OP_CSV");
        assert!(!refresh.as_bytes().contains(&0xb1), "OlderThan leaf must not contain OP_CLTV");
        assert!(recovery.as_bytes().contains(&0xb1), "After leaf must contain OP_CLTV");
        assert!(!recovery.as_bytes().contains(&0xb2), "After leaf must not contain OP_CSV");
    }

    #[test]
    fn relative_leaf_above_the_cap_is_rejected() {
        let policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Everyone".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "refresh".into(),
                    label: "If untouched".into(),
                    keys: founders(),
                    quorum: 1,
                    unlock: Unlock::OlderThan { blocks: MAX_RELATIVE_BLOCKS + 1 },
                    decay: None,
                },
                Leaf {
                    id: "recovery".into(),
                    label: "Recovery".into(),
                    keys: founders(),
                    quorum: 1,
                    unlock: Unlock::After { blocks: 100_000 },
                    decay: None,
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        match build_leaf_multileaf(&policy) {
            Err(PolicyError::RelativeTimelockTooLong(_)) => {}
            other => panic!("expected RelativeTimelockTooLong, got {other:?}"),
        }
    }

    #[test]
    fn relative_leaf_cannot_be_the_only_non_immediate_fallback() {
        let policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Everyone".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "refresh".into(),
                    label: "If untouched".into(),
                    keys: founders(),
                    quorum: 1,
                    unlock: Unlock::OlderThan { blocks: 52_560 },
                    decay: None,
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        match build_leaf_multileaf(&policy) {
            Err(PolicyError::RelativeTimelockNeedsAbsoluteFallback) => {}
            other => panic!("expected RelativeTimelockNeedsAbsoluteFallback, got {other:?}"),
        }
    }

    #[test]
    fn empty_leaf_list_is_rejected() {
        let policy = LeafPolicy { leaves: vec![], consent_keys: vec![], consent_quorum: None };
        assert!(matches!(build_leaf_multileaf(&policy), Err(PolicyError::EmptyLeafPolicy)));
    }

    #[test]
    fn a_vault_with_no_immediate_leaf_is_rejected() {
        let policy = LeafPolicy {
            leaves: vec![Leaf {
                id: "delayed".into(),
                label: "Later".into(),
                keys: founders(),
                quorum: 2,
                unlock: Unlock::After { blocks: 100_000 },
                decay: None,
            }],
            consent_keys: vec![],
            consent_quorum: None,
        };
        assert!(matches!(build_leaf_multileaf(&policy), Err(PolicyError::NoImmediateLeaf)));
    }

    #[test]
    fn expand_decay_produces_the_expected_quorum_per_height_ladder() {
        let leaf = Leaf {
            id: "heirs".into(),
            label: "Heirs".into(),
            keys: vec![
                pk("02a3ed2c2b57903abe5b89108c66f4a144e8a316af2f013b739cf8975fc0365e97"),
                pk("02d76c6752934c92bcafb0e575051b36e5ac4035db5329544521e203d6a7337569"),
                pk("03defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34"),
                pk("025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"),
                pk("03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe"),
            ],
            quorum: 5,
            unlock: Unlock::After { blocks: 200_000 },
            decay: Some(DecayConfig { step_blocks: 26_280, floor_quorum: 1 }),
        };
        let rungs = expand_decay(&leaf).unwrap();
        assert_eq!(rungs.len(), 5, "5-of-5 down to 1-of-5, one rung per quorum step");
        for (i, rung) in rungs.iter().enumerate() {
            assert_eq!(rung.quorum, 5 - i);
            assert_eq!(rung.keys.len(), 5, "every rung shares the full key pool");
            let expected_height = 200_000 + (i as u32) * 26_280;
            assert_eq!(rung.unlock, Unlock::After { blocks: expected_height });
        }
        assert_eq!(rungs.last().unwrap().quorum, 1);
    }

    #[test]
    fn decay_on_an_immediate_leaf_is_rejected() {
        let leaf = Leaf {
            id: "x".into(),
            label: "X".into(),
            keys: founders(),
            quorum: 2,
            unlock: Unlock::Immediate,
            decay: Some(DecayConfig { step_blocks: 1000, floor_quorum: 1 }),
        };
        assert!(matches!(expand_decay(&leaf), Err(PolicyError::DecayRequiresTimelock)));
    }

    #[test]
    fn find_key_reuse_detects_a_key_in_two_leaves_and_ignores_a_key_in_one() {
        let shared = founders()[0];
        let leaves = vec![
            Leaf {
                id: "primary".into(),
                label: "Founders".into(),
                keys: founders(),
                quorum: 2,
                unlock: Unlock::Immediate,
                decay: None,
            },
            Leaf {
                id: "protector".into(),
                label: "Protector".into(),
                keys: vec![shared],
                quorum: 1,
                unlock: Unlock::After { blocks: 150_000 },
                decay: None,
            },
        ];
        let notes = find_key_reuse(&leaves);
        assert_eq!(notes.len(), 1, "only the shared key should be reported");
        assert_eq!(notes[0].pubkey, shared);
        let mut ids = notes[0].leaf_ids.clone();
        ids.sort();
        assert_eq!(ids, vec!["primary".to_string(), "protector".to_string()]);
    }

    #[test]
    fn find_key_reuse_is_empty_when_every_leaf_has_distinct_keys() {
        let policy_leaves = vec![
            Leaf {
                id: "primary".into(),
                label: "Founders".into(),
                keys: founders(),
                quorum: 2,
                unlock: Unlock::Immediate,
                decay: None,
            },
            Leaf {
                id: "inheritance".into(),
                label: "Inheritance".into(),
                keys: heirs(),
                quorum: 2,
                unlock: Unlock::After { blocks: 200_000 },
                decay: None,
            },
        ];
        assert!(find_key_reuse(&policy_leaves).is_empty());
    }

    #[test]
    fn consent_gates_only_the_primary_leaf() {
        let consenter = heirs()[0];
        let policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Founders".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "recovery".into(),
                    label: "Recovery".into(),
                    keys: founders(),
                    quorum: 1,
                    unlock: Unlock::After { blocks: 100_000 },
                    decay: None,
                },
            ],
            consent_keys: vec![consenter],
            consent_quorum: Some(1),
        };
        let out = build_leaf_multileaf(&policy).unwrap();
        let consenter_xonly = consenter.inner.x_only_public_key().0.serialize();
        let primary = &out.leaf_scripts.iter().find(|(id, _)| id == "primary").unwrap().1;
        let recovery = &out.leaf_scripts.iter().find(|(id, _)| id == "recovery").unwrap().1;
        assert!(
            primary.as_bytes().windows(32).any(|w| w == consenter_xonly),
            "consent key must gate the primary leaf"
        );
        assert!(
            !recovery.as_bytes().windows(32).any(|w| w == consenter_xonly),
            "consent must not leak into the recovery leaf -- it exists precisely to rescue funds when a beneficiary won't cosign"
        );
    }

    // The remaining named-branch shapes build_multileaf hand-writes,
    // proven byte-identical against build_leaf_multileaf the same way
    // plain_leaf_policy_... and standard_three_leaf_policy_... above do.
    // Together with those two, every one of build_multileaf's 8 return
    // points now has a byte-identical proof.

    fn backups() -> Vec<PublicKey> {
        vec![pk("03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe")]
    }
    fn second_heirs() -> Vec<PublicKey> {
        vec![pk("03fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556")]
    }

    #[test]
    fn backup_only_shape_no_inheritance_produces_byte_identical_leaves_to_the_named_branch_path() {
        let old = DynastyPolicy {
            founder_keys: founders(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: vec![],
            heir_quorum: 0,
            recovery_after: 0,
            inheritance_after: 0,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: backups(),
            backup_quorum: Some(1),
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        };
        let old_out = build_multileaf(&old).unwrap();

        let new_policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Founders".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "backup".into(),
                    label: "Backup".into(),
                    keys: backups(),
                    quorum: 1,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        let new_out = build_leaf_multileaf(&new_policy).unwrap();

        assert_eq!(new_out.founder_leaf, old_out.founder_leaf, "founder leaf script");
        assert_eq!(
            new_out.leaf_scripts.iter().find(|(id, _)| id == "backup").map(|(_, s)| s.clone()),
            old_out.recovery_leaf,
            "the named branch stores the untimelocked backup leaf under recovery_leaf -- see MultileafOutput's doc comment"
        );
        assert_eq!(new_out.descriptor, old_out.descriptor);
        assert_eq!(new_out.spend_info.output_key(), old_out.spend_info.output_key());
    }

    #[test]
    fn gift_locker_shape_produces_byte_identical_leaves_to_the_named_branch_path() {
        let old = DynastyPolicy {
            founder_keys: founders(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: heirs(),
            heir_quorum: 2,
            recovery_after: 0,
            inheritance_after: 200_000,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: vec![],
            second_heir_quorum: None,
            second_inheritance_after: None,
        };
        let old_out = build_multileaf(&old).unwrap();

        let new_policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Founders".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "inheritance".into(),
                    label: "Inheritance".into(),
                    keys: heirs(),
                    quorum: 2,
                    unlock: Unlock::After { blocks: 200_000 },
                    decay: None,
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        let new_out = build_leaf_multileaf(&new_policy).unwrap();

        assert_eq!(new_out.founder_leaf, old_out.founder_leaf);
        assert_eq!(
            new_out.leaf_scripts.iter().find(|(id, _)| id == "inheritance").map(|(_, s)| s.clone()),
            old_out.inheritance_leaf,
        );
        assert_eq!(new_out.descriptor, old_out.descriptor);
        assert_eq!(new_out.spend_info.output_key(), old_out.spend_info.output_key());
    }

    #[test]
    fn gift_locker_with_second_inheritance_produces_byte_identical_leaves_to_the_named_branch_path() {
        let old = DynastyPolicy {
            founder_keys: founders(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: heirs(),
            heir_quorum: 2,
            recovery_after: 0,
            inheritance_after: 200_000,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: second_heirs(),
            second_heir_quorum: Some(1),
            second_inheritance_after: Some(300_000),
        };
        let old_out = build_multileaf(&old).unwrap();

        let new_policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Founders".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "inheritance".into(),
                    label: "Inheritance".into(),
                    keys: heirs(),
                    quorum: 2,
                    unlock: Unlock::After { blocks: 200_000 },
                    decay: None,
                },
                Leaf {
                    id: "second_inheritance".into(),
                    label: "Second inheritance".into(),
                    keys: second_heirs(),
                    quorum: 1,
                    unlock: Unlock::After { blocks: 300_000 },
                    decay: None,
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        let new_out = build_leaf_multileaf(&new_policy).unwrap();

        assert_eq!(new_out.founder_leaf, old_out.founder_leaf);
        assert_eq!(
            new_out.leaf_scripts.iter().find(|(id, _)| id == "inheritance").map(|(_, s)| s.clone()),
            old_out.inheritance_leaf,
        );
        assert_eq!(
            new_out.leaf_scripts.iter().find(|(id, _)| id == "second_inheritance").map(|(_, s)| s.clone()),
            old_out.second_inheritance_leaf,
        );
        assert_eq!(new_out.descriptor, old_out.descriptor);
        assert_eq!(new_out.spend_info.output_key(), old_out.spend_info.output_key());
    }



    #[test]
    fn second_inheritance_without_protector_produces_byte_identical_leaves_to_the_named_branch_path() {
        let old = DynastyPolicy {
            founder_keys: founders(),
            founder_quorum: 2,
            recovery_quorum: None,
            heir_keys: heirs(),
            heir_quorum: 2,
            recovery_after: 100_000,
            inheritance_after: 200_000,
            consent_keys: vec![],
            consent_quorum: None,
            backup_keys: vec![],
            backup_quorum: None,
            second_heir_keys: second_heirs(),
            second_heir_quorum: Some(1),
            second_inheritance_after: Some(300_000),
        };
        let old_out = build_multileaf(&old).unwrap();

        let new_policy = LeafPolicy {
            leaves: vec![
                Leaf {
                    id: "primary".into(),
                    label: "Founders".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::Immediate,
                    decay: None,
                },
                Leaf {
                    id: "recovery".into(),
                    label: "Recovery".into(),
                    keys: founders(),
                    quorum: 2,
                    unlock: Unlock::After { blocks: 100_000 },
                    decay: None,
                },
                Leaf {
                    id: "inheritance".into(),
                    label: "Inheritance".into(),
                    keys: heirs(),
                    quorum: 2,
                    unlock: Unlock::After { blocks: 200_000 },
                    decay: None,
                },
                Leaf {
                    id: "second_inheritance".into(),
                    label: "Second inheritance".into(),
                    keys: second_heirs(),
                    quorum: 1,
                    unlock: Unlock::After { blocks: 300_000 },
                    decay: None,
                },
            ],
            consent_keys: vec![],
            consent_quorum: None,
        };
        let new_out = build_leaf_multileaf(&new_policy).unwrap();

        assert_eq!(new_out.founder_leaf, old_out.founder_leaf);
        assert_eq!(
            new_out.leaf_scripts.iter().find(|(id, _)| id == "recovery").map(|(_, s)| s.clone()),
            old_out.recovery_leaf,
        );
        assert_eq!(
            new_out.leaf_scripts.iter().find(|(id, _)| id == "inheritance").map(|(_, s)| s.clone()),
            old_out.inheritance_leaf,
        );
        assert_eq!(
            new_out.leaf_scripts.iter().find(|(id, _)| id == "second_inheritance").map(|(_, s)| s.clone()),
            old_out.second_inheritance_leaf,
        );
        assert_eq!(new_out.descriptor, old_out.descriptor);
        assert_eq!(new_out.spend_info.output_key(), old_out.spend_info.output_key());
    }
}
