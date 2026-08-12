//! # DynastyTrust Governance Engine
//!
//! This module implements the governance logic for dynasty vaults:
//! determining which spending paths are currently active, coordinating
//! multi-party signing proposals, tracking signature collection, and
//! evaluating policy compliance for any proposed spend.
//!
//! ## Architecture
//!
//! The governance engine is **stateless** — it takes a vault's policy
//! parameters plus current context (block height, collected signatures)
//! and returns a deterministic ruling. State (proposals, signatures) is
//! stored in the Supabase database; the engine provides the logic.
//!
//! ## Spending Paths
//!
//! A standard dynasty vault has three spending paths:
//!
//! ```text
//! Path A — Founders Now:    thresh(Q_f, pk(f1), pk(f2), ...)
//! Path B — Recovery:        and(after(R), thresh(Q_f, ...))
//! Path C — Inheritance:     and(after(I), thresh(Q_h, pk(h1), ...))
//! ```
//!
//! At any block height, paths B and/or C may or may not be unlocked.
//!
//! A "Gift Locker"-shaped vault (`recovery_after == 0`, the same
//! sentinel `DynastyPolicy::has_recovery()` uses in policy_compiler.rs)
//! has only Path A and Path C -- Recovery never appears in
//! `active_paths` and is rejected as a proposed spend path regardless of
//! block height, since no such leaf exists in its descriptor.

use serde::{Deserialize, Serialize};

// ── Core types ────────────────────────────────────────────────────────────────

/// Identifies which of the three dynasty spending paths to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpendingPath {
    /// Founders spend immediately — no timelock.
    FoundersNow,
    /// Founders spend via the recovery branch (timelock must be satisfied).
    Recovery,
    /// Heirs spend via the inheritance branch (timelock must be satisfied).
    Inheritance,
}

impl std::fmt::Display for SpendingPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FoundersNow  => write!(f, "Founders (immediate)"),
            Self::Recovery     => write!(f, "Founder Recovery"),
            Self::Inheritance  => write!(f, "Heir Inheritance"),
        }
    }
}

/// The current governance state of a vault at a given block height.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStatus {
    /// Current block height used for evaluation.
    pub current_block: u32,
    /// Which paths are currently spendable.
    pub active_paths: Vec<SpendingPath>,
    /// Human-readable description of vault status.
    pub status_label: String,
    /// Blocks until recovery path unlocks (None if already unlocked).
    pub blocks_until_recovery: Option<u32>,
    /// Blocks until inheritance path unlocks (None if already unlocked).
    pub blocks_until_inheritance: Option<u32>,
    /// Approximate days until recovery (None if unlocked).
    pub days_until_recovery: Option<f64>,
    /// Approximate days until inheritance (None if unlocked).
    pub days_until_inheritance: Option<f64>,
    /// Phase label for UI display.
    pub phase: VaultPhase,
}

/// High-level vault lifecycle phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultPhase {
    /// Only founders-now path is active.
    Active,
    /// Recovery path has unlocked; founders-now still active.
    RecoveryUnlocked,
    /// Inheritance path has unlocked; all paths active.
    InheritanceUnlocked,
}

impl std::fmt::Display for VaultPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Active              => write!(f, "Active"),
            Self::RecoveryUnlocked   => write!(f, "Recovery Unlocked"),
            Self::InheritanceUnlocked => write!(f, "Inheritance Unlocked"),
        }
    }
}

/// Parameters needed to evaluate vault governance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultPolicy {
    pub founder_quorum:    usize,
    pub founder_key_count: usize,
    pub heir_quorum:       usize,
    pub heir_key_count:    usize,
    pub recovery_after:    u32,
    pub inheritance_after: u32,
}

// ── Status evaluation ─────────────────────────────────────────────────────────

const BLOCKS_PER_DAY: f64 = 144.0;

