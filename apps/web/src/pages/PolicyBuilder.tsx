import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { listKeys, type LocalKey } from '../lib/keystore';
import { api, type Vault, type TrustDoc } from '../lib/api';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input, Label } from '../components/ui';
import { downloadVaultBackup } from '../lib/descriptor-backup';

/**
 * Post-process the compiler's raw-pubkey descriptor into the Nunchuk /
 * Sparrow / Coldcard key-origin form: `pk([fp/path]xpub/0/*)`. The Rust
 * compiler returns `pk(03abcd...)` because it only sees public keys; the
 * browser has the xpub, fingerprint, and derivation path needed to
 * reconstruct the key origin expression.
 *
 * If a key is missing BOTH masterFingerprint and fingerprint it is left
 * as a raw pubkey; hardware wallets will reject that key specifically,
 * but the rest of the descriptor is still upgraded.
 */
interface KeyOrigin {
  fingerprint: string;
  derivationPath: string;
  xpub: string;
}

function upgradeDescriptor(descriptor: string, origins: Record<string, KeyOrigin>): string {
  let result = descriptor;
  for (const [pubkeyHex, origin] of Object.entries(origins)) {
    const cleanPath = origin.derivationPath.replace(/^m\//, '');
    const keyExpr = `[${origin.fingerprint}/${cleanPath}]${origin.xpub}/0/*`;
    result = result.split(pubkeyHex).join(keyExpr);
  }
  return result;
}

function buildKeyOrigins(keys: SelectedKey[]): Record<string, KeyOrigin> {
  const map: Record<string, KeyOrigin> = {};
  for (const k of keys) {
    const pubkeyHex = toPubkeyHex(k);
    const fp = k.masterFingerprint ?? k.fingerprint;
    if (!fp || !k.xpub || !k.derivationPath) continue;
    map[pubkeyHex] = { fingerprint: fp, derivationPath: k.derivationPath, xpub: k.xpub };
  }
  return map;
}

// Compressed pubkey hex is stored on each key at generation time.
function toPubkeyHex(k: SelectedKey): string {
  if (k.pubkey && k.pubkey.length === 66) return k.pubkey;
  console.error('Key missing pubkey:', k.label, 'pubkey:', k.pubkey, 'length:', k.pubkey?.length);
  throw new Error(
    'Key "' + k.label + '" is missing its pubkey. Please go to the Keys tab, delete this key, and generate a new one.',
  );
}

function blocksToHuman(b: number): string {
  const days = Math.round((b * 10) / 60 / 24);
  if (days < 30) return `~${days} days`;
  if (days < 365) return `~${Math.round(days / 30)} months`;
  return `~${(days / 365).toFixed(1)} years`;
}

const PRESETS = [
  { label: '6 months', blocks: 26_280 },
  { label: '1 year', blocks: 52_560 },
  { label: '2 years', blocks: 105_120 },
  { label: '3 years', blocks: 157_680 },
  { label: '5 years', blocks: 262_800 },
];

// // -- Vault templates
// Professional presets that one-click-configure the entire vault
// shape. User still picks keys from their keyring; everything else
// (mode, quorums, timelocks, protector/consent) is pre-set so a new
// user can pick a fit and hit Compile.

// A concrete what-if playbook item tied to a specific template.
// Keeping trigger / outcome / actions distinct so trustees can
// quickly read the situation and see the steps that actually move
// money or unlock a path.
interface Scenario {
  title: string;
  trigger: string;
  outcome: string;
  actions?: string[];
  severity?: "info" | "warn" | "danger";
}

type VaultTemplate = {
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
  };
  scenarios: Scenario[];
  /**
   * Default trust-document clauses matching the vault shape.
   * Saved to the vault's trust_doc field right after compile so the
   * trust doc editor opens with attorney-review-ready boilerplate
   * instead of a blank slate.
   */
  trustDoc?: TrustDoc;
};

const VAULT_TEMPLATES: VaultTemplate[] = [
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
];

interface SelectedKey {
  pubkey: string;
  keyId: string;
  label: string;
  persona: string;
  xpub: string;
  fingerprint: string;
  masterFingerprint?: string;
  derivationPath: string;
  network: string;
}

type VaultMode = 'plain' | 'inheritance';

function validate(
  mode: VaultMode,
  fk: SelectedKey[],
  hk: SelectedKey[],
  fq: number,
  hq: number,
  ra: number,
  ia: number,
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!fk.length) errors.push('At least one signing key is required.');
  if (fq < 1) errors.push('Signing quorum must be >= 1.');
  // Only surface "quorum exceeds count" once the user has at least
  // one key. While the picker is empty, the "at least one key"
  // error covers it and the duplicate "quorum > count" is noise.
  if (fk.length > 0 && fq > fk.length)
    errors.push(`Signing quorum (${fq}) exceeds key count (${fk.length}).`);

  if (mode === 'inheritance') {
    if (!hk.length) warnings.push('No heir keys -- inheritance path will not be compiled.');
    if (hk.length && hq > hk.length)
      errors.push(`Heir quorum (${hq}) exceeds heir key count (${hk.length}).`);
    if (ra < 26_000)
      errors.push(`Recovery timelock must be >= 26,000 blocks (~6 months). Got ${ra.toLocaleString()}.`);
    if (ia <= ra) errors.push('Inheritance timelock must be greater than recovery timelock.');
  }

  const nets = new Set([...fk, ...hk].map(k => k.network));
  if (nets.size > 1) errors.push('All selected keys must be on the same network.');
  if (fk.length === 1 && fq === 1) warnings.push('1-of-1 -- single point of failure. Back up the seed on metal.');
  return { errors, warnings };
}

