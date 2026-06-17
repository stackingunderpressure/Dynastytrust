import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { listKeys, type LocalKey } from '../lib/keystore';
import { api, type Vault, type TrustDoc, type VaultProposal } from '../lib/api';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input, Label } from '../components/ui';
import { downloadVaultBackup } from '../lib/descriptor-backup';
import { DescriptorQr } from '../components/DescriptorQr';
// THE SINGLE SOURCE OF TRUTH for template shapes + scenarios. The
// compile-critical structural values (mode, counts, quorums, timelock
// offsets, protector/consent presence) live ONLY here -- PolicyBuilder
// and Sage (the assistant) both read this one module so neither can
// drift from the other. The trust-doc boilerplate stays local to this
// page (see TEMPLATE_TRUST_DOCS) because it is page-specific and not
// part of Sage's knowledge; it is merged onto the SSOT config below.
import {
  VAULT_TEMPLATES as SSOT_TEMPLATES,
  type VaultTemplate as SsotTemplate,
} from '../data/vault-templates';

// Bump when docs/terms-of-service.md changes materially. The server
// records this string with the user_id + timestamp so we have a
// durable "who accepted which TOS when" audit trail.
const TOS_VERSION = '1.0';

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
//
// The SHAPE + SCENARIOS come from the single source of truth
// (../data/vault-templates). The COMPILE-CRITICAL structural values
// (mode, counts, quorums, timelock offsets, protector/consent presence)
// are NOT defined here -- they live in the SSOT so this page and Sage
// can never disagree. Only the page-specific trust-doc boilerplate is
// local, in TEMPLATE_TRUST_DOCS below, and is merged onto the SSOT
// config to produce the VaultTemplate[] the rest of this file consumes.

// A concrete what-if playbook item tied to a specific template. Mirrors
// the SSOT Scenario shape; kept local so ScenarioList / severityAccent
// keep their existing types.
interface Scenario {
  title: string;
  trigger: string;
  outcome: string;
  actions?: string[];
  severity?: "info" | "warn" | "danger";
}

// The full template the UI works with: the SSOT shape (id, title,
// tagline, useCase, config, scenarios, testMode) plus the optional
// page-local trust-doc boilerplate merged on by id.
type VaultTemplate = SsotTemplate & {
  /**
   * Default trust-document clauses matching the vault shape.
   * Saved to the vault's trust_doc field right after compile so the
   * trust doc editor opens with attorney-review-ready boilerplate
   * instead of a blank slate. Page-local -- not part of Sage's
   * knowledge -- and merged onto the SSOT config by template id.
   */
  trustDoc?: TrustDoc;
};

