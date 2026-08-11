// Vault shape data: the intent-driven templates a user picks from, plus
// the concrete "what if..." scenario playbooks and trust-doc boilerplate
// each one carries. Relocated out of PolicyBuilder.tsx (unchanged data)
// so both VaultWizard and any future surface can use it without importing
// a whole page component.

import type { TrustDoc } from './api';

export type VaultMode = 'plain' | 'inheritance';

// A concrete what-if playbook item tied to a specific template.
// Keeping trigger / outcome / actions distinct so trustees can
// quickly read the situation and see the steps that actually move
// money or unlock a path.
export interface Scenario {
  title: string;
  trigger: string;
  outcome: string;
  actions?: string[];
  severity?: "info" | "warn" | "danger";
}

export type VaultTemplate = {
  id: string;
  title: string;
  tagline: string;
  useCase: string;
  config: {
    mode: VaultMode;
    plannedFounders: number;
    founderQ: number;
    plannedHeirs: number;
    heirQ: number;
    recoveryAfter: number;
    inheritanceAfter: number;
    protectorEnabled?: boolean;
    protectorAfter?: number;
    protectorQ?: number;
    plannedProtectors?: number;
    consentEnabled?: boolean;
    consentQ?: number;
    plannedConsenters?: number;
    /** "Anytime, harder" fallback (027_backup_path.sql) -- the owner's
     *  own SEPARATE, harder-to-reach key set, spendable immediately with
     *  no timelock. Occupies the same tree slot recoveryAfter would;
     *  mutually exclusive with it -- a template (or the wizard) must
     *  never set both. */
    backupEnabled?: boolean;
    backupQ?: number;
    plannedBackups?: number;
    /** Second, independent inheritance leaf (2026-08-11) -- see
     *  StandardConfig's doc comment above. */
    secondInheritanceEnabled?: boolean;
    secondInheritanceAfter?: number;
    secondHeirQ?: number;
    plannedSecondHeirs?: number;
  };
  scenarios: Scenario[];
  /**
   * Default trust-document clauses matching the vault shape.
   * Saved to the vault's trust_doc field right after compile so the
   * trust doc editor opens with attorney-review-ready boilerplate
   * instead of a blank slate.
   */
  trustDoc?: TrustDoc;
  /**
   * Marks a template as the "ultra-short-timelock" variant used
   * for iteration: timelocks in dozens of blocks (hours, not
   * years) so signet / testnet can verify recovery + inheritance
   * paths end-to-end. Same shape can later be re-compiled at
   * production durations.
   */
  testMode?: boolean;
};

// The vault wizard's live, editable config for each shape -- seeded from
// a VaultTemplate's `config` (see templateToStandardConfig in
// pages/VaultWizard.tsx) but able to drift from it as the user tunes
// quorums and timelocks. Lives here rather than in VaultWizard.tsx so
// lib/trust-doc.ts (which needs these shapes to compute a vault-specific
// document from the REAL numbers, not the template's defaults) can import
// them without a lib-importing-from-pages layering violation.
export interface StandardConfig {
  mode: VaultMode;
  plannedFounders: number;
  founderQ: number;
  plannedHeirs: number;
  heirQ: number;
  // "Gift Locker"-shaped vaults (founders-now OR a single timelocked
  // beneficiary path, no separate founders-after-a-delay recovery leaf
  // in between) turn this off -- see DynastyPolicy::has_recovery() in
  // protocol/src/policy_compiler.rs. When false, recoveryAfter is never
  // sent to the compiler (forced to 0 in VaultWizard's confirmConfigure()).
  recoveryEnabled: boolean;
  recoveryAfter: number;
  inheritanceAfter: number;
  protectorEnabled: boolean;
  protectorAfter: number;
  protectorQ: number;
  plannedProtectors: number;
  consentEnabled: boolean;
  consentQ: number;
  plannedConsenters: number;
  // "Anytime, harder" -- an owner-only, untimelocked fallback over a
  // SEPARATE key set, occupying the same tree slot recoveryEnabled
  // would. Mutually exclusive with it (VaultWizard turns recoveryEnabled
  // off when this turns on, and vice versa) -- the compiler rejects a
  // policy that sets both. plannedHeirs may be 0 alongside this: a vault
  // can be founders-now + backup only, no third leaf at all.
  backupEnabled: boolean;
  backupQ: number;
  plannedBackups: number;
  // Second, independent inheritance leaf (2026-08-11) -- a distinct heir
  // cohort with its own key set, quorum, and absolute timelock alongside
  // the primary heir_keys/heirQ/inheritanceAfter leaf. Requires
  // plannedHeirs > 0 -- the compiler rejects a second cohort without a
  // first (SecondInheritanceRequiresInheritance). Deliberately unordered
  // relative to inheritanceAfter: either shorter or longer is valid.
  secondInheritanceEnabled: boolean;
  secondInheritanceAfter: number;
  secondHeirQ: number;
  plannedSecondHeirs: number;
}

export interface BlocConfig {
  plannedParents: number;
  parentsTogetherQ: number;
  coparentQ: number;
  kidsWithParentQ: number;
  parentSoloQ: number;
  parentSoloAfter: number;
  plannedKids: number;
  kidsDecayStartQ: number;
  kidsDecayFloorQ: number;
  kidsDecayStartAfter: number;
  kidsDecayStepBlocks: number;
}