interface CompiledVault {
  address: string;
  descriptor: string;
  miniscript_policy: string;
  network: string;
  address_type: string;
  bsms?: string;
}

const selectStyle: CSSProperties = {
  width: '100%',
  padding: '11px 13px',
  background: colors.input,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  color: colors.text,
  fontSize: 16, // iOS Safari zooms on focus below 16px
  fontFamily: fonts.sans,
  boxSizing: 'border-box',
};

// Visual "N of M slots filled" header shown inside each key-picker
// section. Tells the user how many signers the current template
// expects and lets them add more above that number or fewer below.
function SlotHint({
  targetCount,
  filledCount,
  role,
}: {
  targetCount: number;
  filledCount: number;
  role: string;
}) {
  if (targetCount <= 0 && filledCount === 0) return null;
  const remaining = Math.max(0, targetCount - filledCount);
  const over = Math.max(0, filledCount - targetCount);
  const complete = targetCount > 0 && filledCount >= targetCount;
  const empties = Array.from({ length: Math.max(0, targetCount - filledCount) });
  const color = complete ? colors.green : colors.gold;

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 12,
          color: colors.muted,
          marginBottom: 6,
        }}
      >
        <span>
          {filledCount} of {Math.max(targetCount, filledCount)} {role}
          {Math.max(targetCount, filledCount) === 1 ? '' : 's'}
          {complete && ' -- ready'}
          {!complete && targetCount > 0 && ` -- ${remaining} slot${remaining === 1 ? '' : 's'} open`}
          {over > 0 && ` (+${over} above template)`}
        </span>
      </div>
      {empties.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 6 }}>
          {empties.map((_, i) => (
            <div
              key={i}
              style={{
                padding: '8px 10px',
                border: `1px dashed ${color}66`,
                borderRadius: radii.md,
                fontSize: 11,
                color: colors.muted,
                textAlign: 'center',
              }}
            >
              slot {filledCount + i + 1}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// // -- Template card + scenario playbook
// Each template exposes "Use this template" (applies the config
// and scrolls to the key picker) and "What if..." (expands a list
// of concrete failure-mode scenarios so the user can read what
// happens in each case before picking).

function severityAccent(s: Scenario['severity']): string {
  switch (s) {
    case 'danger': return colors.red;
    case 'warn': return colors.orange;
    default: return colors.blue;
  }
}

function TemplateCard({
  template,
  onApply,
}: {
  template: VaultTemplate;
  onApply: () => void;
}) {
  const [openScenarios, setOpenScenarios] = useState(false);

  return (
    <div
      style={{
        textAlign: 'left',
        padding: '12px 14px',
        background: colors.input,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        color: colors.text,
        fontFamily: fonts.sans,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: colors.gold,
          textTransform: 'uppercase',
        }}
      >
        {template.tagline}
      </span>
      <span style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>
        {template.title}
      </span>
      <span style={{ fontSize: 12, color: colors.muted, lineHeight: 1.4 }}>
        {template.useCase}
      </span>
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          type="button"
          style={{ fontSize: 11, padding: '4px 10px' }}
          onClick={onApply}
        >
          Use this template
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          style={{ fontSize: 11, padding: '4px 10px' }}
          onClick={() => setOpenScenarios(o => !o)}
        >
          {openScenarios ? 'Hide' : `What if... (${template.scenarios.length})`}
        </Button>
      </div>
      {openScenarios && <ScenarioList scenarios={template.scenarios} />}
    </div>
  );
}

function ScenarioList({ scenarios }: { scenarios: Scenario[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {scenarios.map((s, i) => {
        const accent = severityAccent(s.severity);
        return (
          <div
            key={i}
            style={{
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderLeft: `3px solid ${accent}`,
              borderRadius: radii.sm,
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: accent }}>
              {s.title}
            </div>
            <div style={{ fontSize: 11, color: colors.muted, lineHeight: 1.4 }}>
              <strong style={{ color: colors.sub }}>Trigger:</strong> {s.trigger}
            </div>
            <div style={{ fontSize: 11, color: colors.sub, lineHeight: 1.4 }}>
              {s.outcome}
            </div>
            {s.actions && s.actions.length > 0 && (
              <ul style={{ margin: '2px 0 0 14px', padding: 0, fontSize: 11, color: colors.muted, lineHeight: 1.4 }}>
                {s.actions.map((a, j) => <li key={j} style={{ marginBottom: 2 }}>{a}</li>)}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Section({
  title,
  sub,
  children,
  id,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <div
      id={id}
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 20,
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>{title}</div>
        {sub && <div style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function QuorumPicker({
  max,
  value,
  onChange,
  color,
}: {
  max: number;
  value: number;
  onChange: (n: number) => void;
  color: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: colors.muted, marginRight: 4 }}>Required:</span>
      {Array.from({ length: max }, (_, i) => i + 1).map(n => (
        <button
          key={n}
          onClick={() => onChange(n)}
          style={{
            width: 34,
            height: 34,
            borderRadius: radii.md,
            border: '1px solid',
            borderColor: value === n ? color : colors.border,
            background: value === n ? color + '22' : 'transparent',
            color: value === n ? color : colors.muted,
            fontWeight: 700,
            fontSize: 14,
            cursor: 'pointer',
            fontFamily: fonts.sans,
          }}
        >
          {n}
        </button>
      ))}
      <span style={{ fontSize: 12, color: colors.muted }}>of {max}</span>
    </div>
  );
}

function KeyPicker({
  selected,
  available,
  onAdd,
  onRemove,
  role,
  accentColor,
}: {
  selected: SelectedKey[];
  available: LocalKey[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  role: string;
  accentColor: string;
}) {
  return (
    <div>
      {selected.map(k => (
        <div
          key={k.keyId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: '#0A0A14',
            borderRadius: radii.md,
            padding: '10px 14px',
            border: `1px solid ${accentColor}44`,
            marginBottom: 6,
          }}
        >
          <span style={{ fontSize: 16 }}>{role === 'founder' ? 'F' : 'H'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>{k.label}</div>
            <div style={{ fontSize: 11, color: colors.muted }}>
              <span style={{ color: accentColor }}>{k.persona}</span>
              {' . '}
              {k.fingerprint}
              {' . '}
              {k.network}
            </div>
          </div>
          <button
            onClick={() => onRemove(k.keyId)}
            style={{
              background: 'none',
              border: 'none',
              color: colors.muted,
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            x
          </button>
        </div>
      ))}
      {available.length > 0 && (
        <select
          style={{ ...selectStyle, color: colors.muted }}
          value=""
          onChange={e => {
            if (e.target.value) onAdd(e.target.value);
          }}
        >
          <option value="">+ Add {role} key...</option>
          {available.map(k => (
            <option key={k.keyId} value={k.keyId}>
              [{k.persona}] {k.label} ({k.fingerprint} . {k.network})
            </option>
          ))}
        </select>
      )}
      {!available.length && !selected.length && (
        <p style={{ fontSize: 13, color: colors.muted }}>
          No active keys available. Generate keys in the Keys tab first.
        </p>
      )}
    </div>
  );
}

function CopyField({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <Label>{label}</Label>
        <Button
          variant="ghost"
          size="sm"
          style={{ padding: '3px 9px', fontSize: 11 }}
          onClick={() =>
            navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? 'check Copied' : 'Copy'}
        </Button>
      </div>
      <div
        style={{
          background: '#0A0A14',
          borderRadius: radii.md,
          padding: '10px 12px',
          fontFamily: fonts.mono,
          fontSize: 11,
          color: colors.sub,
          wordBreak: 'break-all',
          lineHeight: 1.7,
          maxHeight: multiline ? 90 : 'none',
          overflowY: multiline ? 'auto' : 'visible',
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function PolicyBuilder() {
  const navigate = useNavigate();
  const [allKeys, setAllKeys] = useState<LocalKey[]>([]);
  const [name, setName] = useState('My Vault');
  const [addrType, setAddrType] = useState<'tr' | 'wsh' | 'tr_multileaf'>('tr_multileaf');
  const [founderKeys, setFK] = useState<SelectedKey[]>([]);
  const [heirKeys, setHK] = useState<SelectedKey[]>([]);
  const [founderQ, setFQ] = useState(1);
  // Recovery path's quorum after the timelock. Defaults to
  // founderQ - 1 (floor 1) so Path 2 actually grants a new
  // capability: e.g. 3-of-3 now, 2-of-3 after a 3-month timelock
  // protects against a single lost device.
  const [recoveryQ, setRecoveryQ] = useState(1);
  const [heirQ, setHQ] = useState(1);
  // Protector: independent party who can rescue funds after a
  // medium timelock between recovery and inheritance.
  const [protectorKeys, setProtectorKeys] = useState<SelectedKey[]>([]);
  const [protectorQ, setProtectorQ] = useState(1);
  const [protectorAfter, setProtectorAfter] = useState(26_280); // ~6 months default
  // Beneficiary consent (T-consent): gates Path 1 only, leaving the
  // timelocked recovery / inheritance / protector paths untouched.
  const [consentKeys, setConsentKeys] = useState<SelectedKey[]>([]);
  const [consentQ, setConsentQ] = useState(1);
  const [recovery, setRecovery] = useState(26_280);
  const [inherit, setInherit] = useState(52_560);
  const [compiled, setCompiled] = useState<CompiledVault | null>(null);
  // Absolute CLTV heights returned by the Netlify compile function.
  // These are the exact values baked into the Taproot tree's
  // `after(N)` leaves; save() MUST store these against the vault
  // row so the address and the DB agree -- otherwise psbt-binary's
  // tree rebuild produces a different merkle root and finalize
  // fails with "Control block verification failed at index 0".
  const [absoluteTimelocks, setAbsoluteTimelocks] = useState<{
    recovery_after: number;
    inheritance_after: number;
    protector_after: number;
  } | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompErr] = useState<string | null>(null);
  const [slowHint, setSlowHint] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedVault, setSavedVault] = useState<Vault | null>(null);

  // Vault type: plain (single-sig or multisig, no timelocks) vs
  // inheritance (founders + heirs + recovery + inheritance).
  const [mode, setMode] = useState<VaultMode>('plain');

  // Trust-doc defaults from the most recently applied template.
  // Attached to the vault right after save so the trust doc editor
  // opens with attorney-ready boilerplate instead of a blank slate.
  const [pendingTrustDoc, setPendingTrustDoc] = useState<TrustDoc | null>(null);

  // Draft mode -- the target shape of the vault when compiled.
  // Defaults track the currently-selected counts so the existing
  // "compile immediately" flow still feels the same.
  const [plannedFounders, setPlannedFounders] = useState(1);
  const [plannedHeirs, setPlannedHeirs] = useState(0);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftErr, setDraftErr] = useState<string | null>(null);

  useEffect(() => {
    setAllKeys(listKeys().filter(k => k.status === 'active'));
  }, []);

  // Keep recoveryQ one below founderQ by default so Path 2 is
  // meaningful. Users can override manually.
  useEffect(() => {
    setRecoveryQ(prev => {
      const suggested = Math.max(1, founderQ - 1);
      return prev > founderQ || prev === 0 ? suggested : prev;
    });
  }, [founderQ]);

  const network = [...founderKeys, ...heirKeys][0]?.network ?? 'testnet';
  const { errors, warnings } = validate(mode, founderKeys, heirKeys, founderQ, heirQ, recovery, inherit);
  const canCompile = errors.length === 0 && founderKeys.length > 0;

  function addKey(keyId: string, role: 'founder' | 'heir' | 'protector' | 'consent') {
    const k = allKeys.find(k => k.keyId === keyId);
    if (!k) return;
    const sk: SelectedKey = {
      keyId: k.keyId,
      label: k.label,
      persona: k.persona,
      xpub: k.xpub,
      pubkey: k.pubkey,
      fingerprint: k.fingerprint,
      masterFingerprint: k.masterFingerprint,
      derivationPath: k.derivationPath,
      network: k.network,
    };
    if (role === 'founder') {
      setFK(prev => {
        const n = [...prev, sk];
        // Grow the quorum toward the template's plannedFounders
        // target as slots fill; never exceed current key count.
        setFQ(q => Math.min(Math.max(q, plannedFounders), n.length));
        return n;
      });
    } else if (role === 'heir') {
      setHK(prev => {
        const n = [...prev, sk];
        setHQ(q => Math.min(Math.max(q, plannedHeirs), n.length));
        return n;
      });
    } else if (role === 'protector') {
      setProtectorKeys(prev => {
        const n = [...prev, sk];
        setProtectorQ(q => Math.min(q, n.length));
        return n;
      });
    } else {
      setConsentKeys(prev => {
        const n = [...prev, sk];
        setConsentQ(q => Math.min(q, n.length));
        return n;
      });
    }
    setCompiled(null);
  }

  function removeKey(keyId: string, role: 'founder' | 'heir' | 'protector' | 'consent') {
    if (role === 'founder') {
      setFK(prev => {
        const n = prev.filter(k => k.keyId !== keyId);
        setFQ(q => Math.min(q, n.length || 1));
        return n;
      });
    } else if (role === 'heir') {
      setHK(prev => {
        const n = prev.filter(k => k.keyId !== keyId);
        setHQ(q => Math.min(q, n.length || 1));
        return n;
      });
    } else if (role === 'protector') {
      setProtectorKeys(prev => {
        const n = prev.filter(k => k.keyId !== keyId);
        setProtectorQ(q => Math.min(q, n.length || 1));
        return n;
      });
    } else {
      setConsentKeys(prev => {
        const n = prev.filter(k => k.keyId !== keyId);
        setConsentQ(q => Math.min(q, n.length || 1));
        return n;
      });
    }
    setCompiled(null);
  }

  // A key can only fill one role at a time; the checkerless UX
  // made it possible to silently promote a heir into a trustee
  // slot, which then produced a compiled vault with the heir's
  // pubkey embedded in Path 1. Each role's availability list
  // excludes keys already claimed by ANY other role.
  const claimedIds = new Set<string>([
    ...founderKeys.map(k => k.keyId),
    ...heirKeys.map(k => k.keyId),
    ...protectorKeys.map(k => k.keyId),
    ...consentKeys.map(k => k.keyId),
  ]);
  const availForFounder   = allKeys.filter(k => !claimedIds.has(k.keyId));
  const availForHeir      = allKeys.filter(k => !claimedIds.has(k.keyId));
  const availForProtector = allKeys.filter(k => !claimedIds.has(k.keyId));
  const availForConsent   = allKeys.filter(k => !claimedIds.has(k.keyId));

  function applyTemplate(t: VaultTemplate) {
    const c = t.config;
    setMode(c.mode);
    setPlannedFounders(c.plannedFounders);
    setFQ(c.founderQ);
    setPlannedHeirs(c.plannedHeirs);
    setHQ(c.heirQ);
    setRecovery(c.recoveryAfter);
    setInherit(c.inheritanceAfter);
    if (c.protectorEnabled) {
      setProtectorAfter(c.protectorAfter ?? 26_280);
      setProtectorQ(c.protectorQ ?? 1);
    } else {
      setProtectorKeys([]);
      setProtectorQ(1);
    }
    if (c.consentEnabled) {
      setConsentQ(c.consentQ ?? 1);
    } else {
      setConsentKeys([]);
      setConsentQ(1);
    }
    setName(t.title);
    setCompiled(null);
    // Remember the template's trust-doc boilerplate so save() can
    // attach it once the vault exists.
    setPendingTrustDoc(t.trustDoc ?? null);
    // Jump the user to the key-picking section so they can start
    // filling the slots the template just declared.
    requestAnimationFrame(() => {
      document.getElementById('founder-keys-section')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }

  async function compile() {
    setCompiling(true);
    setCompErr(null);
    setCompiled(null);
    setSlowHint(false);
    const slowTimer = window.setTimeout(() => setSlowHint(true), 1500);
    try {
      // Treat inheritance mode with zero heirs as plain -- Rust's
      // is_plain() requires both empty heir keys AND zero timelocks,
      // otherwise heir_quorum > 0 trips InvalidQuorum on the server.
      const plain = mode === 'plain' || (mode === 'inheritance' && heirKeys.length === 0);
      const hasProtector = !plain && protectorKeys.length > 0;
      const hasConsent = consentKeys.length > 0;
      const res = await api.compile({
        name,
        network: network as 'testnet' | 'signet' | 'bitcoin',
        address_type: addrType,
        founder_keys: founderKeys.map(toPubkeyHex),
        founder_quorum: founderQ,
        recovery_quorum: plain ? undefined : recoveryQ,
        heir_keys: plain ? [] : heirKeys.map(toPubkeyHex),
        heir_quorum: plain ? 1 : heirQ,
        recovery_after: plain ? 0 : recovery,
        inheritance_after: plain ? 0 : inherit,
        ...(hasProtector
          ? {
              protector_keys: protectorKeys.map(toPubkeyHex),
              protector_quorum: protectorQ,
              protector_after: protectorAfter,
            }
          : {}),
        ...(hasConsent
          ? {
              consent_keys: consentKeys.map(toPubkeyHex),
              consent_quorum: consentQ,
            }
          : {}),
        save: false,
      });
      const raw = res.compiled as CompiledVault;
      const origins = buildKeyOrigins(
        plain
          ? [...founderKeys, ...consentKeys]
          : [...founderKeys, ...heirKeys, ...protectorKeys, ...consentKeys],
      );
      setCompiled({ ...raw, descriptor: upgradeDescriptor(raw.descriptor, origins) });
      // Remember the exact absolute CLTV heights the compiler
      // baked into the tree so save() can store matching values
      // in the DB.
      if (res.absolute_timelocks) {
        setAbsoluteTimelocks({
          recovery_after: res.absolute_timelocks.recovery_after,
          inheritance_after: res.absolute_timelocks.inheritance_after,
          protector_after: res.absolute_timelocks.protector_after,
        });
      } else {
        setAbsoluteTimelocks(null);
      }
    } catch (e) {
      setCompErr(e instanceof Error ? e.message : 'Compilation failed');
    } finally {
      window.clearTimeout(slowTimer);
      setCompiling(false);
      setSlowHint(false);
    }
  }

  async function saveDraft() {
    setDraftSaving(true);
    setDraftErr(null);
    try {
      const plain = mode === 'plain';
      const draftNet = founderKeys[0]?.network ?? heirKeys[0]?.network ?? 'testnet';
      const effectivePlannedHeirs = plain ? 0 : plannedHeirs;
      const effectiveFounderQ = Math.min(founderQ, plannedFounders);
      const res = await api.vaults.createDraft({
        name,
        network: draftNet as 'testnet' | 'signet' | 'bitcoin',
        address_type: addrType,
        planned_founder_count: plannedFounders,
        planned_heir_count: effectivePlannedHeirs,
        founder_quorum: effectiveFounderQ,
        heir_quorum: effectivePlannedHeirs > 0 ? Math.min(heirQ, effectivePlannedHeirs) : 1,
        recovery_quorum: plain
          ? null
          : Math.min(recoveryQ, Math.max(1, effectiveFounderQ)),
        recovery_after: plain ? 0 : recovery,
        inheritance_after: plain ? 0 : inherit,
        ...(consentKeys.length > 0 ? { consent_quorum: consentQ } : {}),
      });

      // If the owner already picked a founder key of their own, seed
      // their member row with the key material right away. The
      // auto-seed trigger created an empty owner row at insert time.
      const ownKey = founderKeys[0];
      if (ownKey) {
        try {
          const { members } = await api.members.list(res.vault.id);
          const ownerMember = members.find(m => m.role === 'owner');
          if (ownerMember) {
            await api.members.update(ownerMember.id, {
              xpub: ownKey.xpub,
              fingerprint: ownKey.masterFingerprint ?? ownKey.fingerprint,
              pubkey: ownKey.pubkey,
              derivation_path: ownKey.derivationPath,
              key_label: ownKey.label,
            });
          }
        } catch {
          /* best-effort; owner can fill their slot later on the members tab */
        }
      }

      // Apply the template's trust-doc boilerplate so the draft
      // opens with attorney-ready defaults already in place.
      let finalVault = res.vault;
      if (pendingTrustDoc) {
        try {
          const updated = await api.vaults.updateTrustDoc(res.vault.id, pendingTrustDoc);
          finalVault = updated.vault;
        } catch {
          /* non-fatal; user can edit trust doc from the overview */
        }
      }

      navigate(`/vaults/${finalVault.id}`, { state: { vault: finalVault } });
    } catch (e) {
      setDraftErr(e instanceof Error ? e.message : 'Failed to save draft');
    } finally {
      setDraftSaving(false);
    }
  }

  async function save() {
    if (!compiled) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const plain = mode === 'plain';
      const res = await api.vaults.create({
        name,
        network: compiled.network as 'testnet' | 'signet' | 'bitcoin',
        address: compiled.address,
        descriptor: compiled.descriptor,
        miniscript_policy: compiled.miniscript_policy,
        address_type: compiled.address_type,
        founder_quorum: founderQ,
        heir_quorum: plain ? 1 : heirQ,
        recovery_quorum: plain ? null : recoveryQ,
        // CRITICAL: store the absolute CLTV heights that the
        // compiler baked into the address, not the relative
        // offsets the user picked. If the server returned them
        // (it does, via absolute_timelocks), use those; for
        // backward compatibility with old servers, fall back to
        // the relative offset (which would trip the "Control
        // block verification failed" issue -- but the server is
        // current in all live deployments).
        recovery_after: plain ? 0 : (absoluteTimelocks?.recovery_after ?? recovery),
        inheritance_after: plain ? 0 : (absoluteTimelocks?.inheritance_after ?? inherit),
        founder_keys: founderKeys.map(k => k.xpub),
        heir_keys: plain ? [] : heirKeys.map(k => k.xpub),
        ...(protectorKeys.length > 0 && !plain
          ? {
              protector_keys: protectorKeys.map(k => k.xpub),
              protector_quorum: protectorQ,
              protector_after: absoluteTimelocks?.protector_after ?? protectorAfter,
            }
          : {}),
        ...(consentKeys.length > 0
          ? {
              consent_keys: consentKeys.map(k => k.xpub),
              consent_quorum: consentQ,
            }
          : {}),
      });
      // Attach the template's trust-doc boilerplate so the editor
      // opens with meaningful defaults. Non-fatal on error: the
      // vault was created successfully and the user can fill it in
      // manually from the Overview tab.
      if (pendingTrustDoc) {
        try {
          const updated = await api.vaults.updateTrustDoc(res.vault.id, pendingTrustDoc);
          setSavedVault(updated.vault);
        } catch {
          setSavedVault(res.vault);
        }
      } else {
        setSavedVault(res.vault);
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 780 }}>
      {allKeys.length === 0 && (
        <div
          style={{
            padding: '14px 18px',
            background: '#1A1400',
            border: `1px solid ${colors.goldDim}`,
            borderRadius: 10,
            fontSize: 13,
            color: colors.sub,
          }}
        >
          ! No active keys found. Go to the <strong style={{ color: colors.gold }}>Keys</strong> tab
          and generate keys first, then return here.
        </div>
      )}

      <Section
        title="Start from a template"
        sub="Pick a shape that fits, then pick keys and compile. You can add more signers than the template's minimum before compiling."
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}
        >
          {VAULT_TEMPLATES.map(t => (
            <TemplateCard key={t.id} template={t} onApply={() => applyTemplate(t)} />
          ))}
        </div>
      </Section>

      <Section
        title="Vault type"
        sub="Plain is a normal wallet -- single-sig or multisig, spendable any time. Inheritance adds a timelocked recovery path for founders and a later inheritance path for heirs."
      >
        <div
          style={{
            display: 'flex',
            gap: 4,
            background: colors.input,
            borderRadius: radii.md,
            padding: 4,
          }}
        >
          {(['plain', 'inheritance'] as const).map(m => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  border: 'none',
                  borderRadius: radii.sm,
                  background: active ? colors.border : 'transparent',
                  color: active ? colors.text : colors.muted,
                  fontSize: 13,
                  fontFamily: fonts.sans,
                  cursor: 'pointer',
                }}
              >
                {m === 'plain' ? 'Plain (no timelocks)' : 'Inheritance vault'}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Vault settings">
        <div style={{ display: 'flex', gap: 14 }}>
          <div style={{ flex: 2 }}>
            <Label>Vault name</Label>
            <Input
              value={name}
              onChange={e => {
                setName(e.target.value);
                setCompiled(null);
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <Label>Address type</Label>
            <select
              style={selectStyle}
              value={addrType}
              onChange={e => {
                setAddrType(e.target.value as typeof addrType);
                setCompiled(null);
              }}
            >
              <option value="tr_multileaf">Taproot multileaf (recommended)</option>
              <option value="wsh">SegWit P2WSH</option>
              <option value="tr">Taproot single leaf</option>
            </select>
          </div>
        </div>
      </Section>

      <Section
        id="founder-keys-section"
        title={mode === 'plain' ? 'Signing keys' : 'Founder keys'}
        sub={
          mode === 'plain'
            ? 'Day-to-day spending. Quorum below determines how many signatures are needed.'
            : 'Day-to-day spending -- available immediately'
        }
      >
        <SlotHint
          targetCount={plannedFounders}
          filledCount={founderKeys.length}
          role={mode === 'plain' ? 'signer' : 'founder'}
        />
        <KeyPicker
          selected={founderKeys}
          available={availForFounder}
          onAdd={id => addKey(id, 'founder')}
          onRemove={id => removeKey(id, 'founder')}
          role="founder"
          accentColor={colors.gold}
        />
        {founderKeys.length > 0 && (
          <QuorumPicker
            max={founderKeys.length}
            value={founderQ}
            onChange={q => {
              setFQ(q);
              setCompiled(null);
            }}
            color={colors.gold}
          />
        )}
        {mode === 'inheritance' && founderKeys.length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: colors.text, marginBottom: 4 }}>
              Recovery quorum after timelock
            </div>
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
              How many trustees are needed to spend via the recovery path once the timelock
              elapses. Set below the normal quorum so Path 2 actually unlocks something (e.g.
              3-of-3 normally, 2-of-3 after 3 months as insurance against a lost device).
            </div>
            <QuorumPicker
              max={founderKeys.length}
              value={recoveryQ}
              onChange={q => {
                setRecoveryQ(q);
                setCompiled(null);
              }}
              color={colors.blue}
            />
            {recoveryQ >= founderQ && (
              <div style={{ fontSize: 11, color: colors.orange, marginTop: 8 }}>
                Warning: recovery quorum equals the normal quorum, so Path 2 grants no new
                capability -- anyone who could sign Path 2 could already sign Path 1 today.
              </div>
            )}
          </div>
        )}
      </Section>

      {mode === 'inheritance' && (
        <Section title="Heir keys" sub="Inheritance path -- unlocks after timelock">
          <SlotHint targetCount={plannedHeirs} filledCount={heirKeys.length} role="heir" />
          <KeyPicker
            selected={heirKeys}
            available={availForHeir}
            onAdd={id => addKey(id, 'heir')}
            onRemove={id => removeKey(id, 'heir')}
            role="heir"
            accentColor={colors.green}
          />
          {heirKeys.length > 0 && (
            <QuorumPicker
              max={heirKeys.length}
              value={heirQ}
              onChange={q => {
                setHQ(q);
                setCompiled(null);
              }}
              color={colors.green}
            />
          )}
        </Section>
      )}

      {mode === 'inheritance' && (
        <Section
          title="Protector (optional)"
          sub="An independent party -- typically an estate attorney or family advisor -- who can spend after their own timelock if the trustees go rogue. Longer than the recovery timelock so trustees recover first; shorter than the inheritance timelock so the protector can intervene before succession."
        >
          <KeyPicker
            selected={protectorKeys}
            available={availForProtector}
            onAdd={id => addKey(id, 'protector')}
            onRemove={id => removeKey(id, 'protector')}
            role="protector"
            accentColor={colors.blue}
          />
          {protectorKeys.length > 0 && (
            <>
              <QuorumPicker
                max={protectorKeys.length}
                value={protectorQ}
                onChange={q => {
                  setProtectorQ(q);
                  setCompiled(null);
                }}
                color={colors.blue}
              />
              <div style={{ marginTop: 14 }}>
                <Label>Protector timelock (blocks)</Label>
                <div style={{ fontSize: 12, color: colors.muted, marginBottom: 6 }}>
                  Should sit between the recovery timelock and the inheritance
                  timelock. ~26,280 blocks = 6 months.
                </div>
                <Input
                  type="number"
                  min={recovery + 1}
                  value={protectorAfter}
                  onChange={e => {
                    setProtectorAfter(Math.max(recovery + 1, parseInt(e.target.value) || recovery + 1));
                    setCompiled(null);
                  }}
                />
                {protectorAfter <= recovery && (
                  <div style={{ fontSize: 11, color: colors.orange, marginTop: 6 }}>
                    Protector timelock must exceed recovery ({recovery.toLocaleString()}).
                  </div>
                )}
                {protectorAfter >= inherit && (
                  <div style={{ fontSize: 11, color: colors.orange, marginTop: 6 }}>
                    Warning: protector path unlocks after or with inheritance -- it may be redundant.
                  </div>
                )}
              </div>
            </>
          )}
        </Section>
      )}

      {mode === 'inheritance' && (
        <Section
          title="Beneficiary consent (optional)"
          sub="Adds a beneficiary-cosign gate on the trustees-now path. Every normal spend then requires trustees AND this many beneficiary signatures. The timelocked recovery / inheritance / protector paths are intentionally unaffected -- they exist so funds can still move when a beneficiary refuses to cosign. Use when a beneficiary should have veto power over day-to-day spends without being responsible for custody."
        >
          <KeyPicker
            selected={consentKeys}
            available={availForConsent}
            onAdd={id => addKey(id, 'consent')}
            onRemove={id => removeKey(id, 'consent')}
            role="consent"
            accentColor={colors.gold}
          />
          {consentKeys.length > 0 && (
            <>
              <QuorumPicker
                max={consentKeys.length}
                value={consentQ}
                onChange={q => {
                  setConsentQ(q);
                  setCompiled(null);
                }}
                color={colors.gold}
              />
              <div style={{ fontSize: 11, color: colors.orange, marginTop: 10 }}>
                Every spend on Path 1 will need trustees + {consentQ} beneficiary
                signature{consentQ === 1 ? '' : 's'}. If a beneficiary won't cosign,
                trustees must wait for the recovery timelock to spend.
              </div>
            </>
          )}
        </Section>
      )}

      {mode === 'inheritance' && (
      <Section title="Timelocks">
        {[
          {
            label: 'Recovery after',
            sub: 'Founder recovery path -- for lost devices',
            val: recovery,
            set: setRecovery,
            min: 26_000,
          },
          {
            label: 'Inheritance after',
            sub: 'Heir inheritance -- the dynasty transfer window',
            val: inherit,
            set: setInherit,
            min: recovery + 1,
          },
        ].map(({ label, sub, val, set, min }) => (
          <div key={label} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>{label}</div>
                <div style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>{sub}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: colors.gold,
                    fontFamily: fonts.display,
                  }}
                >
                  {blocksToHuman(val)}
                </div>
                <div style={{ fontSize: 11, color: colors.muted }}>
                  {val.toLocaleString()} blocks
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {PRESETS.filter(p => p.blocks >= min).map(p => (
                <Button
                  key={p.blocks}
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    set(p.blocks);
                    setCompiled(null);
                  }}
                  style={{
                    padding: '5px 11px',
                    fontSize: 12,
                    ...(val === p.blocks ? { borderColor: colors.gold, color: colors.gold } : null),
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Input
                type="number"
                value={val}
                min={min}
                onChange={e => {
                  set(Math.max(min, parseInt(e.target.value) || min));
                  setCompiled(null);
                }}
                style={{ width: 130 }}
              />
              <span style={{ fontSize: 12, color: colors.muted }}>blocks (~10 min each)</span>
            </div>
          </div>
        ))}
      </Section>
      )}

      {(errors.length > 0 || warnings.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {errors.map((e, i) => (
            <div
              key={i}
              style={{
                padding: '10px 14px',
                borderRadius: radii.md,
                fontSize: 13,
                background: colors.red + '11',
                border: `1px solid ${colors.red}33`,
                color: colors.red,
                display: 'flex',
                gap: 8,
              }}
            >
              <span>x</span>
              <span>{e}</span>
            </div>
          ))}
          {warnings.map((w, i) => (
            <div
              key={i}
              style={{
                padding: '10px 14px',
                borderRadius: radii.md,
                fontSize: 13,
                background: colors.gold + '11',
                border: `1px solid ${colors.gold}33`,
                color: colors.gold,
                display: 'flex',
                gap: 8,
              }}
            >
              <span>!</span>
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Save as draft -- collect xpubs via invites, compile later */}
      <Section
        title="Save as draft"
        sub="Creates the vault shape now. Invite co-signers from the Members tab; they provide their own xpubs. You press Compile once every slot is filled."
      >
        <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <Label>{mode === 'plain' ? 'Planned signer count' : 'Planned founder count'}</Label>
            <Input
              type="number"
              min={1}
              value={plannedFounders}
              onChange={e => setPlannedFounders(Math.max(1, parseInt(e.target.value) || 1))}
            />
          </div>
          {mode === 'inheritance' && (
          <div style={{ flex: 1 }}>
            <Label>Planned heir count</Label>
            <Input
              type="number"
              min={0}
              value={plannedHeirs}
              onChange={e => setPlannedHeirs(Math.max(0, parseInt(e.target.value) || 0))}
            />
          </div>
          )}
        </div>
        {draftErr && <p style={{ color: colors.red, fontSize: 13, margin: 0, marginBottom: 10 }}>{draftErr}</p>}
        <Button disabled={draftSaving} onClick={saveDraft}>
          {draftSaving ? 'Saving draft...' : 'Save draft vault'}
        </Button>
      </Section>

      {/* Advanced: compile immediately with all keys selected above */}
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>Compile immediately</div>
            <div style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>
              Have every xpub in your browser already? Sends all keys to the Fly.io compiler and returns the finished descriptor.
            </div>
          </div>
          <Button disabled={!canCompile || compiling} onClick={compile}>
            {compiling
              ? slowHint
                ? 'Waking compiler...'
                : 'Compiling...'
              : compiled
                ? 'Recompile'
                : 'Compile ->'}
          </Button>
        </div>

        {compileErr && (
          <div
            style={{
              padding: 12,
              background: '#1A0A0A',
              border: `1px solid ${colors.borderDanger}`,
              borderRadius: radii.md,
              color: colors.red,
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {compileErr}
          </div>
        )}

        {compiled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                padding: '10px 14px',
                background: '#0A1400',
                border: `1px solid ${colors.green}44`,
                borderRadius: radii.md,
                color: colors.green,
                fontSize: 13,
              }}
            >
              check Compiled -- {compiled.network.toUpperCase()} . {compiled.address_type.toUpperCase()}
            </div>
            <CopyField label="Bitcoin address" value={compiled.address} />
            <CopyField label="Output descriptor (Nunchuk/Sparrow)" value={compiled.descriptor} multiline />
            <CopyField label="Miniscript policy" value={compiled.miniscript_policy} multiline />
            {compiled.bsms && <CopyField label="BSMS export (Nunchuk import)" value={compiled.bsms} multiline />}

            {saveErr && <p style={{ color: colors.red, fontSize: 13 }}>{saveErr}</p>}

            <Button disabled={saving} onClick={save}>
              {saving ? 'Saving vault...' : 'Save vault ->'}
            </Button>
          </div>
        )}
      </div>

      {savedVault && (
        <BackupNudgeModal
          vault={savedVault}
          onDone={() =>
            navigate(`/vaults/${savedVault.id}`, { state: { vault: savedVault } })
          }
        />
      )}
    </div>
  );
}

function BackupNudgeModal({ vault, onDone }: { vault: Vault; onDone: () => void }) {
  const [downloaded, setDownloaded] = useState(false);
  const [metal, setMetal] = useState(false);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 300,
        padding: space[4],
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.gold}44`,
          borderRadius: 16,
          padding: '32px 28px',
          width: '100%',
          maxWidth: 480,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: colors.gold,
            marginBottom: 6,
          }}
        >
          BACKUP NOW
        </div>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: colors.text,
            fontFamily: fonts.display,
            margin: 0,
            marginBottom: 10,
          }}
        >
          Your vault is compiled.
        </h2>
        <p style={{ fontSize: 14, color: colors.sub, lineHeight: 1.5, marginBottom: 20 }}>
          Do these two things before funding. If you lose either piece, the
          vault may be unrecoverable.
        </p>

        <div
          style={{
            background: '#0A0A14',
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
            padding: '14px 16px',
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
            1. Download the descriptor file
          </div>
          <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.5, marginBottom: 10 }}>
            A plaintext file with everything needed to rebuild the vault in
            Nunchuk, Sparrow, or Coldcard. Every member should have a copy.
          </div>
          <Button
            variant={downloaded ? 'ghost' : 'primary'}
            size="sm"
            onClick={() => {
              downloadVaultBackup(vault);
              setDownloaded(true);
            }}
          >
            {downloaded ? 'Downloaded -- save to cold storage' : 'Download backup file'}
          </Button>
        </div>

        <div
          style={{
            background: '#0A0A14',
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
            padding: '14px 16px',
            marginBottom: 20,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
            2. Back up each signing mnemonic on metal
          </div>
          <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.5, marginBottom: 10 }}>
            Paper burns, SSDs die, browsers get wiped. Stamp all 24 words on a
            steel plate for every founder and heir key. Do the verify-words
            flow on the Keys page.
          </div>
          <label
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              cursor: 'pointer',
              fontSize: 13,
              color: colors.sub,
            }}
          >
            <input
              type="checkbox"
              checked={metal}
              onChange={e => setMetal(e.target.checked)}
            />
            I have a metal backup for every signing key on this vault.
          </label>
        </div>

        <Button
          disabled={!downloaded || !metal}
          style={{ width: '100%' }}
          onClick={onDone}
        >
          Open vault
        </Button>
      </div>
    </div>
  );
}