/// Evaluate which spending paths are active at `current_block`.
///
/// `current_block` is the CURRENT CHAIN TIP HEIGHT (absolute). DynastyTrust
/// timelocks are absolute CLTV (`after(N)` => OP_CHECKLOCKTIMEVERIFY), so a
/// timelocked path unlocks once the chain tip reaches the absolute height
/// baked into the leaf -- NOT relative to the UTXO's confirmation age. Do not
/// pass UTXO age here; pass the chain tip height. (See CLAUDE.md "Timelocks
/// are absolute CLTV". The wire/DB field that feeds this is still named
/// `utxo_age_blocks` for back-compat; despite the legacy name it carries the
/// chain tip height. Renaming that persisted field is a separate migration.)
pub fn evaluate_vault_status(
    policy: &VaultPolicy,
    current_block: u32,
) -> VaultStatus {
    // recovery_after == 0 is a "Gift Locker"-shaped vault (see module
    // doc comment): no recovery leaf exists in the descriptor at all,
    // so `current_block >= 0` (always true) must NOT be read as
    // "recovery is unlocked" -- that would show a phantom spending
    // path the PSBT builder would then refuse to actually build.
    let has_recovery         = policy.recovery_after > 0;
    let recovery_unlocked    = has_recovery && current_block >= policy.recovery_after;
    let inheritance_unlocked = current_block >= policy.inheritance_after;

    let mut active_paths = vec![SpendingPath::FoundersNow];
    if recovery_unlocked    { active_paths.push(SpendingPath::Recovery); }
    if inheritance_unlocked { active_paths.push(SpendingPath::Inheritance); }

    let phase = if inheritance_unlocked {
        VaultPhase::InheritanceUnlocked
    } else if recovery_unlocked {
        VaultPhase::RecoveryUnlocked
    } else {
        VaultPhase::Active
    };

    let blocks_until_recovery = if !has_recovery || recovery_unlocked {
        None
    } else {
        Some(policy.recovery_after - current_block)
    };

    let blocks_until_inheritance = if inheritance_unlocked {
        None
    } else {
        Some(policy.inheritance_after - current_block)
    };

    let status_label = match phase {
        VaultPhase::Active if has_recovery =>
            format!(
                "Active — founders can spend. Recovery unlocks in ~{} days.",
                blocks_until_recovery.map(|b| (b as f64 / BLOCKS_PER_DAY) as u32).unwrap_or(0)
            ),
        VaultPhase::Active =>
            format!(
                "Active — founders can spend. Gift unlocks in ~{} days.",
                blocks_until_inheritance.map(|b| (b as f64 / BLOCKS_PER_DAY) as u32).unwrap_or(0)
            ),
        VaultPhase::RecoveryUnlocked =>
            format!(
                "Recovery path unlocked. Inheritance unlocks in ~{} days.",
                blocks_until_inheritance.map(|b| (b as f64 / BLOCKS_PER_DAY) as u32).unwrap_or(0)
            ),
        VaultPhase::InheritanceUnlocked =>
            "All paths unlocked. Founders and heirs can spend.".to_string(),
    };

    VaultStatus {
        current_block,
        active_paths,
        status_label,
        blocks_until_recovery,
        blocks_until_inheritance,
        days_until_recovery:    blocks_until_recovery.map(|b| b as f64 / BLOCKS_PER_DAY),
        days_until_inheritance: blocks_until_inheritance.map(|b| b as f64 / BLOCKS_PER_DAY),
        phase,
    }
}

// ── Spend proposal ────────────────────────────────────────────────────────────

/// The result of evaluating whether a proposed spend is currently valid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpendEvaluation {
    pub allowed: bool,
    pub path: SpendingPath,
    pub required_signers: usize,
    pub provided_signers: usize,
    pub missing_signers: usize,
    pub timelock_satisfied: bool,
    pub quorum_satisfied: bool,
    pub reason: String,
    /// Ordered list of which signer indices (0-based) still need to sign.
    pub pending_signer_indices: Vec<usize>,
}