export const VAULT_TEMPLATES: VaultTemplate[] = [
  {
    id: 'solo-savings',
    title: 'Solo Savings',
    tagline: '1-of-1 . No timelocks',
    useCase:
      'One person, one seed. Simplest possible Bitcoin wallet. Back up the seed on metal; no inheritance path.',
    config: {
      mode: 'plain',
      plannedFounders: 1,
      founderQ: 1,
      plannedHeirs: 0,
      heirQ: 1,
      recoveryAfter: 0,
      inheritanceAfter: 0,
    },
    scenarios: [
      {
        title: 'You lose your seed',
        trigger: 'Device fails and you never wrote the seed words down.',
        outcome: 'Funds are gone. There is no recovery path in this template.',
        actions: [
          'Keep at least two metal backups of the seed before you fund the vault.',
          'If you only have plaintext backups, move to a Lost-Device Insurance vault instead.',
        ],
        severity: 'danger',
      },
      {
        title: 'You die',
        trigger: 'You pass away without your heirs knowing where the seed is.',
        outcome:
          'Bitcoin has no inheritance path in this template. Heirs need the seed words to recover.',
        actions: [
          'Leave the seed location in your legal will (not the words themselves).',
          'Consider upgrading to a Family Inheritance template for on-chain inheritance.',
        ],
        severity: 'warn',
      },
    ],
    trustDoc: {
      purpose:
        "Personal Bitcoin savings vault for long-term holding. Single-signer wallet with no on-chain inheritance path; off-chain seed backups are the only recovery mechanism.",
      distribution_rules:
        "Holder spends at their discretion. No formal distribution schedule.",
      succession_notes:
        "Back up the seed on metal and store in at least two geographically separated locations (e.g. home safe + safe-deposit box). Leave the seed LOCATION in a sealed envelope with your attorney or in your legal will -- do NOT write the seed words in the will itself. On death, heirs must physically retrieve the seed to recover funds.",
    },
  },
  {
    id: 'couples',
    title: 'Couples',
    tagline: '2-of-2 . Both spouses sign',
    useCase:
      'Two partners jointly custody the stack. Every spend needs both signatures. No timelocks -- if one loses their key, recovery requires restoring from backup.',
    config: {
      mode: 'plain',
      plannedFounders: 2,
      founderQ: 2,
      plannedHeirs: 0,
      heirQ: 1,
      recoveryAfter: 0,
      inheritanceAfter: 0,
    },
    scenarios: [
      {
        title: 'One spouse loses their key',
        trigger: "A device fails, a seed card is lost, or a key gets corrupted.",
        outcome:
          "You cannot spend without restoring the lost key. Assets are safe but immobile until recovery.",
        actions: [
          "Restore the lost key from its metal / paper backup into a new device.",
          "If no backup exists, sweep what you have after recovery and move to a Lost-Device Insurance template.",
        ],
        severity: 'warn',
      },
      {
        title: 'Divorce or serious disagreement',
        trigger: "One spouse refuses to cooperate on any spend.",
        outcome:
          "Funds are frozen. 2-of-2 cannot spend unless both agree; there is no timelock override.",
        actions: [
          "Negotiate or mediate; on-chain there is no way to bypass.",
          "For futures with possible disputes, use a Family Inheritance or Generational Trust template so neutral trustees / timelocks exist.",
        ],
        severity: 'danger',
      },
      {
        title: 'One spouse dies',
        trigger: "Surviving spouse holds their key but the deceased's is inaccessible.",
        outcome:
          "Bitcoin has no inheritance path here. Survivor needs the deceased's seed words.",
        actions: [
          "Before funding, exchange sealed seed backups stored where the survivor can find them (lawyer, safe-deposit, executor).",
          "For on-chain-enforced inheritance, use a Family Inheritance template.",
        ],
        severity: 'warn',
      },
    ],
    trustDoc: {
      purpose:
        "Joint Bitcoin savings vault for two partners. Every spend requires BOTH signatures; neither partner can move funds unilaterally.",
      distribution_rules:
        "All spends must be authorized by both signers. Each proposal should include a memo describing the spend.",
      succession_notes:
        "Exchange sealed seed backups stored with an attorney, in a joint safe-deposit box, or with a mutually-trusted executor. On the death of either partner, the survivor will need both seed backups to recover: the vault is not Bitcoin-inheritable in this shape. On divorce, assets are frozen until both parties cooperate to spend.",
    },
  },
  {
    id: 'family-inheritance',
    title: 'Family Inheritance',
    tagline: '2-of-3 trustees . 2-of-3 heirs . 6mo / 2yr',
    useCase:
      'Classic multi-generational setup. Three trustees share signing duty; after 6 months of trustee silence the same trustees can recover with a reduced quorum; after 2 years the heirs take over. Best starter shape for most families.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 3,
      heirQ: 2,
      recoveryAfter: 26_280, // ~6 months
      inheritanceAfter: 105_120, // ~2 years
    },
    scenarios: [
      {
        title: 'One trustee dies',
        trigger: "One of the three trustees passes away.",
        outcome:
          "The remaining two trustees can still sign normally on Path 1 (2-of-3 is still met). No timelock needed.",
        actions: [
          "The two remaining trustees sign the next spend as usual.",
          "Consider recompiling the vault with a new third trustee added, rotating in a successor.",
        ],
        severity: 'info',
      },
      {
        title: 'A trustee loses their key',
        trigger: "A trustee's device fails or seed is lost.",
        outcome:
          "Path 1 still works (the other two sign). Path 2 recovery after 6mo lets trustees spend with a reduced quorum if a second key is also lost.",
        actions: [
          "Spend normally using the other two trustees.",
          "Replace the lost key by recompiling into a new vault and sweeping funds.",
        ],
        severity: 'warn',
      },
      {
        title: 'Beneficiary needs urgent funds',
        trigger: "A family member asks for a distribution.",
        outcome:
          "Any 2 of 3 trustees can sign immediately on Path 1 -- no waiting, no timelock.",
        actions: [
          "Open the vault, tap Send, fill the distribution, and get two trustee signatures.",
          "Log the reason in the proposal memo so the audit trail captures it.",
        ],
        severity: 'info',
      },
      {
        title: 'All trustees go silent for 2 years',
        trigger: "No trustee has acted (or can be reached) for 2 years.",
        outcome:
          "The inheritance path unlocks: 2 of 3 heirs can move funds to a fresh vault under their control.",
        actions: [
          "Any two heirs sign on the inheritance path to sweep the vault.",
          "Recompile a new vault with the heirs as new trustees.",
        ],
        severity: 'info',
      },
      {
        title: 'Two trustees collude to steal',
        trigger: "Two of three trustees decide to take the funds for themselves.",
        outcome:
          "They can spend on Path 1 (quorum met). This template has no protector or beneficiary consent to block them.",
        actions: [
          "For significant estates, use the Generational Trust template instead -- it adds a protector path and optional beneficiary consent.",
          "At minimum, pick three trustees who don't all trust each other and who don't share a social circle.",
        ],
        severity: 'danger',
      },
    ],
    trustDoc: {
      purpose:
        "Multi-generational family Bitcoin trust. Three trustees manage distributions to beneficiaries during the grantor's lifetime. After a prolonged trustee silence (6 months the trustee quorum drops for recovery, 2 years the heir successors take over), on-chain paths unlock to ensure funds reach the next generation.",
      distribution_rules:
        "Trustees (2-of-3) may approve distributions consistent with the purposes below. Every proposal must cite a rule and include a memo. Distributions outside the listed rules require written justification and logging in the audit trail.",
      succession_notes:
        "Trustees are expected to meet at least annually to confirm signing keys are still accessible and to rotate any member who has become unreachable. If all trustees go silent for 2 years, the heir quorum will automatically inherit via the inheritance path. Trustees should replace themselves BEFORE relying on the timelock -- the on-chain inheritance is a backstop, not the primary mechanism.",
      rules: [
        {
          id: 'living-expenses',
          name: 'Living expenses',
          max_sats: 10_000_000,
          notes: 'Monthly household support up to ~0.1 BTC without extra documentation.',
          requires_comment: false,
        },
        {
          id: 'education',
          name: 'Education',
          notes: 'Tuition, books, and required living expenses during study. Attach receipts or enrollment proof in the memo.',
          requires_comment: true,
        },
        {
          id: 'medical-emergency',
          name: 'Medical / emergency',
          notes: 'Documented medical expenses or time-critical emergencies.',
          requires_comment: true,
        },
        {
          id: 'discretionary',
          name: 'Other / discretionary',
          notes: 'Any spend outside the above categories. Requires a written justification in the memo.',
          requires_comment: true,
        },
      ],
    },
  },
  {
    id: 'generational-trust',
    title: 'Generational Trust',
    tagline: '3-of-5 . protector . consent . 1yr / 3yr',
    useCase:
      'Institutional-grade: 5 independent trustees (3 needed), a protector who can rescue funds at 9 months, successors take over at 3 years. Every day-to-day spend also requires one beneficiary signature so the family has veto power without custody burden.',
    config: {
      mode: 'inheritance',
      plannedFounders: 5,
      founderQ: 3,
      plannedHeirs: 3,
      heirQ: 2,
      recoveryAfter: 52_560, // ~1 year
      inheritanceAfter: 157_680, // ~3 years
      protectorEnabled: true,
      protectorAfter: 39_420, // ~9 months
      protectorQ: 1,
      plannedProtectors: 1,
      consentEnabled: true,
      consentQ: 1,
      plannedConsenters: 1,
    },
    scenarios: [
      {
        title: 'Beneficiary refuses to cosign a spend',
        trigger: "A trustee proposes a distribution; the beneficiary does not add their signature.",
        outcome:
          "Path 1 is frozen -- the consent gate blocks it. Trustees must wait for recovery (1yr) or protector (9mo) to unlock an alternate path.",
        actions: [
          "Talk to the beneficiary, understand the objection, amend the proposal.",
          "If the beneficiary is incapacitated or missing, the protector can rescue funds at 9 months.",
          "If nothing is resolved, recovery at 1 year lets trustees spend without consent.",
        ],
        severity: 'warn',
      },
      {
        title: 'Trustees try to collude and steal',
        trigger: "3 trustees agree to take funds for themselves.",
        outcome:
          "Path 1 is blocked by beneficiary consent. They must wait for recovery (1yr) or try the protector path (9mo, but the protector holds that key).",
        actions: [
          "The beneficiary refuses to cosign -- the consent gate is doing its job.",
          "Alert the protector; at 9 months they sweep funds to a new vault.",
          "File any off-chain legal action; Bitcoin has already bought you time.",
        ],
        severity: 'danger',
      },
      {
        title: 'Protector steps in at 9 months',
        trigger: "Trustees have gone rogue or are unreachable; 9 months have elapsed.",
        outcome:
          "The protector path unlocks. The protector alone can move funds to a fresh vault with new trustees.",
        actions: [
          "Protector compiles a replacement vault first (new trustees, same heirs).",
          "Open the original vault, use the protector path to sweep to the new address.",
          "Record the reason in the audit trail for the attorney review.",
        ],
        severity: 'info',
      },
      {
        title: 'Trustee dies',
        trigger: "One of the 5 trustees passes away.",
        outcome:
          "3-of-5 is still achievable (4 remain). Spending continues normally.",
        actions: [
          "Replace by recompiling with a new fifth trustee; sweep to new vault.",
        ],
        severity: 'info',
      },
      {
        title: 'All silent for 3 years',
        trigger: "No trustee, protector, or beneficiary activity for 3 years.",
        outcome:
          "Inheritance path unlocks. Successor heirs (2 of 3) take over.",
        actions: [
          "Heirs sweep to a fresh vault that they control as the new trustees.",
        ],
        severity: 'info',
      },
    ],
    trustDoc: {
      purpose:
        "Institutional-grade multi-generational Bitcoin trust. Five independent trustees manage day-to-day distributions (3 signatures required), with a beneficiary-consent gate on every normal spend. An independent protector supervises the trustees and can rescue funds after 9 months if they act in bad faith. After 3 years of trustee silence, the heir quorum inherits.",
      distribution_rules:
        "Every day-to-day distribution requires the trustee quorum (3-of-5) AND at least one beneficiary signature (consent gate). If a beneficiary refuses to cosign, normal spends are frozen -- trustees may only fall back to the recovery path (1 year) or the protector path (9 months) if the protector intervenes. All proposals must cite a rule and include a memo for the audit trail.",
      succession_notes:
        "Trustees must hold quarterly video calls to confirm keys are accessible and to rotate any departing member. The protector's sole duty is to monitor for abuse and step in at the 9-month mark if trustees act in bad faith -- the protector should maintain a standby replacement vault so a sweep can happen quickly. After 3 years with no activity, the heir successors will inherit via the on-chain timelock.",
      rules: [
        {
          id: 'scheduled',
          name: 'Scheduled distribution',
          notes: 'Recurring distributions that match the trust schedule. Normally cosigned within 7 days.',
          requires_comment: false,
        },
        {
          id: 'discretionary',
          name: 'Discretionary',
          notes: 'Discretionary distributions outside the schedule. Trustees must document the basis in the memo.',
          requires_comment: true,
        },
        {
          id: 'emergency',
          name: 'Emergency',
          notes: 'Documented urgent need. Beneficiary consent still required.',
          requires_comment: true,
        },
        {
          id: 'trustee-fee',
          name: 'Trustee fee',
          notes: 'Quarterly administrative fee per the trust agreement.',
          requires_comment: false,
        },
      ],
    },
  },
  {
    id: 'business-treasury',
    title: 'Business Treasury',
    tagline: '3-of-5 . No heirs . No timelocks',
    useCase:
      'Corporate cold storage. Five directors hold keys; any three can authorize a spend. No inheritance path because the business persists. Add directors or rotate keys by recompiling when needed.',
    config: {
      mode: 'plain',
      plannedFounders: 5,
      founderQ: 3,
      plannedHeirs: 0,
      heirQ: 1,
      recoveryAfter: 0,
      inheritanceAfter: 0,
    },
    scenarios: [
      {
        title: 'One director leaves',
        trigger: "A key-holder resigns or is replaced.",
        outcome: "4 directors remain; 3-of-5 still achievable.",
        actions: [
          "Recompile into a new vault with a replacement director.",
          "Sweep funds from old vault to new before the departing director can collude (they still hold 1 of the 3 needed keys).",
        ],
        severity: 'warn',
      },
      {
        title: 'Director dispute',
        trigger: "A minority bloc (1 or 2 directors) disagrees with a spend.",
        outcome: "Any 3 of 5 can sign -- dissenters cannot block.",
        actions: [
          "Document the dispute in the proposal memo for corporate records.",
          "Run signing ceremony with any three willing directors.",
        ],
        severity: 'info',
      },
      {
        title: 'All keys lost',
        trigger: "A catastrophic loss of seed backups across multiple directors.",
        outcome: "Funds permanently unrecoverable. No timelock path in this template.",
        actions: [
          "Run regular signing drills (quarterly) to surface dead keys.",
          "Keep metal backups off-site and test restores yearly.",
          "For high-value treasuries, consider upgrading to Generational Trust shape with a recovery path.",
        ],
        severity: 'danger',
      },
    ],
    trustDoc: {
      purpose:
        "Corporate Bitcoin treasury. Five authorized directors hold signing keys; any three can authorize a spend on behalf of the company. Intended for long-term cold storage, not operational cash.",
      distribution_rules:
        "Every spend must be authorized by a board resolution. The proposal memo must reference the resolution number and the approved amount. Spends outside authorized resolutions will be declined by the remaining directors.",
      succession_notes:
        "Director turnover triggers a full vault recompile: generate a new vault with the updated director set and sweep funds within 30 days of the change. Each director holds one key stored in a hardware wallet kept off-site. Seeds are backed up on metal and stored in separately locked safes accessible only by the individual director and one trusted backup officer.",
      rules: [
        {
          id: 'opex',
          name: 'Operating expense',
          notes: 'Routine operational spends authorized under the operating budget resolution.',
          requires_comment: true,
        },
        {
          id: 'capex',
          name: 'Capital expense',
          notes: 'Large capital outlay requiring a specific board resolution referenced in the memo.',
          requires_comment: true,
        },
        {
          id: 'sweep',
          name: 'Sweep / rebalance',
          notes: 'Treasury rebalancing or sweep to another corporate cold-storage vault.',
          requires_comment: false,
        },
      ],
    },
  },
  {
    id: 'emergency-backup',
    title: 'Lost-Device Insurance',
    tagline: '2-of-3 . 6mo recovery',
    useCase:
      'Same-person multisig: you hold all three keys on three different devices. Need 2 to spend normally; after 6 months of silence you can spend with just 1. Saves the stack if one device is lost or destroyed.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 1,
      heirQ: 1,
      recoveryAfter: 26_280, // ~6 months
      inheritanceAfter: 52_560, // ~1 year
    },
    scenarios: [
      {
        title: 'Lose one device',
        trigger: "One of three devices fails or is lost.",
        outcome: "Other two devices still sign 2-of-3 on Path 1. No disruption.",
        actions: [
          "Spend normally with the remaining two.",
          "Buy a replacement device, recompile a fresh vault, sweep funds to it.",
        ],
        severity: 'info',
      },
      {
        title: 'Lose two devices',
        trigger: "Two of three devices lost simultaneously (house fire, theft, shipwreck).",
        outcome:
          "Path 1 is blocked (only 1 key left). Wait 6 months -> recovery path opens so the remaining 1 key can spend.",
        actions: [
          "Do not panic: funds are safe, just immobile for 6 months.",
          "After the timelock, sign with the surviving device on the recovery path.",
          "Sweep to a new Lost-Device Insurance vault you build fresh.",
        ],
        severity: 'warn',
      },
      {
        title: 'Seed stolen',
        trigger: "An attacker obtains one of your three seed backups.",
        outcome:
          "They have 1-of-3, which is not enough for Path 1. You have 6 months to act before the recovery path makes their 1 key sufficient.",
        actions: [
          "Immediately: build a new vault with fresh keys on new devices.",
          "Sign with your two remaining keys on Path 1, sweep funds to the new vault.",
          "Destroy any remaining old seeds (the compromised one is worthless once funds are moved).",
        ],
        severity: 'danger',
      },
      {
        title: 'Lose all three',
        trigger: "All three devices and backups destroyed.",
        outcome: "Funds permanently stuck.",
        actions: [
          "Always keep at least one metal backup of each seed off-site.",
          "Test the restore on each device quarterly.",
        ],
        severity: 'danger',
      },
    ],
    trustDoc: {
      purpose:
        "Same-person 2-of-3 multisig for device-loss insurance. The holder keeps all three keys on three different devices kept in geographically separated locations. Normal spends require any 2 keys; after 6 months of silence, any 1 key can spend via the recovery path.",
      distribution_rules:
        "Holder spends at their discretion using any 2 of 3 devices. No distributions to third parties by design.",
      succession_notes:
        "Store each device in a different secured location (home safe, safe-deposit box, trusted relative). Test seed restore on each device QUARTERLY; a dead seed that you only discover after losing a second device converts this vault from 2-of-3 into a brick. If a seed is stolen, immediately sweep to a new vault with fresh keys BEFORE the 6-month recovery timer makes a single stolen seed sufficient to spend.",
    },
  },

  {
    id: 'social-recovery',
    title: 'Self-Custody + Social Recovery',
    tagline: '2-of-3 you . 3-of-5 peers after 1yr',
    useCase:
      'You alone control the coins day to day with your own multisig (for example two hardware wallets plus one software key, 2-of-3). If you are ever locked out or go silent for a long time, a quorum of people you trust can rescue the funds -- but only after the timelock, and only as a group. Start with small amounts and a handful of close peers; the large-crowd version of this circle belongs off-chain as a FROST aggregate and is the later climb.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 5,
      heirQ: 3,
      recoveryAfter: 26_280, // ~6 months -- your own keys, lower-friction self-recovery
      inheritanceAfter: 52_560, // ~1 year -- the social-recovery leg unlocks for your peer quorum
    },
    scenarios: [
      {
        title: 'Everyday spending',
        trigger: 'You move funds normally.',
        outcome:
          'Your 2-of-3 signs on Path 1 instantly. No peer is involved and no one but you can move the coins.',
        actions: [
          'Spend with any two of your three keys.',
          'Moving the coins also refreshes the timelock -- see "You come back".',
        ],
        severity: 'info',
      },
      {
        title: 'Lose one of your own devices',
        trigger: 'One of your three keys is lost or destroyed.',
        outcome:
          'Your other two keys still sign 2-of-3 on Path 1. After ~6 months your own keys can also spend via the recovery path.',
        actions: [
          'Keep spending with the remaining two keys.',
          'Replace the device, build a fresh vault, and sweep funds to it.',
        ],
        severity: 'warn',
      },
      {
        title: 'You are locked out or go silent',
        trigger:
          'You lose enough of your own keys, are incapacitated, or simply stop touching the vault for a long time.',
        outcome:
          'After ~1 year with no activity, the social-recovery leg unlocks and a 3-of-5 quorum of your trusted peers can move the funds to rescue them.',
        actions: [
          'Your peers gather and sign 3-of-5 on the social-recovery path after the timelock.',
          'They sweep the funds to the destination named in your trust doc.',
          'Choose peers who will still be reachable years from now, and more than the quorum so a few being unavailable does not strand you.',
        ],
        severity: 'warn',
      },
      {
        title: 'A peer goes rogue',
        trigger: 'One of your five peers tries to take the funds, or you fear collusion.',
        outcome:
          'They cannot act: the social leg needs 3 of 5 AND stays locked until the ~1-year timelock passes, giving you a long window to react before any peer quorum could move a sat.',
        actions: [
          'While you are active the social leg is simply unspendable -- the timelock is your safety margin.',
          'If you distrust the circle, move the coins (which resets the clock) and rebuild with a new peer set.',
        ],
        severity: 'danger',
      },
      {
        title: 'You come back before the timelock',
        trigger: 'You were away but return before the social leg unlocks.',
        outcome:
          'Nothing was ever at risk. Moving the coins to a fresh vault output pushes the timelock back out ahead of you -- this is how the deadman stays armed without ever firing while you are alive.',
        actions: [
          'Spend or re-anchor the vault periodically to refresh the timelock.',
          'Treat a refresh like checking the batteries in a smoke detector.',
        ],
        severity: 'info',
      },
    ],
    trustDoc: {
      purpose:
        "Self-custody vault under the holder's sole control day to day (2-of-3 across the holder's own keys), with a timelocked social-recovery path that lets a 3-of-5 quorum of trusted peers rescue the funds only after a long period of holder inactivity. The peers cannot spend while the holder is active.",
      distribution_rules:
        'The holder spends at will using any 2 of their 3 keys on Path 1. The social-recovery quorum (3 of 5 peers) may spend ONLY after the social-recovery timelock elapses, and only to move funds to the recovery destination named below -- not for ordinary distributions.',
      succession_notes:
        'This template uses peers-spend-alone-after-timelock: once the social leg unlocks, the peer quorum can move funds without the holder. Pick peers who will still be reachable in years, and pick more than the quorum so a few being unavailable does not strand the recovery. The timelock is a safety margin against peer collusion, not an inheritance trigger; while active, the holder keeps it armed by periodically moving / re-anchoring the coins, which pushes the unlock height back out. Name the destination the peers should sweep to, and review the peer set whenever a relationship changes. The large-crowd version of this circle belongs off-chain as a FROST aggregate -- one on-chain key with many people behind it -- so start small and on-chain and climb to FROST as value grows.',
    },
  },

  {
    id: 'gift-locker',
    title: 'Gift Locker',
    tagline: '2-of-2 now . 1 gifted key after a set date',
    useCase:
      "Lock a gift for someone until a specific future date -- a graduation, a birthday, coming of age, a wedding. You (the gifter) and a co-signer (a lawyer or another family member) can spend normally at any time before then, for corrections or if plans change. The recipient holds one key of their own that, alone, unlocks the moment the date arrives -- no need to involve you or the co-signer once it opens. No middle recovery step: just now, or the gift date, nothing in between.",
    config: {
      mode: 'inheritance',
      plannedFounders: 2,
      founderQ: 2,
      plannedHeirs: 1,
      heirQ: 1,
      recoveryAfter: 0, // Gift Locker shape: no separate recovery leaf
      inheritanceAfter: 78_840, // ~18 months -- adjust to the real gift date at Configure
    },
    scenarios: [
      {
        title: 'You change your mind about the amount or the date',
        trigger: 'Plans change before the gift date arrives.',
        outcome:
          'You and the co-signer can spend together at any time on Path 1 -- move funds out, adjust the amount, or rebuild the vault with a new date.',
        actions: [
          'Sign a 2-of-2 spend with your co-signer to redirect or resize the gift.',
          'Recompile a fresh Gift Locker vault if the recipient or date changes.',
        ],
        severity: 'info',
      },
      {
        title: 'The gift date arrives',
        trigger: 'The chain reaches the specified unlock height.',
        outcome:
          "The recipient's single key alone can now spend -- no co-signer needed, no waiting on you.",
        actions: [
          'The recipient signs alone and sweeps to a wallet they control.',
          "Recommend they move it to their own fresh vault promptly rather than leaving it on this vault's address.",
        ],
        severity: 'info',
      },
      {
        title: 'You lose your key before the gift date',
        trigger: "You or the co-signer loses a device before the unlock height.",
        outcome:
          'Path 1 needs BOTH keys -- with one gone, neither of you can spend early. The gift is safe but frozen until the date arrives; there is no recovery leaf to fall back on in this shape.',
        actions: [
          'Wait for the gift date -- the recipient can still claim it on schedule regardless.',
          'If early access matters more to you than simplicity, use Family Inheritance or Lost-Device Insurance instead, which both include a recovery path.',
        ],
        severity: 'warn',
      },
      {
        title: 'The recipient loses their key before the gift date',
        trigger: "The recipient's device or backup is lost before the unlock height.",
        outcome:
          'No immediate problem -- Path 1 (you + co-signer) still works right up until the gift date. Replace the recipient key before that date arrives.',
        actions: [
          'You and the co-signer spend on Path 1 to move funds to a rebuilt Gift Locker with a fresh recipient key.',
          "Confirm the recipient's new backup is solid well before the original gift date.",
        ],
        severity: 'warn',
      },
    ],
    trustDoc: {
      purpose:
        'A timelocked gift: the gifter and a co-signer jointly control the funds until a specified future date, at which point the named recipient can claim it alone with their own key. No recovery path exists between the two -- only immediate (both signers) or delayed (recipient alone).',
      distribution_rules:
        'Before the gift date, only a joint spend (gifter + co-signer) may move funds, and only to redirect, resize, or rebuild the gift. After the gift date, the recipient may spend alone and without restriction.',
      succession_notes:
        "Set the gift date to the real occasion this is timed for. The recipient's key should be backed up as carefully as any other -- if it's lost before the date, only the gifter + co-signer can act (to rebuild), not the recipient. There is no in-between recovery path in this shape by design; use Family Inheritance instead if that matters more than simplicity.",
    },
  },

  {
    id: 'tapit-circle',
    title: 'Tapit Circle',
    tagline: 'A phone-verified circle, plus a harder path only you hold',
    useCase:
      "A close circle of 3 to 5 people who each hold a signing key in Tapit Wallet -- everyone in the circle must sign for a normal spend, no exceptions. This is a watchtower, not a spending committee: it's YOUR money, and the circle's only job is to verify by live phone call that it's really you asking, calmly and not under duress, before their wallets sign. Above the circle sits a second path that's ALWAYS available, no waiting -- your own separate, harder-to-reach keys (split across physical locations, for example). No timelock gates it; the friction is deliberately physical (retrieving enough of your own keys), not a clock. See docs/integration-phase2-vault-key-bridge.md for how the Tapit key handoff and signing bridge work, and the phone-callback safety-phrase feature for how the circle verifies it's really you.",
    config: {
      mode: 'inheritance',
      plannedFounders: 5,
      // Unanimous by design -- the whole point of a "close circle" is that
      // no subset of it can act alone. Tune plannedFounders (3-5) in
      // Configure; founderQ is kept equal to it there so the circle stays
      // unanimous at whatever size you pick.
      founderQ: 5,
      // No third leaf -- the backup branch below IS the fallback; there
      // is no separate heirs/estate-planning leg in this template.
      plannedHeirs: 0,
      heirQ: 0,
      recoveryAfter: 0, // Mutually exclusive with backupEnabled -- see DynastyPolicy::has_backup.
      inheritanceAfter: 0,
      backupEnabled: true,
      // Harder than the circle's own unanimous quorum on purpose --
      // "anytime, harder": always available, but costs more physical
      // effort than a phone call. Tune plannedBackups/backupQ in
      // Configure to match how many keys you're actually willing to
      // split up and bury/distribute.
      backupQ: 4,
      plannedBackups: 5,
    },
    scenarios: [
      {
        title: 'A normal spend',
        trigger: 'You want to move funds and can reach your circle.',
        outcome:
          "You initiate the spend. Each circle member gets a call -- they verify it's really you, calm and not under duress (the phone-callback safety phrase confirms this), then their Tapit wallet signs automatically. Bitcoin itself refuses the transaction until all of them have -- this isn't an app-level checkbox, it's enforced by the compiled script.",
        actions: [
          'Build the proposal in the Send tab.',
          'Call each circle member; they verify and sign via Tapit from their own device.',
          'Once every signature is collected, broadcast.',
        ],
        severity: 'info',
      },
      {
        title: 'A circle member reports the duress phrase',
        trigger: 'Someone claiming to be you gives the wrong phrase, or the duress phrase.',
        outcome:
          "That circle member's wallet refuses to sign. This is the whole point: a stranger holding a stolen device or a spoofed request has neither the phrase nor the ability to fool multiple people who know your voice.",
        actions: [
          'The circle member should hang up and contact you or the authorities on a different channel.',
          "If your vault has a halt/pause control, use it -- that stops every signature until this is sorted out.",
        ],
        severity: 'danger',
      },
      {
        title: "You can't reach the circle, or need to move funds without them",
        trigger: 'The circle is unreachable, or you need this to stay entirely between you and your own keys.',
        outcome:
          'The backup path is always available -- no timelock, no waiting. It costs more physical effort (retrieving enough of your own separately-held keys) instead of a clock, which is the deliberate trade: easy and social via the circle, or harder and entirely yours.',
        actions: [
          'Retrieve enough of your backup keys to meet the backup quorum.',
          'Spend via the backup path directly -- no circle involvement needed.',
        ],
        severity: 'info',
      },
      {
        title: 'A circle member loses their Tapit wallet',
        trigger: 'A device is lost, or a passphrase is forgotten.',
        outcome:
          "Path 1 needs every circle member -- with one key gone, the remaining members cannot spend on it. The Tapit-side recovery paths (recovery key, encrypted backup, trusted-helper cohort) are that member's own path back into their wallet; they don't affect this vault's script at all. The backup path is unaffected either way -- it never depended on the circle.",
        actions: [
          "Help the member recover their Tapit wallet through Tapit's own recovery paths first.",
          'The backup path remains available in the meantime if funds need to move.',
        ],
        severity: 'warn',
      },
    ],
    trustDoc: {
      purpose:
        "A vault controlled by unanimous agreement of a close circle of 3-5 people, each signing from their own Tapit Wallet, verified live by phone before each spend. This is your money -- the circle is a watchtower, never a committee that can withhold permission. A second path, always available and gated only by physical effort (your own separately-held keys), exists so you can always spend without needing anyone's cooperation.",
      distribution_rules:
        "Every normal spend requires a live phone verification and a signature from every named circle member, collected through each member's own Tapit Wallet. No majority override exists on this path by design. The backup path requires no circle involvement at all.",
      succession_notes:
        'This template has no separate estate-planning leg. If inheritance planning is also needed, consider Family Inheritance or a dedicated successor arrangement alongside this vault.',
    },
  },

  // // -- Test-mode templates -------------------------------------
  // Same shapes, timelocks measured in blocks (hours-to-a-day on
  // signet at 10-min blocks) so a full recovery / inheritance /
  // protector cycle can be demonstrated without waiting months.
  // Mark vault names with `[TEST]` so they're visually distinct
  // from production vaults. Recompile the equivalent production
  // template once you're ready to put real value in.
  {
    id: 'test-family-inheritance',
    title: '[TEST] Family Inheritance',
    tagline: '2-of-3 . 2-of-3 heirs . 10 / 30 blocks',
    useCase:
      'Software-key sandbox for the Family Inheritance shape. Recovery in ~10 blocks (~100 min on signet), inheritance in ~30 blocks (~5 hours). Verify every path end-to-end, then rebuild the real vault with production timelocks.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 3,
      heirQ: 2,
      recoveryAfter: 10,
      inheritanceAfter: 30,
    },
    scenarios: [
      {
        title: 'Test every path without waiting years',
        trigger: 'You want to see the recovery + inheritance paths actually unlock.',
        outcome:
          'Recovery opens ~100 min after compile; inheritance ~5 hours. Plenty of time to verify signing, broadcast, and role-specific behavior.',
        actions: [
          'Compile, fund from the signet faucet, send a normal spend first.',
          'Wait for tip to cross recovery_after; try a recovery-path spend.',
          'Wait longer; verify the inheritance path signs with heir keys alone.',
          'Once satisfied, recompile the production "Family Inheritance" template with real timelocks and fund that.',
        ],
        severity: 'info',
      },
    ],
    trustDoc: {
      purpose: 'Signet test sandbox for the Family Inheritance shape. Not for real value.',
      distribution_rules:
        'Test distributions only. Reset mnemonics + vault after verification.',
      succession_notes:
        'Test vault. Do not back up the seeds long-term -- delete after you have verified every spending path.',
    },
    testMode: true,
  },
  {
    id: 'test-generational-trust',
    title: '[TEST] Generational Trust',
    tagline: '3-of-5 . protector . consent . 15 / 45 / 8',
    useCase:
      'Sandbox for the Generational Trust shape with its protector and beneficiary-consent gate. Protector unlocks at ~8 blocks, recovery at ~15 blocks, inheritance at ~45 blocks. Walk the full drama -- beneficiary refuses, protector steps in -- in one afternoon.',
    config: {
      mode: 'inheritance',
      plannedFounders: 5,
      founderQ: 3,
      plannedHeirs: 3,
      heirQ: 2,
      recoveryAfter: 15,
      inheritanceAfter: 45,
      protectorEnabled: true,
      protectorAfter: 8,
      protectorQ: 1,
      plannedProtectors: 1,
      consentEnabled: true,
      consentQ: 1,
      plannedConsenters: 1,
    },
    scenarios: [
      {
        title: 'Full governance dry-run',
        trigger: 'Walk the trust + beneficiary + protector + successor flows in one sitting.',
        outcome:
          'Enough window to test: beneficiary cosigns Path 1, beneficiary refuses, protector opens at 8 blocks and sweeps, successors inherit at 45 blocks.',
        actions: [
          'Fund, file a request, approve via trustee quorum + beneficiary consent.',
          'File another request; have the beneficiary refuse; confirm Path 1 is frozen.',
          'Wait for protector window; sweep to a replacement vault.',
          'Then recompile the production Generational Trust with the intended multi-year timelocks.',
        ],
        severity: 'info',
      },
    ],
    trustDoc: {
      purpose: 'Signet test sandbox for the Generational Trust shape with protector + consent.',
      distribution_rules:
        'Test distributions only. Each role should exercise its path at least once.',
      succession_notes:
        'Test vault. Rotate out after all four paths have signed + broadcast.',
    },
    testMode: true,
  },
  {
    id: 'test-lost-device',
    title: '[TEST] Lost-Device Insurance',
    tagline: '2-of-3 . 12 / 30 blocks',
    useCase:
      'Short-timelock rehearsal for the Lost-Device shape. Lets you actually observe the 6-month recovery path by waiting ~2 hours on signet instead.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 1,
      heirQ: 1,
      recoveryAfter: 12,
      inheritanceAfter: 30,
    },
    scenarios: [
      {
        title: 'Lose two devices, wait, recover',
        trigger: 'Simulate losing 2 of 3 keys and using the 1-key recovery path.',
        outcome:
          'Fund, "lose" 2 keys (just don\'t sign), wait ~120 min, sign with the remaining key on the recovery path.',
        actions: [
          'Helpful to pair with the "Scan signed QR" flow to verify the air-gapped sign path.',
        ],
        severity: 'info',
      },
    ],
    trustDoc: {
      purpose: 'Signet test sandbox. Verify the 2-of-3 recovery behavior on short timelocks.',
      succession_notes: 'Test vault. Drop after verification.',
    },
    testMode: true,
  },
  {
    id: 'test-social-recovery',
    title: '[TEST] Social Recovery',
    tagline: '2-of-3 you . 3-of-5 peers . 10 / 30 blocks',
    useCase:
      'Software-key sandbox for the Self-Custody + Social Recovery shape. Your own-keys recovery opens in ~10 blocks (~100 min on signet); the 3-of-5 social-recovery leg opens in ~30 blocks (~5 hours). Rehearse the full peer-rescue drill with play money, then rebuild the real vault with production timelocks.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 5,
      heirQ: 3,
      recoveryAfter: 10,
      inheritanceAfter: 30,
    },
    scenarios: [
      {
        title: 'Rehearse the social rescue without waiting a year',
        trigger: 'You want to see the peer quorum actually unlock and sweep the funds.',
        outcome:
          'The own-keys recovery path opens ~100 min after compile; the 3-of-5 social leg ~5 hours. Enough time to rehearse the whole peer-rescue ceremony end to end.',
        actions: [
          'Compile, fund from the signet faucet, send a normal 2-of-3 spend first.',
          'Wait for tip to cross inheritance_after; have 3 of the 5 peer keys sign the social-recovery path.',
          'Verify they can sweep to the recovery destination with the holder absent.',
          'Once satisfied, recompile the production "Self-Custody + Social Recovery" template with real timelocks.',
        ],
        severity: 'info',
      },
    ],
    trustDoc: {
      purpose: 'Signet test sandbox for the Social Recovery shape. Not for real value.',
      distribution_rules: 'Test distributions only. Reset mnemonics + vault after verification.',
      succession_notes: 'Test vault. Delete the seeds after you have rehearsed the peer-rescue path.',
    },
    testMode: true,
  },
  {
    id: 'test-gift-locker',
    title: '[TEST] Gift Locker',
    tagline: '2-of-2 now . 1 gifted key . 30 blocks',
    useCase:
      'Software-key sandbox for the Gift Locker shape. The gift date opens ~30 blocks after compile (~5 hours on signet). Verify both paths -- the joint gifter+co-signer spend before the date, and the recipient-alone spend after -- then rebuild the real vault with the actual gift date.',
    config: {
      mode: 'inheritance',
      plannedFounders: 2,
      founderQ: 2,
      plannedHeirs: 1,
      heirQ: 1,
      recoveryAfter: 0, // Gift Locker shape: no separate recovery leaf
      inheritanceAfter: 30,
    },
    scenarios: [
      {
        title: 'Test both paths without waiting months',
        trigger: 'You want to see the joint spend and the solo gift-date spend both actually work.',
        outcome:
          'Path 1 (gifter + co-signer) works immediately after funding. The recipient-alone path opens ~5 hours later on signet.',
        actions: [
          'Compile, fund from the signet faucet, sign a joint 2-of-2 spend first.',
          'Wait for tip to cross inheritance_after; sign a spend with the recipient key alone.',
          'Once satisfied, recompile the production "Gift Locker" template with the real gift date.',
        ],
        severity: 'info',
      },
    ],
    trustDoc: {
      purpose: 'Signet test sandbox for the Gift Locker shape. Not for real value.',
      distribution_rules: 'Test distributions only. Reset mnemonics + vault after verification.',
      succession_notes: 'Test vault. Delete the seeds after you have verified both spending paths.',
    },
    testMode: true,
  },
  {
    id: 'test-tapit-circle',
    title: '[TEST] Tapit Circle',
    tagline: '3-of-3 circle . 2-of-3 backup, no timelock',
    useCase:
      'Sandbox for the Tapit Circle shape at a smaller size (3, not 5) so the whole cycle -- unanimous circle spend, a frozen path when one member is absent, the backup path spending immediately with no wait at all -- can be verified in one sitting on signet. Real Tapit keys still required for the circle; the shape is what\'s sped up, not the key source. Unlike the old timelocked fallback, backup needs no waiting to test -- it\'s always available, same as production.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 3,
      plannedHeirs: 0,
      heirQ: 0,
      recoveryAfter: 0,
      inheritanceAfter: 0,
      backupEnabled: true,
      backupQ: 2,
      plannedBackups: 3,
    },
    scenarios: [
      {
        title: 'Verify unanimity, refusal, and the backup path -- no waiting required',
        trigger: 'You want to see the whole circle actually have to agree, and the backup path actually work.',
        outcome:
          "Compile, fund, then have all 3 circle members sign a Path 1 spend via their own Tapit Wallet. Try leaving one out and confirm the spend is refused. Then spend via the backup path directly with 2 of the 3 backup keys -- no timelock to wait for, since backup is never gated by a clock.",
        actions: [
          'Import all 3 circle members\' real Tapit public keys -- the point of this test is proving the unanimous-signing flow works, not simulating it with software keys.',
          'Attempt a spend with only 2 of 3 signed on Path 1; confirm it\'s refused.',
          'Get all 3 signatures; confirm it broadcasts.',
          'Spend via the backup path with 2 of the 3 backup keys; confirm it broadcasts immediately, no wait.',
          'Once satisfied, recompile the production "Tapit Circle" template with the real circle and backup sizes.',
        ],
        severity: 'info',
      },
    ],
    trustDoc: {
      purpose: 'Signet test sandbox for the Tapit Circle shape. Not for real value.',
      distribution_rules: 'Test distributions only. Confirm the unanimous-refusal case, the full-signature case, and the backup path before trusting the shape with real funds.',
      succession_notes: 'Test vault. Rotate out the circle\'s Tapit keys or delete the vault after verification.',
    },
    testMode: true,
  },
];