// // -- Page-local trust-doc boilerplate, keyed by template id.
// The trust doc is page-specific (it seeds the trust-doc editor after
// compile) and is NOT part of Sage's knowledge, so it stays here rather
// than in the SSOT. Merged onto the SSOT config by id in VAULT_TEMPLATES
// below. Templates with no entry get no boilerplate (trustDoc undefined).
const TEMPLATE_TRUST_DOCS: Record<string, TrustDoc> = {
  'solo-savings': {
    purpose:
      "Personal Bitcoin savings vault for long-term holding. Single-signer wallet with no on-chain inheritance path; off-chain seed backups are the only recovery mechanism.",
    distribution_rules:
      "Holder spends at their discretion. No formal distribution schedule.",
    succession_notes:
      "Back up the seed on metal and store in at least two geographically separated locations (e.g. home safe + safe-deposit box). Leave the seed LOCATION in a sealed envelope with your attorney or in your legal will -- do NOT write the seed words in the will itself. On death, heirs must physically retrieve the seed to recover funds.",
  },
  couples: {
    purpose:
      "Joint Bitcoin savings vault for two partners. Every spend requires BOTH signatures; neither partner can move funds unilaterally.",
    distribution_rules:
      "All spends must be authorized by both signers. Each proposal should include a memo describing the spend.",
    succession_notes:
      "Exchange sealed seed backups stored with an attorney, in a joint safe-deposit box, or with a mutually-trusted executor. On the death of either partner, the survivor will need both seed backups to recover: the vault is not Bitcoin-inheritable in this shape. On divorce, assets are frozen until both parties cooperate to spend.",
  },
  'family-inheritance': {
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
  'generational-trust': {
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
  'business-treasury': {
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
  'emergency-backup': {
    purpose:
      "Same-person 2-of-3 multisig for device-loss insurance. The holder keeps all three keys on three different devices kept in geographically separated locations. Normal spends require any 2 keys; after 6 months of silence, any 1 key can spend via the recovery path.",
    distribution_rules:
      "Holder spends at their discretion using any 2 of 3 devices. No distributions to third parties by design.",
    succession_notes:
      "Store each device in a different secured location (home safe, safe-deposit box, trusted relative). Test seed restore on each device QUARTERLY; a dead seed that you only discover after losing a second device converts this vault from 2-of-3 into a brick. If a seed is stolen, immediately sweep to a new vault with fresh keys BEFORE the 6-month recovery timer makes a single stolen seed sufficient to spend.",
  },
  'social-recovery': {
    purpose:
      "Self-custody vault under the holder's sole control day to day (2-of-3 across the holder's own keys), with a timelocked social-recovery path that lets a 3-of-5 quorum of trusted peers rescue the funds only after a long period of holder inactivity. The peers cannot spend while the holder is active.",
    distribution_rules:
      'The holder spends at will using any 2 of their 3 keys on Path 1. The social-recovery quorum (3 of 5 peers) may spend ONLY after the social-recovery timelock elapses, and only to move funds to the recovery destination named below -- not for ordinary distributions.',
    succession_notes:
      'This template uses peers-spend-alone-after-timelock: once the social leg unlocks, the peer quorum can move funds without the holder. Pick peers who will still be reachable in years, and pick more than the quorum so a few being unavailable does not strand the recovery. The timelock is a safety margin against peer collusion, not an inheritance trigger; while active, the holder keeps it armed by periodically moving / re-anchoring the coins, which pushes the unlock height back out. Name the destination the peers should sweep to, and review the peer set whenever a relationship changes. The large-crowd version of this circle belongs off-chain as a FROST aggregate -- one on-chain key with many people behind it -- so start small and on-chain and climb to FROST as value grows.',
  },
  'test-family-inheritance': {
    purpose: 'Signet test sandbox for the Family Inheritance shape. Not for real value.',
    distribution_rules:
      'Test distributions only. Reset mnemonics + vault after verification.',
    succession_notes:
      'Test vault. Do not back up the seeds long-term -- delete after you have verified every spending path.',
  },
  'test-generational-trust': {
    purpose: 'Signet test sandbox for the Generational Trust shape with protector + consent.',
    distribution_rules:
      'Test distributions only. Each role should exercise its path at least once.',
    succession_notes:
      'Test vault. Rotate out after all four paths have signed + broadcast.',
  },
  'test-lost-device': {
    purpose: 'Signet test sandbox. Verify the 2-of-3 recovery behavior on short timelocks.',
    succession_notes: 'Test vault. Drop after verification.',
  },
  'test-social-recovery': {
    purpose: 'Signet test sandbox for the Social Recovery shape. Not for real value.',
    distribution_rules: 'Test distributions only. Reset mnemonics + vault after verification.',
    succession_notes: 'Test vault. Delete the seeds after you have rehearsed the peer-rescue path.',
  },
};

// Merge the SSOT shape with the page-local trust docs by id. This is the
// VaultTemplate[] the rest of this file consumes. The structural config
// comes verbatim from the SSOT (proved equal by the drift-guard test);
// only trustDoc is added here.
const VAULT_TEMPLATES: VaultTemplate[] = SSOT_TEMPLATES.map((t) => ({
  ...t,
  trustDoc: TEMPLATE_TRUST_DOCS[t.id],
}));


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
    // Minimum recovery timelock: a real 6-month safety rail on
    // mainnet, a warning-only on signet / testnet so the test-mode
    // templates that use 10-45 blocks still compile for quick
    // end-to-end round-trips.
    const network = fk[0]?.network ?? hk[0]?.network;
    const isMainnet = network === 'bitcoin' || network === 'mainnet';
    if (ra < 26_000) {
      if (isMainnet) {
        errors.push(`Recovery timelock must be >= 26,000 blocks (~6 months) on mainnet. Got ${ra.toLocaleString()}.`);
      } else {
        warnings.push(`Recovery timelock ${ra.toLocaleString()} blocks is below the 26,000-block (~6mo) production minimum. Fine for test-mode vaults on ${network}.`);
      }
    }
    if (ia <= ra) errors.push('Inheritance timelock must be greater than recovery timelock.');
  }

  const nets = new Set([...fk, ...hk].map(k => k.network));
  if (nets.size > 1) errors.push('All selected keys must be on the same network.');
  if (fk.length === 1 && fq === 1) warnings.push('1-of-1 -- single point of failure. Back up the seed on metal.');
  return { errors, warnings };
}

// Translate the compiler's raw error strings into guidance the user can
// act on from the form. Falls back to the original message when unknown.
function friendlyCompileError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('duplicatepubkeys') || m.includes('duplicate'))
    return 'The same key is used in more than one spending path. Make sure each founder, heir, protector, and consent slot uses a distinct key.';
  if (m.includes('invalidquorum') || m.includes('quorum'))
    return `${message}. Check that every quorum is between 1 and the number of keys in that group.`;
  if (m.includes('66 digits') || m.includes('pubkey hex'))
    return 'One of the selected keys is missing its public key. Reopen the key in Key Manager, then rebuild the vault.';
  if (m.includes('network'))
    return 'All keys in a vault must be on the same network (all testnet, all signet, or all mainnet).';
  if (m.includes('failed to fetch') || m.includes('non-json') || m.includes('502') || m.includes('503'))
    return 'The compiler did not respond. It may be waking from idle -- wait a couple of seconds and try again.';
  return message;
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
            background: colors.inset,
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
          background: colors.inset,
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