/// Represents one signer's contribution to a proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignerStatus {
    /// 0-based index into the relevant key array (founder_keys or heir_keys).
    pub index: usize,
    /// Whether this signer has provided a valid signature.
    pub signed: bool,
    /// Optional label (e.g. "Coldcard #1", "Alice", etc.)
    pub label: Option<String>,
}

/// Evaluate whether a proposed spend on `path` is valid.
///
/// `utxo_age_blocks`: legacy field name -- this is the CURRENT CHAIN TIP HEIGHT
/// (absolute), not UTXO age. Timelocks are absolute CLTV, so a timelocked path
/// is satisfied once the tip reaches the stored absolute unlock height.
/// `signer_statuses`: which signers have already contributed signatures.
pub fn evaluate_spend_proposal(
    policy: &VaultPolicy,
    path: SpendingPath,
    utxo_age_blocks: u32,
    signer_statuses: &[SignerStatus],
) -> SpendEvaluation {
    // recovery_after == 0 means this vault has no recovery leaf at all
    // (the "Gift Locker" shape -- see module doc comment); a Recovery
    // spend must never be reported satisfied just because
    // `utxo_age_blocks >= 0` is trivially true. The PSBT builder
    // already refuses to attach a nonexistent recovery leaf, so this
    // keeps the evaluation consistent with what can actually be built.
    let has_recovery = policy.recovery_after > 0;
    let timelock_satisfied = match path {
        SpendingPath::FoundersNow => true,
        SpendingPath::Recovery    => has_recovery && utxo_age_blocks >= policy.recovery_after,
        SpendingPath::Inheritance => utxo_age_blocks >= policy.inheritance_after,
    };

    let required_signers = match path {
        SpendingPath::FoundersNow | SpendingPath::Recovery => policy.founder_quorum,
        SpendingPath::Inheritance => policy.heir_quorum,
    };

    let signed_count = signer_statuses.iter().filter(|s| s.signed).count();
    let quorum_satisfied = signed_count >= required_signers;
    let missing_signers = required_signers.saturating_sub(signed_count);
    let allowed = timelock_satisfied && quorum_satisfied;

    let pending_signer_indices: Vec<usize> = signer_statuses.iter()
        .filter(|s| !s.signed)
        .map(|s| s.index)
        .collect();

    let reason = if allowed {
        format!(
            "{path} spend is valid. {signed_count} of {required_signers} required signatures collected."
        )
    } else if path == SpendingPath::Recovery && !has_recovery {
        "This vault has no separate recovery path -- founders spend via Founders Now at any time.".to_string()
    } else if !timelock_satisfied {
        let needed = match path {
            SpendingPath::Recovery    => policy.recovery_after.saturating_sub(utxo_age_blocks),
            SpendingPath::Inheritance => policy.inheritance_after.saturating_sub(utxo_age_blocks),
            SpendingPath::FoundersNow => 0,
        };
        format!(
            "Timelock not yet satisfied. Chain must reach the unlock height -- {needed} more blocks (~{:.0} days).",
            needed as f64 / BLOCKS_PER_DAY
        )
    } else {
        format!(
            "Quorum not met. Need {missing_signers} more signature(s). Have {signed_count} of {required_signers}."
        )
    };

    SpendEvaluation {
        allowed,
        path,
        required_signers,
        provided_signers: signed_count,
        missing_signers,
        timelock_satisfied,
        quorum_satisfied,
        reason,
        pending_signer_indices,
    }
}

// ── Signing coordination ──────────────────────────────────────────────────────

/// Recommended signing order for a given path and number of signers.
/// Returns signer indices ordered by priority (first should sign first).
/// For now this is just sequential; future versions could weight by
/// hardware type, availability, or key importance.
pub fn signing_order(path: SpendingPath, total_signers: usize) -> Vec<usize> {
    let _ = path; // reserved for future path-specific ordering
    (0..total_signers).collect()
}

/// Summarise what the next action should be for a pending proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextAction {
    /// Who needs to act (signer index).
    pub signer_index: Option<usize>,
    /// Human-readable instruction.
    pub instruction: String,
    /// Whether the proposal is ready to broadcast.
    pub ready_to_broadcast: bool,
}

pub fn next_action(eval: &SpendEvaluation) -> NextAction {
    if eval.allowed {
        return NextAction {
            signer_index: None,
            instruction: "All signatures collected. Transaction is ready to broadcast.".to_string(),
            ready_to_broadcast: true,
        };
    }

    if !eval.timelock_satisfied {
        return NextAction {
            signer_index: None,
            instruction: eval.reason.clone(),
            ready_to_broadcast: false,
        };
    }

    let next = eval.pending_signer_indices.first().copied();
    let instr = match next {
        Some(i) => format!(
            "Waiting for signer #{} to sign the PSBT. Share the PSBT QR code with them.",
            i + 1
        ),
        None => "No pending signers identified.".to_string(),
    };

    NextAction {
        signer_index: next,
        instruction: instr,
        ready_to_broadcast: false,
    }
}

// ── Policy rule engine ────────────────────────────────────────────────────────

/// A governance rule that can be checked against a proposed action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GovernanceRule {
    pub id:          String,
    pub description: String,
    pub severity:    RuleSeverity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleSeverity {
    /// Must not be violated — spend is blocked.
    Hard,
    /// Should not be violated — triggers a warning but does not block.
    Soft,
    /// Informational only.
    Info,
}

/// Result of running all governance rules against a proposed spend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GovernanceAudit {
    pub violations: Vec<GovernanceViolation>,
    pub warnings:   Vec<GovernanceViolation>,
    pub notes:      Vec<GovernanceViolation>,
    pub approved:   bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GovernanceViolation {
    pub rule:    GovernanceRule,
    pub detail:  String,
}

/// Proposed spend parameters — passed to the rule engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedSpend {
    pub path:             SpendingPath,
    pub amount_sats:      u64,
    pub destination:      String,
    /// Legacy field name -- carries the CURRENT CHAIN TIP HEIGHT (absolute),
    /// not UTXO age. Timelocks are absolute CLTV; see `evaluate_spend_proposal`.
    pub utxo_age_blocks:  u32,
    pub signer_statuses:  Vec<SignerStatus>,
    pub total_vault_sats: u64,
}