// ~4,380 blocks per month at 10-minute blocks (26,280 blocks = 6 months).
// Used to translate the assistant's month-based proposal into the
// builder's block-offset inputs.
const BLOCKS_PER_MONTH = 4_380;

export default function PolicyBuilder() {
  const navigate = useNavigate();
  const location = useLocation();
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
  const [termsAccepted, setTermsAccepted] = useState(false);

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

  // Prefill from the education bot ("Sage"). When the user confirms a
  // proposal in the Assistant, we navigate here with
  // location.state.prefill. We seed the template shape + quorums +
  // timelocks; the user still picks their own keys and taps Compile.
  // This is the ONLY effect of the handoff -- we never compile or save
  // on the bot's behalf, and no key material is involved.
  useEffect(() => {
    const prefill = (location.state as { prefill?: VaultProposal } | null)?.prefill;
    if (!prefill || typeof prefill.template !== 'string') return;
    const t = VAULT_TEMPLATES.find(v => v.id === prefill.template);
    if (!t) return; // Unknown template id -- open /policy normally.

    const c = t.config;
    setMode(c.mode);
    // Seed counts + quorums from the proposal, clamping quorum <= count
    // so we never produce an invalid state. Fall back to the template
    // defaults when the proposal omits a sensible value.
    const fCount = prefill.founder_count > 0 ? prefill.founder_count : c.plannedFounders;
    const fQ = Math.min(Math.max(prefill.founder_quorum || c.founderQ, 1), Math.max(fCount, 1));
    setPlannedFounders(fCount);
    setFQ(fQ);

    const hCount = prefill.heir_count > 0 ? prefill.heir_count : c.plannedHeirs;
    const hQ = Math.min(Math.max(prefill.heir_quorum || c.heirQ, 1), Math.max(hCount, 1));
    setPlannedHeirs(hCount);
    setHQ(hQ);

    // Months -> block offsets. Fall back to the template's own block
    // values when the proposal doesn't specify a duration.
    const ra = prefill.recovery_after_months > 0
      ? prefill.recovery_after_months * BLOCKS_PER_MONTH
      : c.recoveryAfter;
    const ia = prefill.inheritance_after_months > 0
      ? prefill.inheritance_after_months * BLOCKS_PER_MONTH
      : c.inheritanceAfter;
    setRecovery(ra);
    setInherit(ia);

    if (c.protectorEnabled) {
      setProtectorAfter(c.protectorAfter ?? 26_280);
      setProtectorQ(c.protectorQ ?? 1);
    }
    if (c.consentEnabled) {
      setConsentQ(c.consentQ ?? 1);
    }

    setName(t.title);
    setPendingTrustDoc(t.trustDoc ?? null);
    // Clear the navigation state so a refresh doesn't re-apply it.
    window.history.replaceState({}, '');
    requestAnimationFrame(() => {
      document.getElementById('founder-keys-section')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
    // Mount-only: read the handoff state once. Setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warn before a refresh / tab close discards an in-progress vault the
  // user has started building but not yet saved.
  const dirty =
    (founderKeys.length > 0 || heirKeys.length > 0 || protectorKeys.length > 0) &&
    compiled === null;
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

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
      // Field-level guards the shared validate() doesn't cover, so the
      // user gets a message tied to the control instead of a raw server
      // InvalidQuorum.
      if (hasProtector && protectorQ > protectorKeys.length) {
        throw new Error(
          `Protector quorum (${protectorQ}) exceeds the ${protectorKeys.length} protector key${protectorKeys.length === 1 ? '' : 's'} you added. Lower the quorum or add more protector keys.`,
        );
      }
      if (hasConsent && consentQ > consentKeys.length) {
        throw new Error(
          `Beneficiary-consent quorum (${consentQ}) exceeds the ${consentKeys.length} consent key${consentKeys.length === 1 ? '' : 's'} you added. Lower the quorum or add more consent keys.`,
        );
      }
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
      setCompErr(friendlyCompileError(e instanceof Error ? e.message : 'Compilation failed'));
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
        // Record TOS acceptance with the vault. The server writes a
        // terms_accepted vault_event with this version + timestamp,
        // so the audit trail has "who agreed to what, when" tied to
        // the vault they were creating.
        terms_accepted_version: TOS_VERSION,
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
            background: colors.goldBg,
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
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.1em',
            color: colors.muted,
            textTransform: 'uppercase',
            marginBottom: 8,
          }}
        >
          Production
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
            marginBottom: 16,
          }}
        >
          {VAULT_TEMPLATES.filter(t => !t.testMode).map(t => (
            <TemplateCard key={t.id} template={t} onApply={() => applyTemplate(t)} />
          ))}
        </div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.1em',
            color: colors.orange,
            textTransform: 'uppercase',
            marginBottom: 8,
            paddingTop: 12,
            borderTop: `1px solid ${colors.border}`,
          }}
        >
          Test mode -- signet + short timelocks
        </div>
        <div
          style={{
            fontSize: 12,
            color: colors.muted,
            marginBottom: 10,
            lineHeight: 1.5,
          }}
        >
          Same shapes, but timelocks in blocks (hours-to-a-day on signet) so recovery / inheritance / protector paths can actually be exercised end-to-end. Once verified, recompile the production template with real durations.
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}
        >
          {VAULT_TEMPLATES.filter(t => t.testMode).map(t => (
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
              inputMode="numeric"
              min={1}
              value={Number.isFinite(plannedFounders) ? String(plannedFounders) : ''}
              onChange={e => {
                // Accept empty string during edit so the cursor doesn't
                // snap back to 1 while the user is typing. Clamp on blur.
                const raw = e.target.value;
                if (raw === '') {
                  setPlannedFounders(NaN);
                } else {
                  const n = parseInt(raw, 10);
                  if (!isNaN(n)) setPlannedFounders(n);
                }
              }}
              onBlur={() => {
                if (!Number.isFinite(plannedFounders) || plannedFounders < 1) {
                  setPlannedFounders(1);
                }
              }}
            />
          </div>
          {mode === 'inheritance' && (
          <div style={{ flex: 1 }}>
            <Label>Planned heir count</Label>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              value={Number.isFinite(plannedHeirs) ? String(plannedHeirs) : ''}
              onChange={e => {
                const raw = e.target.value;
                if (raw === '') {
                  setPlannedHeirs(NaN);
                } else {
                  const n = parseInt(raw, 10);
                  if (!isNaN(n)) setPlannedHeirs(n);
                }
              }}
              onBlur={() => {
                if (!Number.isFinite(plannedHeirs) || plannedHeirs < 0) {
                  setPlannedHeirs(0);
                }
              }}
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
              background: colors.dangerBg,
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
                background: colors.successBg,
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

            <label
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                fontSize: 13,
                color: colors.sub,
                padding: '10px 12px',
                background: colors.input,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                cursor: 'pointer',
                lineHeight: 1.5,
              }}
            >
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={e => setTermsAccepted(e.target.checked)}
                style={{ marginTop: 2, flex: '0 0 auto' }}
              />
              <span>
                I have read and agree to the{' '}
                <a
                  href="/legal/terms-of-service.md"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: colors.gold, textDecoration: 'underline' }}
                >
                  Terms of Service (v{TOS_VERSION})
                </a>
                {' and the '}
                <a
                  href="/legal/legal-framework-for-users.md"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: colors.gold, textDecoration: 'underline' }}
                >
                  Legal framework guide
                </a>
                . I understand DynastyTrust is non-custodial, that I retain
                sole control of my keys, and that legal and tax compliance
                is my responsibility.
              </span>
            </label>

            <Button disabled={saving || !termsAccepted} onClick={save}>
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
            background: colors.inset,
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
          {vault.descriptor && (
            <div style={{ marginTop: 14 }}>
              <DescriptorQr
                descriptor={vault.descriptor}
                label="Sparrow-ready QR"
                size={220}
              />
            </div>
          )}
        </div>

        <div
          style={{
            background: colors.inset,
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