/// Run all governance rules against a proposed spend.
/// Returns a full audit trail with violations, warnings, and approval status.
pub fn audit_spend(policy: &VaultPolicy, spend: &ProposedSpend) -> GovernanceAudit {
    let mut violations = Vec::new();
    let mut warnings   = Vec::new();
    let mut notes      = Vec::new();

    let add = |bucket: &mut Vec<GovernanceViolation>, id: &str, desc: &str, sev: RuleSeverity, detail: String| {
        bucket.push(GovernanceViolation {
            rule: GovernanceRule { id: id.to_string(), description: desc.to_string(), severity: sev },
            detail,
        });
    };

    // Rule 1: Timelock must be satisfied for non-immediate paths.
    // recovery_after == 0 means this vault has no recovery leaf at all
    // (the "Gift Locker" shape -- see evaluate_spend_proposal's doc
    // comment above); without this guard a Recovery spend on such a
    // vault was reported timelock-satisfied because utxo_age_blocks >= 0
    // is trivially true, contradicting evaluate_spend_proposal's own
    // `has_recovery` gate for the identical path/policy pair.
    let has_recovery = policy.recovery_after > 0;
    let timelock_ok = match spend.path {
        SpendingPath::FoundersNow => true,
        SpendingPath::Recovery    => has_recovery && spend.utxo_age_blocks >= policy.recovery_after,
        SpendingPath::Inheritance => spend.utxo_age_blocks >= policy.inheritance_after,
    };
    if !timelock_ok {
        add(&mut violations, "GOV-001", "Timelock not satisfied", RuleSeverity::Hard,
            if spend.path == SpendingPath::Recovery && !has_recovery {
                "This vault has no separate recovery path -- founders spend via Founders Now at any time.".to_string()
            } else {
                format!("Current chain height {} is below the required unlock height {}", spend.utxo_age_blocks,
                    match spend.path {
                        SpendingPath::Recovery    => policy.recovery_after,
                        SpendingPath::Inheritance => policy.inheritance_after,
                        SpendingPath::FoundersNow => 0,
                    })
            }
        );
    }

    // Rule 2: Quorum must be met
    let eval = evaluate_spend_proposal(policy, spend.path, spend.utxo_age_blocks, &spend.signer_statuses);
    if !eval.quorum_satisfied {
        add(&mut violations, "GOV-002", "Quorum not satisfied", RuleSeverity::Hard,
            format!("Need {} signatures, have {}", eval.required_signers, eval.provided_signers));
    }

    // Rule 3: Dust limit
    if spend.amount_sats < 546 {
        add(&mut violations, "GOV-003", "Output below dust limit", RuleSeverity::Hard,
            format!("{} sats is below the 546 sat dust limit", spend.amount_sats));
    }

    // Rule 4: Amount exceeds vault balance
    if spend.amount_sats > spend.total_vault_sats {
        add(&mut violations, "GOV-004", "Insufficient vault balance", RuleSeverity::Hard,
            format!("Spend {} sats exceeds vault balance {} sats",
                spend.amount_sats, spend.total_vault_sats));
    }

    // Rule 5: Large spend warning (>50% of vault)
    if spend.total_vault_sats > 0
        && spend.amount_sats > spend.total_vault_sats / 2
    {
        add(&mut warnings, "GOV-005", "Large spend (>50% of vault)", RuleSeverity::Soft,
            format!("Spending {:.1}% of vault balance",
                (spend.amount_sats as f64 / spend.total_vault_sats as f64) * 100.0));
    }

    // Rule 6: Inheritance path used before founders — informational note
    if spend.path == SpendingPath::Inheritance {
        add(&mut notes, "GOV-006", "Inheritance path active", RuleSeverity::Info,
            "This spend uses the heir inheritance path. Ensure this reflects the intended estate transfer.".to_string());
    }

    // Rule 7: Recovery used while founders-now is available
    if spend.path == SpendingPath::Recovery {
        add(&mut notes, "GOV-007", "Recovery path used", RuleSeverity::Info,
            "Recovery path selected. This is typically used when primary signing devices are unavailable.".to_string());
    }

    // Rule 8: Single signer on a multi-sig vault
    if eval.provided_signers == 1 && eval.required_signers > 1 {
        add(&mut notes, "GOV-008", "Only one signer so far", RuleSeverity::Info,
            format!("{} more signature(s) still needed before this transaction can be broadcast.",
                eval.missing_signers));
    }

    let approved = violations.is_empty();

    GovernanceAudit { violations, warnings, notes, approved }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> VaultPolicy {
        VaultPolicy {
            founder_quorum: 2, founder_key_count: 3,
            heir_quorum: 2,    heir_key_count: 2,
            recovery_after: 26_000, inheritance_after: 52_560,
        }
    }

    fn signers(signed: &[usize], total: usize) -> Vec<SignerStatus> {
        (0..total).map(|i| SignerStatus {
            index: i, signed: signed.contains(&i), label: None,
        }).collect()
    }

    /// "Gift Locker" shape: no recovery leaf (recovery_after == 0).
    fn gift_locker_policy() -> VaultPolicy {
        VaultPolicy {
            founder_quorum: 2, founder_key_count: 2,
            heir_quorum: 1,    heir_key_count: 1,
            recovery_after: 0, inheritance_after: 52_560,
        }
    }

    #[test]
    fn active_phase_before_any_timelock() {
        let s = evaluate_vault_status(&policy(), 1_000);
        assert_eq!(s.phase, VaultPhase::Active);
        assert_eq!(s.active_paths, vec![SpendingPath::FoundersNow]);
        assert!(s.blocks_until_recovery.is_some());
        assert!(s.blocks_until_inheritance.is_some());
    }

    #[test]
    fn recovery_phase_after_recovery_timelock() {
        let s = evaluate_vault_status(&policy(), 30_000);
        assert_eq!(s.phase, VaultPhase::RecoveryUnlocked);
        assert!(s.active_paths.contains(&SpendingPath::Recovery));
        assert!(!s.active_paths.contains(&SpendingPath::Inheritance));
        assert!(s.blocks_until_recovery.is_none());
    }

    #[test]
    fn inheritance_phase_after_both_timelocks() {
        let s = evaluate_vault_status(&policy(), 60_000);
        assert_eq!(s.phase, VaultPhase::InheritanceUnlocked);
        assert!(s.active_paths.contains(&SpendingPath::Inheritance));
        assert!(s.blocks_until_recovery.is_none());
        assert!(s.blocks_until_inheritance.is_none());
    }

    #[test]
    fn founders_now_always_active() {
        for blocks in [0, 1_000, 26_000, 52_560, 100_000] {
            let s = evaluate_vault_status(&policy(), blocks);
            assert!(s.active_paths.contains(&SpendingPath::FoundersNow),
                "FoundersNow must always be active (block {})", blocks);
        }
    }

    #[test]
    fn gift_locker_never_shows_recovery_as_active() {
        // recovery_after == 0 must NOT be read as "recovery already
        // unlocked" -- there's no recovery leaf in this vault's
        // descriptor at all.
        for blocks in [0, 1_000, 26_000, 52_560, 100_000] {
            let s = evaluate_vault_status(&gift_locker_policy(), blocks);
            assert!(!s.active_paths.contains(&SpendingPath::Recovery),
                "Recovery must never be active for a Gift Locker vault (block {})", blocks);
            assert!(s.blocks_until_recovery.is_none(),
                "no recovery countdown to show (block {})", blocks);
        }
    }

    #[test]
    fn gift_locker_phase_is_active_then_inheritance_unlocked_never_recovery() {
        let before = evaluate_vault_status(&gift_locker_policy(), 1_000);
        assert_eq!(before.phase, VaultPhase::Active);

        let after = evaluate_vault_status(&gift_locker_policy(), 60_000);
        assert_eq!(after.phase, VaultPhase::InheritanceUnlocked);
    }

    #[test]
    fn gift_locker_recovery_spend_is_always_rejected() {
        let eval = evaluate_spend_proposal(
            &gift_locker_policy(),
            SpendingPath::Recovery,
            100_000, // far past any real timelock
            &signers(&[0, 1], 2),
        );
        assert!(!eval.allowed, "no recovery leaf exists to spend from");
        assert!(!eval.timelock_satisfied);
        assert!(eval.reason.contains("no separate recovery path"));
    }

    #[test]
    fn gift_locker_founders_now_and_inheritance_still_work_normally() {
        let now = evaluate_spend_proposal(
            &gift_locker_policy(), SpendingPath::FoundersNow, 0, &signers(&[0, 1], 2),
        );
        assert!(now.allowed);

        let too_early = evaluate_spend_proposal(
            &gift_locker_policy(), SpendingPath::Inheritance, 1_000, &signers(&[0], 1),
        );
        assert!(!too_early.allowed);
        assert!(!too_early.timelock_satisfied);

        let unlocked = evaluate_spend_proposal(
            &gift_locker_policy(), SpendingPath::Inheritance, 60_000, &signers(&[0], 1),
        );
        assert!(unlocked.allowed);
    }

    #[test]
    fn spend_allowed_with_quorum_no_timelock() {
        let eval = evaluate_spend_proposal(
            &policy(), SpendingPath::FoundersNow, 0, &signers(&[0, 1], 3));
        assert!(eval.allowed);
        assert!(eval.quorum_satisfied);
        assert!(eval.timelock_satisfied);
    }

    #[test]
    fn spend_blocked_quorum_not_met() {
        let eval = evaluate_spend_proposal(
            &policy(), SpendingPath::FoundersNow, 0, &signers(&[0], 3));
        assert!(!eval.allowed);
        assert!(!eval.quorum_satisfied);
        assert_eq!(eval.missing_signers, 1);
    }

    #[test]
    fn spend_blocked_timelock_not_met() {
        let eval = evaluate_spend_proposal(
            &policy(), SpendingPath::Recovery, 1_000, &signers(&[0, 1], 3));
        assert!(!eval.allowed);
        assert!(!eval.timelock_satisfied);
    }

    #[test]
    fn audit_approves_valid_spend() {
        let spend = ProposedSpend {
            path: SpendingPath::FoundersNow,
            amount_sats: 100_000,
            destination: "tb1p...".to_string(),
            utxo_age_blocks: 0,
            signer_statuses: signers(&[0, 1], 3),
            total_vault_sats: 1_000_000,
        };
        let audit = audit_spend(&policy(), &spend);
        assert!(audit.approved);
        assert!(audit.violations.is_empty());
    }

    #[test]
    fn audit_rejects_dust() {
        let spend = ProposedSpend {
            path: SpendingPath::FoundersNow,
            amount_sats: 100, // below dust
            destination: "tb1p...".to_string(),
            utxo_age_blocks: 0,
            signer_statuses: signers(&[0, 1], 3),
            total_vault_sats: 1_000_000,
        };
        let audit = audit_spend(&policy(), &spend);
        assert!(!audit.approved);
        assert!(audit.violations.iter().any(|v| v.rule.id == "GOV-003"));
    }

    #[test]
    fn audit_warns_large_spend() {
        let spend = ProposedSpend {
            path: SpendingPath::FoundersNow,
            amount_sats: 800_000, // 80% of vault
            destination: "tb1p...".to_string(),
            utxo_age_blocks: 0,
            signer_statuses: signers(&[0, 1], 3),
            total_vault_sats: 1_000_000,
        };
        let audit = audit_spend(&policy(), &spend);
        assert!(audit.approved); // no hard violations
        assert!(audit.warnings.iter().any(|w| w.rule.id == "GOV-005"));
    }

    #[test]
    fn audit_rejects_recovery_spend_on_a_gift_locker_vault() {
        // No recovery leaf exists on this policy (recovery_after == 0).
        // Before this fix, GOV-001's timelock check compared
        // utxo_age_blocks >= 0, which is trivially true, so audit_spend
        // reported this spend timelock-satisfied even though
        // evaluate_spend_proposal (called by GOV-002 just below it in
        // the same function) correctly refuses it. That contradiction --
        // audit.approved: true alongside evaluation.allowed: false for
        // the identical policy/path/height -- is what this test guards.
        let spend = ProposedSpend {
            path: SpendingPath::Recovery,
            amount_sats: 100_000,
            destination: "tb1p...".to_string(),
            utxo_age_blocks: 100_000, // far past any real timelock
            signer_statuses: signers(&[0, 1], 2),
            total_vault_sats: 1_000_000,
        };
        let audit = audit_spend(&gift_locker_policy(), &spend);
        assert!(!audit.approved, "no recovery leaf exists to spend from");
        assert!(audit.violations.iter().any(|v| v.rule.id == "GOV-001"),
            "GOV-001 must flag the missing recovery leaf, not just GOV-002's quorum check");
    }

    #[test]
    fn next_action_ready_when_all_signed() {
        let eval = evaluate_spend_proposal(
            &policy(), SpendingPath::FoundersNow, 0, &signers(&[0, 1], 3));
        let action = next_action(&eval);
        assert!(action.ready_to_broadcast);
    }

    #[test]
    fn next_action_identifies_pending_signer() {
        let eval = evaluate_spend_proposal(
            &policy(), SpendingPath::FoundersNow, 0, &signers(&[0], 3));
        let action = next_action(&eval);
        assert!(!action.ready_to_broadcast);
        assert!(action.signer_index.is_some());
    }
}
