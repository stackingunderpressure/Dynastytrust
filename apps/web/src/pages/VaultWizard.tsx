import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  listKeys, generateTestKey, generateSoftwareKey, importXpub, importTapitPubkey, parseXpubText,
  type LocalKey,
} from '../lib/keystore';
import {
  upgradeDescriptor, buildKeyOrigins, buildPsbtKeyOrigins, toPubkeyHex,
  type SelectedKey,
} from '../lib/descriptor-keys';
import { api, type Vault, type VaultProposal, type BlocPolicy, type TrustDoc } from '../lib/api';
import { downloadVault } from '../lib/descriptor-backup';
import { keyNetworkMatches } from '../lib/network';
import { blocksToHuman, TIMELOCK_PRESETS } from '../lib/blocks';
import { approxWallclockDate, blocksUntilDate } from '../lib/chain';
import { VAULT_TEMPLATES, type VaultTemplate, type StandardConfig, type BlocConfig } from '../lib/vault-templates';
import { buildStandardTrustDoc, buildBlocTrustDoc } from '../lib/trust-doc';
import type { LeafSpec, LeafUnlock } from '../lib/api';
import { colors, radii } from '../theme';
import { Button, Input, Card, Field } from '../components/ui';
import { useToast } from '../components/toast';
import { DescriptorQr } from '../components/DescriptorQr';
import { XpubQrScanner } from '../components/XpubQrScanner';
import {
  QuorumPicker, CountStepper, KeyPicker, SlotHint, CopyField, BackupFlow, KeyCreatedPrompt, FundingStep,
  BehaviorTimeline, type SpendLeg,
} from '../components/vault-builder';
import { keyLossLine, leafFloorWarningText, keyReuseNotes, buildStandardLegs, type KeyReuseRole } from '../lib/vault-education';

// The unified "start a vault" flow (docs/ux-coherence-redesign.md step 2).
// Absorbs what used to be three separate destinations -- PolicyBuilder
// (/policy), BlocBuilder (/policy/bloc), and a detour through KeyManager
// (/keys) before you could even begin -- into one guided, intent-first
// wizard. Renders at /policy; /policy/bloc no longer exists as its own
// route (App.tsx).
//
// Step order is deliberate: Configure comes BEFORE Keys. A vault's shape
// (quorums, timelocks) is picked and saved as a real, revisitable draft
// row immediately -- key slots start as placeholders you can fill now or
// leave for later, the same way a draft vault already worked for
// multi-signer invites, extended here so a single owner doesn't need
// anyone else's help to defer their own keys either (see
// vaults-compile-bloc.js and vaults-compile.js's direct_keys mode).

type Shape = 'standard' | 'bloc' | 'leaves';
type Step = 'configure' | 'keys' | 'compile' | 'backup' | 'fund' | 'done';
type NetworkChoice = 'testnet' | 'signet' | 'bitcoin';

// ── Generic leaf-list vault (the "toggle-a-leaf" builder) ───────────────
// Configure-step working model for a LeafSpec (lib/api.ts) -- adds the
// UI-only fields a wire LeafSpec doesn't need: plannedKeys (a count,
// before real keys exist -- same role planned_founder_count plays for
// the standard shape), enabled (secondary paths only; the primary path
// is always on, matching how it always exists server-side), and split
// afterBlocks/olderBlocks so switching unlockType never loses whichever
// value isn't currently shown. "Leaf" and "quorum" never appear in any
// user-facing copy built from this -- docs/ux-coherence-redesign.md
// section 5 -- every label below calls this a "path" and phrases the
// count as "how many people must agree."
interface LeafDraft {
  id: string;
  label: string;
  plannedKeys: number;
  quorum: number;
  unlockType: 'immediate' | 'after' | 'older';
  afterBlocks: number;
  olderBlocks: number;
  decayEnabled: boolean;
  decayStepBlocks: number;
  decayFloorQ: number;
  enabled: boolean;
}

// Mirrors protocol::MAX_RELATIVE_BLOCKS (60_000, ~13.7 months) --
// verify_leaf_policy rejects an "if untouched for" path above this. Kept
// in sync by hand; both sides are unlikely to change often, and this is
// the one place the frontend needs the number at all (for the input's
// cap and the explanatory copy next to it).
const MAX_RELATIVE_BLOCKS = 60_000;

let leafIdCounter = 0;
function newLeafId(prefix: string): string {
  leafIdCounter += 1;
  return `${prefix}_${leafIdCounter}`;
}

function defaultPrimaryLeaf(): LeafDraft {
  return {
    id: 'primary', label: 'Everyday signers', plannedKeys: 2, quorum: 2,
    unlockType: 'immediate', afterBlocks: 0, olderBlocks: 0,
    decayEnabled: false, decayStepBlocks: 26_280, decayFloorQ: 1,
    enabled: true,
  };
}

function defaultSecondaryLeaf(label = 'New path'): LeafDraft {
  return {
    id: newLeafId('path'), label, plannedKeys: 1, quorum: 1,
    unlockType: 'after', afterBlocks: 52_560, olderBlocks: 26_280,
    decayEnabled: false, decayStepBlocks: 26_280, decayFloorQ: 1,
    enabled: true,
  };
}

function leafUnlockOf(l: LeafDraft): LeafUnlock {
  if (l.unlockType === 'immediate') return { type: 'immediate' };
  if (l.unlockType === 'after') return { type: 'after', blocks: l.afterBlocks };
  return { type: 'older', blocks: Math.min(l.olderBlocks, MAX_RELATIVE_BLOCKS) };
}

function leafDraftToSpec(l: LeafDraft, keys: string[]): LeafSpec {
  return {
    id: l.id, label: l.label, keys, quorum: l.quorum, unlock: leafUnlockOf(l),
    decay: l.decayEnabled ? { step_blocks: l.decayStepBlocks, floor_quorum: l.decayFloorQ } : null,
  };
}

// One named starting point per shape tab -- tapping a tab REPLACES the
// current path list with this generator's output (with a confirm step if
// the operator has already hand-edited away from it, see
// LeavesConfigureFields). This is the "shape becomes a preset, not a
// one-shot prefill" refinement: switchable at any time, not fired once
// and forgotten the way templateToStandardConfig is for the older shapes.
interface LeafShapeTab {
  id: string;
  title: string;
  why: string;
  build: () => LeafDraft[];
}

const LEAF_SHAPE_TABS: LeafShapeTab[] = [
  {
    id: 'simple',
    title: 'Just the essentials',
    why: 'One group of signers, nothing else. The fewest moving parts -- add a path below any time you want more.',
    build: () => [defaultPrimaryLeaf()],
  },
  {
    id: 'deep-recovery',
    title: 'A long-term fallback',
    why: 'Your everyday signers, plus a single fallback that only opens after a long wait -- for the "everyone is gone or unreachable" case, not day-to-day use.',
    build: () => [
      defaultPrimaryLeaf(),
      { ...defaultSecondaryLeaf('Long-term fallback'), plannedKeys: 1, quorum: 1, unlockType: 'after', afterBlocks: 157_680 },
    ],
  },
  {
    id: 'family-inheritance',
    title: 'Family inheritance',
    why: 'Everyday signers now, a shorter-wait recovery path if they go quiet, and a longer-wait path that hands off to heirs entirely.',
    build: () => [
      defaultPrimaryLeaf(),
      { ...defaultSecondaryLeaf('Recovery'), plannedKeys: 2, quorum: 2, unlockType: 'after', afterBlocks: 26_280 },
      { ...defaultSecondaryLeaf('Heirs'), plannedKeys: 2, quorum: 2, unlockType: 'after', afterBlocks: 52_560 },
    ],
  },
  {
    id: 'passing-it-on',
    title: 'Passing it to my kids',
    why: 'Everyday signers now; a group of heirs that starts needing everyone and, if it sits untouched, quietly needs one fewer every so often -- so losing a key over the years doesn’t lock anyone out.',
    build: () => [
      defaultPrimaryLeaf(),
      {
        ...defaultSecondaryLeaf('Heirs, decaying over time'),
        plannedKeys: 5, quorum: 5, unlockType: 'after', afterBlocks: 52_560,
        decayEnabled: true, decayStepBlocks: 26_280, decayFloorQ: 2,
      },
    ],
  },
  {
    id: 'self-refreshing',
    title: 'Active use, stays strong unless I go quiet',
    why: 'For a vault you actually use. Every signer is needed as long as it stays active. Only if it sits completely untouched for about 13 months does it relax to needing one fewer -- and any normal spend resets the clock back to full strength, so using the vault the way you already do is what keeps it at full strength. Best for frequent spending, not a vault you plan to fund once and leave alone for years -- see "A long-term family vault" below for that.',
    build: () => [
      { ...defaultPrimaryLeaf(), plannedKeys: 3, quorum: 3 },
      { ...defaultSecondaryLeaf('If untouched for a while'), plannedKeys: 3, quorum: 2, unlockType: 'older', olderBlocks: MAX_RELATIVE_BLOCKS },
    ],
  },
  {
    id: 'long-horizon-family-vault',
    title: 'A long-term family vault',
    why: 'For a vault you fund once and may not touch again for years. Every stage opens on a fixed calendar date no matter what -- nothing has to be refreshed or maintained to keep the earlier stages locked, so nobody forgetting to do something ever opens a path early. An emergency path after 3 years, a full hand-off to heirs after a longer wait, and a last-resort path after 20 years in case everything else has failed by then.',
    build: () => [
      defaultPrimaryLeaf(),
      { ...defaultSecondaryLeaf('Emergency'), plannedKeys: 2, quorum: 2, unlockType: 'after', afterBlocks: 157_680 },
      { ...defaultSecondaryLeaf('Inheritance'), plannedKeys: 2, quorum: 2, unlockType: 'after', afterBlocks: 525_600 },
      { ...defaultSecondaryLeaf('Ultimate recovery'), plannedKeys: 1, quorum: 1, unlockType: 'after', afterBlocks: 1_051_200 },
    ],
  },
];

const DEFAULT_STANDARD_CONFIG: StandardConfig = {
  mode: 'inheritance',
  plannedFounders: 2, founderQ: 2,
  plannedHeirs: 2, heirQ: 2,
  recoveryEnabled: true, recoveryAfter: 26_280, inheritanceAfter: 52_560,
  protectorEnabled: false, protectorAfter: 39_000, protectorQ: 1, plannedProtectors: 1,
  consentEnabled: false, consentQ: 1, plannedConsenters: 1,
  backupEnabled: false, backupQ: 4, plannedBackups: 5,
  secondInheritanceEnabled: false, secondInheritanceAfter: 105_120, secondHeirQ: 1, plannedSecondHeirs: 1,
};

const DEFAULT_BLOC_CONFIG: BlocConfig = {
  plannedParents: 2, parentsTogetherQ: 2, coparentQ: 1, kidsWithParentQ: 1,
  parentSoloQ: 1, parentSoloAfter: 26_280,
  plannedKids: 3, kidsDecayStartQ: 3, kidsDecayFloorQ: 1,
  kidsDecayStartAfter: 52_560, kidsDecayStepBlocks: 26_280,
};

function templateToStandardConfig(t: VaultTemplate): StandardConfig {
  const c = t.config;
  const backupEnabled = !!c.backupEnabled;
  return {
    mode: c.mode,
    plannedFounders: c.plannedFounders, founderQ: c.founderQ,
    plannedHeirs: c.plannedHeirs, heirQ: c.heirQ,
    // A template that ships with recoveryAfter: 0 means "Gift Locker"
    // shaped -- no recovery leaf at all -- so the toggle starts off; the
    // fallback default (26_280, ~6 months) only matters if the user
    // re-enables it from here. Mutually exclusive with backup -- a
    // template can never legitimately ship both enabled.
    recoveryEnabled: !backupEnabled && c.recoveryAfter > 0,
    recoveryAfter: c.recoveryAfter > 0 ? c.recoveryAfter : 26_280,
    inheritanceAfter: c.inheritanceAfter,
    protectorEnabled: !!c.protectorEnabled,
    protectorAfter: c.protectorAfter ?? 39_000,
    protectorQ: c.protectorQ ?? 1,
    plannedProtectors: c.plannedProtectors ?? 1,
    consentEnabled: !!c.consentEnabled,
    consentQ: c.consentQ ?? 1,
    plannedConsenters: c.plannedConsenters ?? 1,
    backupEnabled,
    backupQ: c.backupQ ?? 4,
    plannedBackups: c.plannedBackups ?? 5,
    secondInheritanceEnabled: !!c.secondInheritanceEnabled,
    secondInheritanceAfter: c.secondInheritanceAfter ?? 105_120,
    secondHeirQ: c.secondHeirQ ?? 1,
    plannedSecondHeirs: c.plannedSecondHeirs ?? 1,
  };
}

function toSelected(k: LocalKey): SelectedKey {
  return {
    keyId: k.keyId, label: k.label, persona: k.persona, xpub: k.xpub,
    pubkey: k.pubkey, fingerprint: k.fingerprint, masterFingerprint: k.masterFingerprint,
    derivationPath: k.derivationPath, network: k.network, origin: k.origin,
  };
}

function friendlyCompileError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('duplicatepubkeys') || m.includes('duplicate'))
    return 'The same key is used in more than one spending path. Make sure each slot uses a distinct key.';
  if (m.includes('invalidquorum') || m.includes('quorum'))
    return `${message}. Check that every quorum is between 1 and the number of keys in that group.`;
  if (m.includes('66 digits') || m.includes('pubkey hex'))
    return 'One of the selected keys is missing its public key. Delete it and generate a new one.';
  if (m.includes('network'))
    return 'All keys in a vault must be on the same network (all testnet, all signet, or all mainnet).';
  if (m.includes('failed to fetch') || m.includes('non-json') || m.includes('502') || m.includes('503'))
    return 'The compiler did not respond. It may be waking from idle -- wait a couple of seconds and try again.';
  if (m.includes('relativetimelockneedsabsolutefallback'))
    return 'An "if untouched for" path can\'t be the only fallback -- add a fixed-date path too, or turn this one off.';
  if (m.includes('relativetimelocktoolong'))
    return `An "if untouched for" path can't wait longer than about 13.7 months (${MAX_RELATIVE_BLOCKS} blocks). Use a fixed-date path instead for a longer wait.`;
  if (m.includes('noimmediateleaf'))
    return 'Every vault needs at least one path that can spend right away.';
  if (m.includes('decayrequirestimelock'))
    return 'The step-down option only applies to a path that waits for something -- turn on a fixed date or "if untouched for" first.';
  return message;
}

const STEP_LABELS: Record<Step, string> = {
  configure: 'Shape', keys: 'Keys', compile: 'Compile', backup: 'Backup', fund: 'Fund', done: 'Done',
};
const STEP_ORDER: Step[] = ['configure', 'keys', 'compile', 'backup', 'fund', 'done'];

function StepRail({ current }: { current: Step }) {
  const idx = STEP_ORDER.indexOf(current);
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 20, flexWrap: 'wrap' }}>
      {STEP_ORDER.map((s, i) => {
        const active = i === idx;
        const done = i < idx;
        return (
          <div
            key={s}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
              color: active ? colors.gold : done ? colors.green : colors.muted,
              fontWeight: active ? 700 : 500,
            }}
          >
            <span
              style={{
                width: 18, height: 18, borderRadius: '50%', display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700,
                background: active ? colors.gold : done ? colors.green : colors.raised,
                color: active || done ? colors.bg : colors.muted,
              }}
            >
              {done ? 'v' : i + 1}
            </span>
            {STEP_LABELS[s]}
            {i < STEP_ORDER.length - 1 && <span style={{ color: colors.border, margin: '0 2px' }}>--</span>}
          </div>
        );
      })}
    </div>
  );
}

export default function VaultWizard() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [allKeys, setAllKeys] = useState<LocalKey[]>([]);
  useEffect(() => { setAllKeys(listKeys().filter(k => k.status === 'active')); }, []);
  const refreshKeys = () => setAllKeys(listKeys().filter(k => k.status === 'active'));

  const [shape, setShape] = useState<Shape>('standard');
  const [step, setStep] = useState<Step>('configure');
  const [name, setName] = useState('My Vault');
  // Signet, not testnet -- testnet3's faucets are unreliable and its
  // consensus rules make block timing erratic; every scenario/template's
  // own copy already says "signet faucet." Defaulting here to testnet was
  // the trap: nothing stopped a new vault from silently landing on the
  // network this app doesn't actually support end to end.
  const [network, setNetwork] = useState<NetworkChoice>('signet');

  const [stdConfig, setStdConfig] = useState<StandardConfig>(DEFAULT_STANDARD_CONFIG);
  const [blocConfig, setBlocConfig] = useState<BlocConfig>(DEFAULT_BLOC_CONFIG);
  const [leafDrafts, setLeafDrafts] = useState<LeafDraft[]>(() => [defaultPrimaryLeaf()]);
  const [activeLeafTab, setActiveLeafTab] = useState<string | null>(null);
  const [leafDirty, setLeafDirty] = useState(false);
  // Kept only for its hand-written trustDoc.purpose line -- everything else
  // the trust doc needs is computed fresh from stdConfig/blocConfig at
  // compile time, so it stays accurate even if the user tunes quorums or
  // timelocks away from the template's defaults. Null when the user opened
  // the builder directly (no template prefill); buildStandardTrustDoc /
  // buildBlocTrustDoc both fall back to a generated purpose line in that case.
  const [selectedTemplate, setSelectedTemplate] = useState<VaultTemplate | null>(null);

  // Consumed once, same contract StartVault/ChatWizard already use --
  // an all-zero VaultProposal means "use the template's own defaults."
  useEffect(() => {
    const prefill = (location.state as { prefill?: VaultProposal } | null)?.prefill;
    if (!prefill || typeof prefill.template !== 'string') return;
    if (prefill.template === 'bloc') {
      setShape('bloc');
      setName('Family Bloc');
      window.history.replaceState({}, '');
      return;
    }
    if (prefill.template === 'leaves') {
      setShape('leaves');
      setName('My Vault');
      setLeafDrafts(() => [defaultPrimaryLeaf()]);
      setActiveLeafTab('simple');
      window.history.replaceState({}, '');
      return;
    }
    const t = VAULT_TEMPLATES.find(t => t.id === prefill.template);
    if (!t) return;
    setShape('standard');
    setName(t.title);
    setStdConfig(templateToStandardConfig(t));
    setSelectedTemplate(t);
    window.history.replaceState({}, '');
  }, [location.state]);

  // Selected keys per role, keyed off allKeys so removing/archiving a key
  // elsewhere is reflected here too.
  const [founderKeys, setFounderKeys] = useState<SelectedKey[]>([]);
  const [heirKeys, setHeirKeys] = useState<SelectedKey[]>([]);
  const [protectorKeys, setProtectorKeys] = useState<SelectedKey[]>([]);
  const [consentKeys, setConsentKeys] = useState<SelectedKey[]>([]);
  const [backupKeys, setBackupKeys] = useState<SelectedKey[]>([]);
  const [secondHeirKeys, setSecondHeirKeys] = useState<SelectedKey[]>([]);
  const [parentKeys, setParentKeys] = useState<SelectedKey[]>([]);
  const [kidKeys, setKidKeys] = useState<SelectedKey[]>([]);
  // Generic leaf-list vault: keyed by leaf id rather than a fixed set of
  // named useState vars, since the id list is whatever the operator built
  // in Configure, not a known-in-advance set of roles.
  const [leafKeys, setLeafKeys] = useState<Record<string, SelectedKey[]>>({});

  const [draftVault, setDraftVault] = useState<Vault | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [configureErr, setConfigureErr] = useState<string | null>(null);
  const [networkBusy, setNetworkBusy] = useState(false);

  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState<string | null>(null);
  const [compiledVault, setCompiledVault] = useState<Vault | null>(null);

  const [metalBackedUp, setMetalBackedUp] = useState(false);

  // Inline key creation: which role slot triggered it, and the
  // just-generated key waiting on a backup decision. `verifyingBackup`
  // distinguishes the two screens `pendingBackup` can show: the initial
  // "back up now or later" choice (KeyCreatedPrompt), then -- only if
  // they chose "now" -- the actual write-down-and-verify ritual
  // (BackupFlow). Either path adds the key to its role slot; choosing
  // "later" just skips straight there, leaving keystore.ts's
  // `backedUp: false` as the standing reminder.
  const [genRole, setGenRole] = useState<string | null>(null);
  const [pendingBackup, setPendingBackup] = useState<{ key: LocalKey; mnemonic: string; role: string } | null>(null);
  const [verifyingBackup, setVerifyingBackup] = useState(false);

  function addKeyToRole(role: string, key: LocalKey) {
    const sk = toSelected(key);
    if (role === 'founder') setFounderKeys(p => [...p, sk]);
    else if (role === 'heir') setHeirKeys(p => [...p, sk]);
    else if (role === 'protector') setProtectorKeys(p => [...p, sk]);
    else if (role === 'consent') setConsentKeys(p => [...p, sk]);
    else if (role === 'backup') setBackupKeys(p => [...p, sk]);
    else if (role === 'second_heir') setSecondHeirKeys(p => [...p, sk]);
    else if (role === 'parent') setParentKeys(p => [...p, sk]);
    else if (role === 'kid') setKidKeys(p => [...p, sk]);
    // Any other role string is a leaf id from the generic leaf-list
    // builder -- there's no fixed set of those to enumerate up front.
    else setLeafKeys(p => ({ ...p, [role]: [...(p[role] ?? []), sk] }));
  }

  // Resume an existing draft. Reached from VaultDetail's "Continue setup"
  // button (2026-08-13 fix -- operator: "When saving a draft something is
  // wrong with it. Not saving progress. Just spits you into a vault
  // unfinished and can't go back either"). Before this, "Save and finish
  // later" on the Keys step navigated straight to VaultDetail and the
  // wizard's local key-slot selections (founderKeys/heirKeys/etc, never
  // sent to the server -- direct_keys mode posts them all at once, only
  // at final compile) were simply discarded on unmount; VaultDetail's own
  // draft view only understands the separate vault_members invite flow,
  // so there was no way back into this wizard at all.
  //
  // The keys themselves are never lost -- generateTestKey/generateSoftwareKey/
  // importXpub all write straight into the local keystore, independent of
  // this component's state -- what resume needs to reconstruct is only the
  // draft's saved SHAPE, so the Keys step re-renders with the right role
  // slots to re-pick from. Configure already ran once for this vault; running
  // it again here would create a SECOND draft row via createDraft/createBlocDraft,
  // so resume jumps directly to 'keys' and skips Configure entirely.
  //
  // Not every StandardConfig/BlocConfig field the wizard needs has a
  // matching column -- "planned" counts for protector/consent/backup/second-heir
  // (and Bloc's plannedParents/plannedKids) exist only to tell the Keys step
  // how many slots to render and were never persisted server-side. Falling
  // back to the group's own quorum as the planned count is an honest floor --
  // enough keys to reach quorum -- and the owner can still add more slots by
  // hand in the Keys step if the original plan called for extra signers.
  useEffect(() => {
    const resumeId = (location.state as { resumeVaultId?: string } | null)?.resumeVaultId;
    if (!resumeId) return;
    window.history.replaceState({}, '');
    (async () => {
      try {
        // showArchived=true here means "don't filter archived," not
        // "archived only" (see netlify/functions/vaults.js) -- one call
        // covers a draft whether or not it happens to be archived.
        const { vaults } = await api.vaults.list(true);
        const v = vaults.find(x => x.id === resumeId);
        if (!v) return;
        setDraftVault(v);
        setName(v.name);
        setNetwork(v.network);
        if (v.bloc_policy) {
          const bp = v.bloc_policy;
          setShape('bloc');
          setBlocConfig({
            plannedParents: Math.max(bp.parents_together_quorum || DEFAULT_BLOC_CONFIG.plannedParents, DEFAULT_BLOC_CONFIG.plannedParents),
            parentsTogetherQ: bp.parents_together_quorum || DEFAULT_BLOC_CONFIG.parentsTogetherQ,
            coparentQ: bp.coparent_quorum || DEFAULT_BLOC_CONFIG.coparentQ,
            kidsWithParentQ: bp.kids_with_parent_quorum || DEFAULT_BLOC_CONFIG.kidsWithParentQ,
            parentSoloQ: bp.parent_solo_quorum || DEFAULT_BLOC_CONFIG.parentSoloQ,
            parentSoloAfter: bp.parent_solo_after || DEFAULT_BLOC_CONFIG.parentSoloAfter,
            plannedKids: Math.max(bp.kids_decay_start_quorum || DEFAULT_BLOC_CONFIG.plannedKids, DEFAULT_BLOC_CONFIG.plannedKids),
            kidsDecayStartQ: bp.kids_decay_start_quorum || DEFAULT_BLOC_CONFIG.kidsDecayStartQ,
            kidsDecayFloorQ: bp.kids_decay_floor_quorum || DEFAULT_BLOC_CONFIG.kidsDecayFloorQ,
            kidsDecayStartAfter: bp.kids_decay_start_after || DEFAULT_BLOC_CONFIG.kidsDecayStartAfter,
            kidsDecayStepBlocks: bp.kids_decay_step_blocks || DEFAULT_BLOC_CONFIG.kidsDecayStepBlocks,
          });
        } else {
          setShape('standard');
          setStdConfig({
            mode: v.inheritance_after > 0 ? 'inheritance' : 'plain',
            plannedFounders: v.planned_founder_count ?? v.founder_quorum,
            founderQ: v.founder_quorum,
            plannedHeirs: v.planned_heir_count ?? v.heir_quorum,
            heirQ: v.heir_quorum,
            recoveryEnabled: v.recovery_after > 0,
            recoveryAfter: v.recovery_after > 0 ? v.recovery_after : DEFAULT_STANDARD_CONFIG.recoveryAfter,
            inheritanceAfter: v.inheritance_after > 0 ? v.inheritance_after : DEFAULT_STANDARD_CONFIG.inheritanceAfter,
            protectorEnabled: v.protector_quorum != null,
            protectorAfter: v.protector_after ?? DEFAULT_STANDARD_CONFIG.protectorAfter,
            protectorQ: v.protector_quorum ?? DEFAULT_STANDARD_CONFIG.protectorQ,
            plannedProtectors: v.protector_quorum ?? DEFAULT_STANDARD_CONFIG.plannedProtectors,
            consentEnabled: v.consent_quorum != null,
            consentQ: v.consent_quorum ?? DEFAULT_STANDARD_CONFIG.consentQ,
            plannedConsenters: v.consent_quorum ?? DEFAULT_STANDARD_CONFIG.plannedConsenters,
            backupEnabled: v.backup_quorum != null,
            backupQ: v.backup_quorum ?? DEFAULT_STANDARD_CONFIG.backupQ,
            plannedBackups: v.backup_quorum ?? DEFAULT_STANDARD_CONFIG.plannedBackups,
            secondInheritanceEnabled: v.second_heir_quorum != null,
            secondInheritanceAfter: v.second_inheritance_after ?? DEFAULT_STANDARD_CONFIG.secondInheritanceAfter,
            secondHeirQ: v.second_heir_quorum ?? DEFAULT_STANDARD_CONFIG.secondHeirQ,
            plannedSecondHeirs: v.second_heir_quorum ?? DEFAULT_STANDARD_CONFIG.plannedSecondHeirs,
          });
        }
        setStep('keys');
      } catch {
        // best-effort -- worst case the owner lands on a blank wizard and
        // starts the vault over, same as before this fix existed
      }
    })();
  }, [location.state]);

  async function onGenerateKey(role: string, mode: 'test' | 'secure', password?: string) {
    const label = `${role[0].toUpperCase()}${role.slice(1)} ${Date.now().toString().slice(-4)}`;
    const netForKey = network === 'bitcoin' ? 'mainnet' : network;
    if (mode === 'test') {
      const { key, mnemonic } = generateTestKey({ label, network: netForKey, persona: role });
      refreshKeys();
      setPendingBackup({ key, mnemonic, role });
    } else {
      const { key, mnemonic } = await generateSoftwareKey({ label, network: netForKey, password: password!, persona: role });
      refreshKeys();
      setPendingBackup({ key, mnemonic, role });
    }
    setGenRole(null);
  }

  function onImportXpub(role: string, xpub: string, derivationPath: string, masterFingerprint?: string) {
    const netForKey = network === 'bitcoin' ? 'mainnet' : network;
    const key = importXpub({ label: `${role[0].toUpperCase()}${role.slice(1)} (imported)`, network: netForKey, xpub, derivationPath, persona: role, masterFingerprint });
    refreshKeys();
    addKeyToRole(role, key);
    setGenRole(null);
  }

  function onImportTapitKey(role: string, xOnlyPubkey: string) {
    const netForKey = network === 'bitcoin' ? 'mainnet' : network;
    const key = importTapitPubkey({ label: `${role[0].toUpperCase()}${role.slice(1)} (Tapit)`, network: netForKey, xOnlyPubkey, persona: role });
    refreshKeys();
    addKeyToRole(role, key);
    setGenRole(null);
  }

  // ---- Configure -> create the draft row -------------------------------

  async function confirmConfigure() {
    setConfiguring(true);
    setConfigureErr(null);
    try {
      if (shape === 'standard') {
        const c = stdConfig;
        const res = await api.vaults.createDraft({
          name,
          network,
          address_type: 'tr_multileaf',
          founder_quorum: c.founderQ,
          heir_quorum: c.mode === 'inheritance' ? c.heirQ : 1,
          recovery_after: c.mode === 'inheritance' && c.recoveryEnabled ? c.recoveryAfter : 0,
          inheritance_after: c.mode === 'inheritance' ? c.inheritanceAfter : 0,
          planned_founder_count: c.plannedFounders,
          planned_heir_count: c.mode === 'inheritance' ? c.plannedHeirs : 0,
          protector_quorum: c.protectorEnabled ? c.protectorQ : null,
          protector_after: c.protectorEnabled ? c.protectorAfter : null,
          consent_quorum: c.consentEnabled ? c.consentQ : null,
          backup_quorum: c.backupEnabled ? c.backupQ : null,
          second_heir_quorum: c.secondInheritanceEnabled ? c.secondHeirQ : null,
          second_inheritance_after: c.secondInheritanceEnabled ? c.secondInheritanceAfter : null,
        });
        setDraftVault(res.vault);
      } else if (shape === 'leaves') {
        const enabled = leafDrafts.filter(l => l.enabled);
        const res = await api.vaults.createLeavesDraft({
          name,
          network,
          address_type: 'tr_multileaf',
          leaves: enabled.map(l => leafDraftToSpec(l, [])),
        });
        setDraftVault(res.vault);
      } else {
        const c = blocConfig;
        const bp: Partial<BlocPolicy> = {
          parents_together_quorum: c.parentsTogetherQ,
          coparent_quorum: c.coparentQ,
          kids_with_parent_quorum: c.kidsWithParentQ,
          parent_solo_quorum: c.parentSoloQ,
          parent_solo_after: c.parentSoloAfter, // relative -- converted at compile time
          kids_decay_start_quorum: c.kidsDecayStartQ,
          kids_decay_floor_quorum: c.kidsDecayFloorQ,
          kids_decay_start_after: c.kidsDecayStartAfter, // relative
          kids_decay_step_blocks: c.kidsDecayStepBlocks,
        };
        const res = await api.vaults.createBlocDraft({ name, network, address_type: 'tr_multileaf', bloc_policy: bp });
        setDraftVault(res.vault);
      }
      setStep('keys');
    } catch (e) {
      setConfigureErr(e instanceof Error ? e.message : 'Could not save this vault shape');
    } finally {
      setConfiguring(false);
    }
  }

  // Operator, 2026-08-15: "you should pick the network upfront... can't
  // do it when managing keys." The common real case is resuming a draft
  // later specifically to link keys (line ~342 above skips Configure
  // entirely on resume), landing in the Keys step with whatever network
  // the draft happened to be created with and no way to change it short
  // of abandoning the vault. Only ever called while KeysStep's own
  // `claimed` set is empty (see its "Change network" control below) --
  // once any key has been added this session, switching networks out
  // from under it would leave a wrong-network key silently selected.
  async function changeNetwork(n: NetworkChoice) {
    if (!draftVault || n === network) return;
    setNetworkBusy(true);
    try {
      const res = await api.vaults.updateNetwork(draftVault.id, n);
      setDraftVault(res.vault);
      setNetwork(n);
      toast.success(`Network set to ${n}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change network');
    } finally {
      setNetworkBusy(false);
    }
  }

  // ---- Keys -> compile once every slot is filled ------------------------

  const slotsReady = useMemo(() => {
    if (shape === 'standard') {
      const c = stdConfig;
      const foundersReady = founderKeys.length >= c.plannedFounders;
      const heirsReady = c.mode !== 'inheritance' || c.plannedHeirs === 0 || heirKeys.length >= c.plannedHeirs;
      const protectorsReady = !c.protectorEnabled || protectorKeys.length >= c.plannedProtectors;
      const consentersReady = !c.consentEnabled || consentKeys.length >= c.plannedConsenters;
      const backupsReady = !c.backupEnabled || backupKeys.length >= c.plannedBackups;
      const secondHeirsReady = !c.secondInheritanceEnabled || secondHeirKeys.length >= c.plannedSecondHeirs;
      return foundersReady && heirsReady && protectorsReady && consentersReady && backupsReady && secondHeirsReady;
    }
    if (shape === 'leaves') {
      return leafDrafts.filter(l => l.enabled).every(l => (leafKeys[l.id]?.length ?? 0) >= l.plannedKeys);
    }
    const c = blocConfig;
    return parentKeys.length >= c.plannedParents && kidKeys.length >= c.plannedKids;
  }, [shape, stdConfig, blocConfig, leafDrafts, leafKeys, founderKeys, heirKeys, protectorKeys, consentKeys, backupKeys, secondHeirKeys, parentKeys, kidKeys]);

  // Best-effort: the vault is already compiled and usable by the time this
  // runs, so a failed save here shouldn't surface as a compile error --
  // the owner can always fill the trust doc in by hand from the Trust tab.
  // Never overwrites a trust doc that's already got something in it -- a
  // "Save and finish later" draft could have been personalized from
  // VaultDetail's own trust doc editor before the owner came back here to
  // finish compiling, and this only exists to replace a blank slate.
  async function saveGeneratedTrustDoc(vaultId: string, doc: TrustDoc) {
    const existing = draftVault?.trust_doc;
    const alreadyHasContent =
      !!existing && (!!existing.purpose || !!existing.distribution_rules || !!existing.succession_notes || !!(existing.beneficiaries ?? []).length);
    if (alreadyHasContent) return;
    try {
      await api.vaults.updateTrustDoc(vaultId, doc);
    } catch {
      // silent -- non-critical
    }
  }

  async function runCompile() {
    if (!draftVault) return;
    setCompiling(true);
    setCompileErr(null);
    try {
      if (shape === 'standard') {
        const toDirect = (keys: SelectedKey[]) => keys.map(k => ({
          pubkey: toPubkeyHex(k), xpub: k.xpub,
          fingerprint: k.masterFingerprint ?? k.fingerprint, derivation_path: k.derivationPath,
        }));
        const res = await api.vaults.compile(draftVault.id, {
          founder_keys: toDirect(founderKeys),
          heir_keys: toDirect(heirKeys),
          protector_keys: stdConfig.protectorEnabled ? toDirect(protectorKeys) : [],
          consent_keys: stdConfig.consentEnabled ? toDirect(consentKeys) : [],
          backup_keys: stdConfig.backupEnabled ? toDirect(backupKeys) : [],
          second_heir_keys: stdConfig.secondInheritanceEnabled ? toDirect(secondHeirKeys) : [],
        });
        // Upgrade the descriptor to Nunchuk/Sparrow key-origin form,
        // same post-processing PolicyBuilder's save() already did.
        const origins = buildKeyOrigins([...founderKeys, ...heirKeys, ...protectorKeys, ...consentKeys, ...backupKeys, ...secondHeirKeys]);
        const upgraded = res.vault.descriptor ? upgradeDescriptor(res.vault.descriptor, origins) : res.vault.descriptor;
        setCompiledVault({ ...res.vault, descriptor: upgraded });
        void saveGeneratedTrustDoc(res.vault.id, buildStandardTrustDoc({
          vaultName: name,
          templatePurpose: selectedTemplate?.trustDoc?.purpose,
          config: stdConfig,
        }));
      } else if (shape === 'leaves') {
        const enabled = leafDrafts.filter(l => l.enabled);
        const leavesWithKeys = enabled.map(l => leafDraftToSpec(l, (leafKeys[l.id] ?? []).map(toPubkeyHex)));
        await api.vaults.updateLeaves(draftVault.id, leavesWithKeys);
        const res = await api.vaults.compileLeaves(draftVault.id);
        const allLeafKeys = enabled.flatMap(l => leafKeys[l.id] ?? []);
        const origins = buildKeyOrigins(allLeafKeys);
        const upgraded = res.vault.descriptor ? upgradeDescriptor(res.vault.descriptor, origins) : res.vault.descriptor;
        setCompiledVault({ ...res.vault, descriptor: upgraded });
        // Trust-doc auto-generation for an arbitrary, operator-shaped
        // path list has no template to draw from the way the standard
        // and Bloc shapes do (buildStandardTrustDoc/buildBlocTrustDoc) --
        // left blank for the owner to fill in from the Trust tab, same
        // as saveGeneratedTrustDoc's own no-op path for a vault that
        // already has content.
      } else {
        const res = await api.vaults.compileBloc({
          vault_id: draftVault.id,
          parent_keys: parentKeys.map(toPubkeyHex),
          kid_keys: kidKeys.map(toPubkeyHex),
          parent_xpubs: parentKeys.map(k => k.xpub),
          kid_xpubs: kidKeys.map(k => k.xpub),
          key_origins: buildPsbtKeyOrigins([...parentKeys, ...kidKeys]),
        });
        const origins = buildKeyOrigins([...parentKeys, ...kidKeys]);
        const upgraded = res.vault.descriptor ? upgradeDescriptor(res.vault.descriptor, origins) : res.vault.descriptor;
        setCompiledVault({ ...res.vault, descriptor: upgraded });
        void saveGeneratedTrustDoc(res.vault.id, buildBlocTrustDoc({ vaultName: name, config: blocConfig }));
      }
      setStep('backup');
    } catch (e) {
      setCompileErr(friendlyCompileError(e instanceof Error ? e.message : 'Compile failed'));
    } finally {
      setCompiling(false);
    }
  }

  // ---- Bloc live behavior-timeline preview (Configure step) -------------

  const blocLegs: SpendLeg[] = useMemo(() => {
    const c = blocConfig;
    const legs: SpendLeg[] = [
      { label: 'Parents together', who: `${c.parentsTogetherQ} of ${c.plannedParents} parents`, afterBlocks: 0, requiredSigners: c.parentsTogetherQ, meaning: 'Any normal spend, right away.' },
      { label: 'One parent + the kids', who: `${c.coparentQ} parent + ${c.kidsWithParentQ} of ${c.plannedKids} kids`, afterBlocks: 0, requiredSigners: c.coparentQ + c.kidsWithParentQ, meaning: 'A parent teaches/co-signs with the kids, right away.' },
      { label: 'One parent alone', who: `${c.parentSoloQ} of ${c.plannedParents} parents`, afterBlocks: c.parentSoloAfter, requiredSigners: c.parentSoloQ, meaning: 'Backstop if the other parent is unreachable.' },
    ];
    for (let q = c.kidsDecayStartQ; q >= c.kidsDecayFloorQ; q--) {
      legs.push({
        label: `Kids alone (${q}-of-${c.plannedKids})`,
        who: `${q} of ${c.plannedKids} kids`,
        afterBlocks: c.kidsDecayStartAfter + (c.kidsDecayStartQ - q) * c.kidsDecayStepBlocks,
        requiredSigners: q,
        meaning: q === 1 ? 'Any single kid, alone.' : `Any ${q} kids together.`,
        weak: q === 1,
      });
    }
    return legs;
  }, [blocConfig]);

  // ---- Leaf-list live behavior-timeline preview (Configure step) --------
  // Full generalization of BehaviorTimeline's grouping (an "if untouched
  // for" path visually grouped alongside an "after" path at the same
  // block count) is task #142's scope; this stays honest by spelling the
  // difference out in each leg's own meaning text.
  const leafLegs: SpendLeg[] = useMemo(() => {
    const legs: SpendLeg[] = [];
    for (const l of leafDrafts) {
      if (!l.enabled) continue;
      if (l.unlockType === 'immediate') {
        legs.push({
          label: l.label, who: `${l.quorum} of ${l.plannedKeys}`, afterBlocks: 0,
          requiredSigners: l.quorum, meaning: 'Any normal spend, right away.',
        });
        continue;
      }
      const rungs = l.decayEnabled
        ? Array.from({ length: Math.max(1, l.quorum - l.decayFloorQ + 1) }, (_, i) => l.quorum - i)
        : [l.quorum];
      for (const [i, q] of rungs.entries()) {
        const isOlder = l.unlockType === 'older';
        const base = isOlder ? l.olderBlocks : l.afterBlocks;
        const height = base + (l.decayEnabled ? i * l.decayStepBlocks : 0);
        legs.push({
          label: rungs.length > 1 ? `${l.label} (${q} of ${l.plannedKeys})` : l.label,
          who: `${q} of ${l.plannedKeys}`,
          afterBlocks: height,
          requiredSigners: q,
          meaning: isOlder
            ? `Opens if the vault sits untouched for ${blocksToHuman(height)} -- moving the coins resets this clock back to full strength.`
            : rungs.length > 1
              ? `From ${blocksToHuman(height)} after funding, any ${q} can spend together.`
              : `From ${blocksToHuman(height)} after funding, on its own.`,
          weak: l.decayEnabled && q === 1,
        });
      }
    }
    return legs;
  }, [leafDrafts]);

  // ---- Standard-shape live behavior-timeline preview (Configure step) ---
  // Parity with the Bloc/leaf-list previews above -- see
  // vault-education.ts's buildStandardLegs for the leg-building logic
  // itself.
  const stdLegs: SpendLeg[] = useMemo(() => buildStandardLegs(stdConfig), [stdConfig]);

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <StepRail current={step} />

      {step === 'configure' && (
        <ConfigureStep
          shape={shape} setShape={setShape}
          name={name} setName={setName}
          network={network} setNetwork={setNetwork}
          stdConfig={stdConfig} setStdConfig={setStdConfig}
          stdLegs={stdLegs}
          blocConfig={blocConfig} setBlocConfig={setBlocConfig}
          blocLegs={blocLegs}
          leafDrafts={leafDrafts} setLeafDrafts={setLeafDrafts}
          leafLegs={leafLegs}
          activeLeafTab={activeLeafTab} setActiveLeafTab={setActiveLeafTab}
          leafDirty={leafDirty} setLeafDirty={setLeafDirty}
          onConfirm={confirmConfigure}
          busy={configuring}
          err={configureErr}
        />
      )}

      {step === 'keys' && draftVault && (
        <KeysStep
          shape={shape}
          stdConfig={stdConfig}
          blocConfig={blocConfig}
          leafDrafts={leafDrafts}
          leafKeys={leafKeys} setLeafKeys={setLeafKeys}
          allKeys={allKeys}
          founderKeys={founderKeys} setFounderKeys={setFounderKeys}
          heirKeys={heirKeys} setHeirKeys={setHeirKeys}
          protectorKeys={protectorKeys} setProtectorKeys={setProtectorKeys}
          consentKeys={consentKeys} setConsentKeys={setConsentKeys}
          backupKeys={backupKeys} setBackupKeys={setBackupKeys}
          secondHeirKeys={secondHeirKeys} setSecondHeirKeys={setSecondHeirKeys}
          parentKeys={parentKeys} setParentKeys={setParentKeys}
          kidKeys={kidKeys} setKidKeys={setKidKeys}
          network={network}
          onChangeNetwork={changeNetwork}
          networkBusy={networkBusy}
          genRole={genRole} setGenRole={setGenRole}
          onGenerateKey={onGenerateKey}
          onImportXpub={onImportXpub}
          onImportTapitKey={onImportTapitKey}
          slotsReady={slotsReady}
          onContinue={() => { setStep('compile'); void runCompile(); }}
          onSaveForLater={() => {
            toast.success('Draft saved. Your keys stay in your keystore -- use "Continue setup" on this vault to pick up where you left off.');
            navigate(`/vaults/${draftVault.id}`, { state: { vault: draftVault } });
          }}
        />
      )}

      {step === 'compile' && (
        <Card>
          <div style={{ padding: 24, textAlign: 'center' }}>
            {compiling && <p style={{ color: colors.muted }}>Setting up your vault...</p>}
            {compileErr && (
              <>
                <p style={{ color: colors.red, marginBottom: 12 }}>{compileErr}</p>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                  <Button variant="ghost" onClick={() => setStep('keys')}>Back to keys</Button>
                  <Button onClick={() => void runCompile()}>Try again</Button>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      {step === 'backup' && compiledVault && (
        <BackupStep
          vault={compiledVault}
          metalBackedUp={metalBackedUp}
          setMetalBackedUp={setMetalBackedUp}
          onContinue={() => setStep('fund')}
        />
      )}

      {step === 'fund' && compiledVault?.address && (
        <Card>
          <FundingStep
            address={compiledVault.address}
            network={compiledVault.network}
            onFunded={() => setStep('done')}
            onSkip={() => setStep('done')}
          />
        </Card>
      )}

      {step === 'done' && compiledVault && (
        <Card>
          <div style={{ padding: 24, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
            <div style={{ fontSize: 32 }}>check</div>
            <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>Your vault is ready</div>
            <Button onClick={() => navigate(`/vaults/${compiledVault.id}`, { state: { vault: compiledVault } })}>
              Open vault
            </Button>
          </div>
        </Card>
      )}

      {pendingBackup && !verifyingBackup && (
        <KeyCreatedPrompt
          keyData={pendingBackup.key}
          mnemonic={pendingBackup.mnemonic}
          onBackupNow={() => setVerifyingBackup(true)}
          onBackupLater={() => {
            addKeyToRole(pendingBackup.role, pendingBackup.key);
            setPendingBackup(null);
          }}
        />
      )}
      {pendingBackup && verifyingBackup && (
        <BackupFlow
          keyData={pendingBackup.key}
          mnemonic={pendingBackup.mnemonic}
          onDone={() => {
            addKeyToRole(pendingBackup.role, pendingBackup.key);
            setPendingBackup(null);
            setVerifyingBackup(false);
          }}
        />
      )}
    </div>
  );
}

// ── Configure ─────────────────────────────────────────────────────────

function ConfigureStep({
  shape, setShape, name, setName, network, setNetwork,
  stdConfig, setStdConfig, stdLegs, blocConfig, setBlocConfig, blocLegs,
  leafDrafts, setLeafDrafts, leafLegs, activeLeafTab, setActiveLeafTab, leafDirty, setLeafDirty,
  onConfirm, busy, err,
}: {
  shape: Shape; setShape: (s: Shape) => void;
  name: string; setName: (n: string) => void;
  network: NetworkChoice; setNetwork: (n: NetworkChoice) => void;
  stdConfig: StandardConfig; setStdConfig: (fn: (c: StandardConfig) => StandardConfig) => void;
  stdLegs: SpendLeg[];
  blocConfig: BlocConfig; setBlocConfig: (fn: (c: BlocConfig) => BlocConfig) => void;
  blocLegs: SpendLeg[];
  leafDrafts: LeafDraft[]; setLeafDrafts: (fn: (l: LeafDraft[]) => LeafDraft[]) => void;
  leafLegs: SpendLeg[];
  activeLeafTab: string | null; setActiveLeafTab: (id: string | null) => void;
  leafDirty: boolean; setLeafDirty: (b: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  err: string | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Vault name">
            <Input value={name} onChange={e => setName(e.target.value)} />
          </Field>
          <Field label="Network">
            <div style={{ display: 'flex', gap: 8 }}>
              {/* Testnet deliberately isn't offered here -- one real test
                  network only (signet), matching every template's own
                  "fund from the signet faucet" copy. Offering both let a
                  vault silently land on the one this app doesn't actually
                  support end to end (unreliable faucets, erratic block
                  timing). Existing testnet vaults from before this change
                  still load fine; nothing NEW gets created there. */}
              {(['signet', 'bitcoin'] as const).map(n => (
                <Button key={n} size="sm" variant={network === n ? 'primary' : 'ghost'} onClick={() => setNetwork(n)}>
                  {n}
                </Button>
              ))}
            </div>
          </Field>
          <Field label="Shape">
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant={shape === 'standard' ? 'primary' : 'ghost'} onClick={() => setShape('standard')}>
                Founders / heirs
              </Button>
              <Button size="sm" variant={shape === 'bloc' ? 'primary' : 'ghost'} onClick={() => setShape('bloc')}>
                Pass it to my kids
              </Button>
              <Button size="sm" variant={shape === 'leaves' ? 'primary' : 'ghost'} onClick={() => setShape('leaves')}>
                Build your own
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      {shape === 'standard' && <StandardConfigureFields config={stdConfig} setConfig={setStdConfig} />}
      {shape === 'bloc' && <BlocConfigureFields config={blocConfig} setConfig={setBlocConfig} />}
      {shape === 'leaves' && (
        <LeavesConfigureFields
          leafDrafts={leafDrafts} setLeafDrafts={setLeafDrafts}
          activeTab={activeLeafTab} setActiveTab={setActiveLeafTab}
          dirty={leafDirty} setDirty={setLeafDirty}
        />
      )}

      {shape === 'standard' && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 10 }}>
            How this vault behaves over time
          </div>
          <BehaviorTimeline legs={stdLegs} />
        </Card>
      )}
      {shape === 'bloc' && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 10 }}>
            How this vault behaves over time
          </div>
          <BehaviorTimeline legs={blocLegs} floorWarning={blocConfig.kidsDecayFloorQ === 1} kidCount={blocConfig.plannedKids} />
        </Card>
      )}
      {shape === 'leaves' && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 10 }}>
            How this vault behaves over time
          </div>
          <BehaviorTimeline legs={leafLegs} floorWarningText={leafFloorWarningText(leafDrafts)} />
        </Card>
      )}

      {err && <p style={{ color: colors.red, fontSize: 13 }}>{err}</p>}
      <Button disabled={busy} onClick={onConfirm} style={{ alignSelf: 'flex-start' }}>
        {busy ? 'Saving...' : 'Continue -- add keys next'}
      </Button>
    </div>
  );
}

// Operator, 2026-08-10, looking at the old single flowing form: "This is
// really confusing to even me a Bitcoiner ... those top keys are my first
// level. Then I always want my hard backup no time lock. Then inheritance
// timelocked out with heir keys only. Each with its own section and
// settings and more precise clarity on what each is doing to the wallet
// in easy to read and understand. No fluff. Or big words." Rebuilt as
// three separate, numbered, always-visible sections matching that exact
// mental model -- no config shape changed, no new fields, this is
// presentation and wording only. "Recovery" (founders-after-a-delay) and
// "protector" were never part of the operator's own three-part model, so
// they move into a clearly-separate, still-optional section at the end
// instead of sitting inside the inheritance block where they used to
// confuse the heir-only path.
function StandardConfigureFields({ config, setConfig }: { config: StandardConfig; setConfig: (fn: (c: StandardConfig) => StandardConfig) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <SectionHeader step={1} title="Spend now" color={colors.gold} />
        <p style={{ fontSize: 13, color: colors.muted, marginTop: -4, marginBottom: 14 }}>
          Your everyday signers. The moment enough of them agree, funds move -- no waiting.
        </p>
        <Field label="How many people sign?">
          <CountStepper
            value={config.plannedFounders}
            min={1}
            label="signers"
            color={colors.gold}
            onChange={plannedFounders => setConfig(c => {
              // A quorum higher than the new signer count would fail
              // server-side at compile time with a raw Rust error
              // ("quorum must be > 0 and <= number of keys") and no
              // visible cue in the picker that anything needs fixing --
              // the button matching the stale quorum simply stops
              // rendering. Keep it valid the moment the count changes.
              return { ...c, plannedFounders, founderQ: Math.min(c.founderQ, plannedFounders) };
            })}
          />
          <QuorumPicker max={config.plannedFounders} value={config.founderQ} onChange={n => setConfig(c => ({ ...c, founderQ: n }))} color={colors.gold} />
        </Field>
        <p style={{ fontSize: 12, color: colors.muted, marginTop: -8 }}>
          {config.founderQ} of {config.plannedFounders} of these signers must agree to move funds, any time, forever --
          this path never expires and is never disabled by anything else on this page.
        </p>
      </Card>

      <Card>
        <SectionHeader step={2} title="Backup -- no waiting" color={colors.orange} />
        <p style={{ fontSize: 13, color: colors.muted, marginTop: -4, marginBottom: 14 }}>
          A second, separate set of keys that also works right away, with no waiting period -- for when your
          everyday signers above are lost, unavailable, or compromised. Keep these keys somewhere different
          from your everyday signers; making them harder to gather on purpose is what keeps this path safe.
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={config.backupEnabled}
            onChange={e => setConfig(c => ({
              ...c,
              backupEnabled: e.target.checked,
              // Mutually exclusive with recovery -- both occupy the same
              // tree slot server-side; turning backup on turns recovery
              // (and protector, which requires it) off.
              recoveryEnabled: e.target.checked ? false : c.recoveryEnabled,
              protectorEnabled: e.target.checked ? false : c.protectorEnabled,
            }))}
          />
          <span style={{ fontSize: 13, color: colors.sub }}>Add a backup path</span>
        </label>
        {config.backupEnabled ? (
          <div style={{ marginTop: 12 }}>
            <Field label="How many backup keys?">
              <CountStepper
                value={config.plannedBackups}
                min={1}
                label="backup keys"
                color={colors.orange}
                onChange={plannedBackups => setConfig(c => ({
                  ...c, plannedBackups, backupQ: Math.min(c.backupQ, plannedBackups) || 1,
                }))}
              />
              <QuorumPicker max={config.plannedBackups} value={config.backupQ} onChange={n => setConfig(c => ({ ...c, backupQ: n }))} color={colors.orange} />
            </Field>
            <p style={{ fontSize: 12, color: colors.muted, marginTop: -8 }}>
              {config.backupQ} of {config.plannedBackups} of these backup keys can move funds any time, with
              zero wait. Nothing about this path is on a clock -- the only friction is physically gathering
              enough of these keys, which is the point.
            </p>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
            Off. If your everyday signers above are ever lost or compromised, there is no separate way in
            until the inheritance wait below finishes.
          </p>
        )}
      </Card>

      <Card>
        <SectionHeader step={3} title="Inheritance -- heirs only, after a wait" color={colors.blue} />
        <p style={{ fontSize: 13, color: colors.muted, marginTop: -4, marginBottom: 14 }}>
          After the waiting period you set below, your heirs -- and only your heirs -- can move funds.
          Your everyday signers above cannot use this path once it opens, and nobody can use it before
          the wait is up.
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={config.mode === 'inheritance'}
            onChange={e => setConfig(c => ({ ...c, mode: e.target.checked ? 'inheritance' : 'plain' }))}
          />
          <span style={{ fontSize: 13, color: colors.sub }}>Add heirs + an inheritance path</span>
        </label>
        {config.mode === 'inheritance' ? (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Field label="How many heirs?">
              <CountStepper
                value={config.plannedHeirs}
                min={0}
                label="heirs"
                color={colors.blue}
                onChange={plannedHeirs => setConfig(c => {
                  // Same stale-quorum guard as plannedFounders above.
                  return { ...c, plannedHeirs, heirQ: Math.min(c.heirQ, plannedHeirs) || (plannedHeirs > 0 ? 1 : 0) };
                })}
              />
              {config.plannedHeirs > 0 && (
                <QuorumPicker max={config.plannedHeirs} value={config.heirQ} onChange={n => setConfig(c => ({ ...c, heirQ: n }))} color={colors.blue} />
              )}
            </Field>
            <TimelockField label="Inheritance unlocks after" value={config.inheritanceAfter} onChange={v => setConfig(c => ({ ...c, inheritanceAfter: v }))} />
            {config.plannedHeirs > 0 && (
              <p style={{ fontSize: 12, color: colors.muted, marginTop: -8 }}>
                Before {blocksToHuman(config.inheritanceAfter)}: only your everyday signers (and backup keys,
                if you turned that on above) can spend. After {blocksToHuman(config.inheritanceAfter)}:
                {' '}{config.heirQ} of {config.plannedHeirs} heirs can spend, on their own -- your everyday
                signers no longer have a say.
              </p>
            )}
          </div>
        ) : (
          <p style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
            Off. Funds only ever move through your everyday signers above (and backup keys, if that path
            is on) -- nothing passes to anyone else automatically.
          </p>
        )}
      </Card>

      {config.mode === 'inheritance' && config.plannedHeirs > 0 && (
        <Card>
          <SectionHeader step={4} title="Second inheritance -- a different heir group, its own wait" color={colors.green} />
          <p style={{ fontSize: 13, color: colors.muted, marginTop: -4, marginBottom: 14 }}>
            Optional. A completely separate group of heirs, with their own keys and their own waiting
            period -- independent of the inheritance path above. Use this for a second beneficiary group
            that should unlock sooner (or later) than the first, e.g. a spouse who can act quickly and
            extended family who wait longer.
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={config.secondInheritanceEnabled}
              onChange={e => setConfig(c => ({ ...c, secondInheritanceEnabled: e.target.checked }))}
            />
            <span style={{ fontSize: 13, color: colors.sub }}>Add a second inheritance path</span>
          </label>
          {config.secondInheritanceEnabled ? (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Field label="How many second-group heirs?">
                <CountStepper
                  value={config.plannedSecondHeirs}
                  min={1}
                  label="heirs"
                  color={colors.green}
                  onChange={plannedSecondHeirs => setConfig(c => ({
                    ...c, plannedSecondHeirs, secondHeirQ: Math.min(c.secondHeirQ, plannedSecondHeirs) || 1,
                  }))}
                />
                <QuorumPicker max={config.plannedSecondHeirs} value={config.secondHeirQ} onChange={n => setConfig(c => ({ ...c, secondHeirQ: n }))} color={colors.green} />
              </Field>
              <TimelockField label="Second inheritance unlocks after" value={config.secondInheritanceAfter} onChange={v => setConfig(c => ({ ...c, secondInheritanceAfter: v }))} />
              <p style={{ fontSize: 12, color: colors.muted, marginTop: -8 }}>
                After {blocksToHuman(config.secondInheritanceAfter)}, {config.secondHeirQ} of {config.plannedSecondHeirs}
                {' '}second-group heirs can spend, on their own -- entirely independent of the first inheritance
                path above; this timing has no required relationship to it, sooner or later both work.
              </p>
            </div>
          ) : (
            <p style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
              Off. Only the single inheritance path above exists.
            </p>
          )}
        </Card>
      )}

      <details open={config.recoveryEnabled || config.protectorEnabled || config.consentEnabled}>
        <summary style={{ fontSize: 12, color: colors.muted, cursor: 'pointer' }}>
          More options: recovery, protector + beneficiary consent
        </summary>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: config.backupEnabled ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox"
              checked={config.recoveryEnabled}
              disabled={config.backupEnabled}
              onChange={e => setConfig(c => ({
                ...c,
                recoveryEnabled: e.target.checked,
                // A protector branch requires a recovery branch --
                // turning recovery off while a protector is configured
                // would otherwise get rejected server-side.
                protectorEnabled: e.target.checked ? c.protectorEnabled : false,
              }))}
            />
            <span style={{ fontSize: 13, color: config.backupEnabled ? colors.muted : colors.sub }}>
              Also let everyday signers spend after a delay, before the heir-only path opens
              {config.backupEnabled && ' -- turned off while your backup path (section 2 above) is on; a vault can only have one of the two'}
            </span>
          </label>
          {config.recoveryEnabled && (
            <TimelockField label="Recovery unlocks after" value={config.recoveryAfter} onChange={v => setConfig(c => ({ ...c, recoveryAfter: v }))} />
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: config.recoveryEnabled ? 'pointer' : 'not-allowed' }}>
            <input
              type="checkbox"
              checked={config.protectorEnabled}
              disabled={!config.recoveryEnabled}
              onChange={e => setConfig(c => ({ ...c, protectorEnabled: e.target.checked }))}
            />
            <span style={{ fontSize: 13, color: config.recoveryEnabled ? colors.sub : colors.muted }}>
              Add a protector (independent rescue path){!config.recoveryEnabled && ' -- requires the recovery option above'}
            </span>
          </label>
          {config.protectorEnabled && (
            <TimelockField label="Protector unlocks after" value={config.protectorAfter} onChange={v => setConfig(c => ({ ...c, protectorAfter: v }))} />
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={config.consentEnabled} onChange={e => setConfig(c => ({ ...c, consentEnabled: e.target.checked }))} />
            <span style={{ fontSize: 13, color: colors.sub }}>Require beneficiary consent on every normal spend</span>
          </label>
        </div>
      </details>
    </div>
  );
}

function SectionHeader({ step, title, color }: { step: number; title: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
      <div
        style={{
          width: 22, height: 22, borderRadius: '50%', background: color,
          color: colors.bg, fontSize: 12, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}
      >
        {step}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>{title}</div>
    </div>
  );
}

function BlocConfigureFields({ config, setConfig }: { config: BlocConfig; setConfig: (fn: (c: BlocConfig) => BlocConfig) => void }) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="How many parents?">
          <CountStepper
            value={config.plannedParents}
            min={1}
            label="parents"
            color={colors.gold}
            onChange={plannedParents => setConfig(c => ({
              ...c, plannedParents, parentsTogetherQ: Math.min(c.parentsTogetherQ, plannedParents),
            }))}
          />
          <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>Parents together, right away:</div>
          <QuorumPicker max={config.plannedParents} value={config.parentsTogetherQ} onChange={n => setConfig(c => ({ ...c, parentsTogetherQ: n }))} color={colors.gold} />
        </Field>
        <Field label="How many kids?">
          <CountStepper
            value={config.plannedKids}
            min={1}
            label="kids"
            color={colors.blue}
            onChange={plannedKids => setConfig(c => ({
              ...c,
              plannedKids,
              kidsWithParentQ: Math.min(c.kidsWithParentQ, plannedKids),
              kidsDecayFloorQ: Math.min(c.kidsDecayFloorQ, plannedKids),
              // The decay ladder always starts by requiring every planned
              // kid (see the Keys-step copy: "N needed at first, one fewer
              // ... down to the floor") -- kidsDecayStartQ has no picker of
              // its own and must never be allowed to drift above the actual
              // kid count, or the ladder generates impossible rungs like
              // "3 of 1" (2026-08-15, caught by the operator reading the
              // live preview).
              kidsDecayStartQ: plannedKids,
            }))}
          />
        </Field>
        <Field label="One parent + how many kids, right away?">
          <QuorumPicker max={config.plannedKids} value={config.kidsWithParentQ} onChange={n => setConfig(c => ({ ...c, kidsWithParentQ: n }))} color={colors.blue} />
        </Field>
        <TimelockField label="One parent alone unlocks after" value={config.parentSoloAfter} onChange={v => setConfig(c => ({ ...c, parentSoloAfter: v }))} />
        <TimelockField label="Kids-alone ladder starts after" value={config.kidsDecayStartAfter} onChange={v => setConfig(c => ({ ...c, kidsDecayStartAfter: v }))} />
        <Field label="Every rung down the ladder, after">
          <TimelockField label="" value={config.kidsDecayStepBlocks} onChange={v => setConfig(c => ({ ...c, kidsDecayStepBlocks: v }))} />
        </Field>
        <Field label="Decay floor -- lowest number of kids that can ever spend alone">
          <QuorumPicker max={config.plannedKids} value={config.kidsDecayFloorQ} onChange={n => setConfig(c => ({ ...c, kidsDecayFloorQ: n }))} color={colors.red} />
        </Field>
      </div>
    </Card>
  );
}

// ── Leaves (the "toggle-a-leaf" builder) ─────────────────────────────────
// Operator, 2026-08-16: "Starts simple then gains complexity with each
// [path] and purpose your solving for... show the vault structure and
// logic and reasoning and consequences so user can shape it to fit them
// while being informed." Shape tabs are alive, not a one-shot prefill --
// tapping one shows why it fits (LeafShapeTab.why) and REPLACES the
// current path list; a hand-edited list needs one confirming tap first so
// a stray tab tap never silently discards work (leafDirty).
function LeavesConfigureFields({
  leafDrafts, setLeafDrafts, activeTab, setActiveTab, dirty, setDirty,
}: {
  leafDrafts: LeafDraft[]; setLeafDrafts: (fn: (l: LeafDraft[]) => LeafDraft[]) => void;
  activeTab: string | null; setActiveTab: (id: string | null) => void;
  dirty: boolean; setDirty: (b: boolean) => void;
}) {
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const secondaries = leafDrafts.slice(1);
  const activeTabInfo = LEAF_SHAPE_TABS.find(t => t.id === activeTab);
  const hasImmediate = leafDrafts.some(l => l.enabled && l.unlockType === 'immediate');

  function applyTab(tab: LeafShapeTab) {
    setLeafDrafts(() => tab.build());
    setActiveTab(tab.id);
    setDirty(false);
    setPendingTab(null);
  }

  function updateLeaf(id: string, fn: (l: LeafDraft) => LeafDraft) {
    setLeafDrafts(list => list.map(l => (l.id === id ? fn(l) : l)));
    setDirty(true);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 10 }}>
          Start from a shape, then tune it
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {LEAF_SHAPE_TABS.map(tab => (
            <Button
              key={tab.id}
              size="sm"
              variant={activeTab === tab.id ? 'primary' : 'ghost'}
              onClick={() => (dirty && activeTab !== tab.id ? setPendingTab(tab.id) : applyTab(tab))}
            >
              {tab.title}
            </Button>
          ))}
        </div>
        {activeTabInfo && (
          <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
            {activeTabInfo.why}
          </p>
        )}
        {pendingTab && (
          <div style={{ marginTop: 12, padding: 12, background: colors.inset, borderRadius: radii.md }}>
            <p style={{ fontSize: 12, color: colors.sub, marginTop: 0, marginBottom: 10 }}>
              Switching starting points replaces what you've set up below. Switch anyway?
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" onClick={() => { const t = LEAF_SHAPE_TABS.find(x => x.id === pendingTab); if (t) applyTab(t); }}>
                Switch anyway
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingTab(null)}>Keep what I have</Button>
            </div>
          </div>
        )}
      </Card>

      {hasImmediate ? null : (
        <div style={{ padding: 12, background: colors.red + '11', border: `1px solid ${colors.red}33`, borderRadius: radii.md, color: colors.red, fontSize: 12, lineHeight: 1.5 }}>
          At least one path needs to be able to spend right away, with no wait -- otherwise nothing can ever
          move until a timelock opens. Set one path's timing to "Right away."
        </div>
      )}

      <LeafCard
        leaf={leafDrafts[0]}
        step={1}
        removable={false}
        onChange={fn => updateLeaf(leafDrafts[0].id, fn)}
        onRemove={() => {}}
      />

      {secondaries.map((leaf, i) => (
        <LeafCard
          key={leaf.id}
          leaf={leaf}
          step={i + 2}
          removable
          onChange={fn => updateLeaf(leaf.id, fn)}
          onRemove={() => { setLeafDrafts(list => list.filter(l => l.id !== leaf.id)); setDirty(true); }}
        />
      ))}

      <Button
        variant="ghost"
        onClick={() => { setLeafDrafts(list => [...list, defaultSecondaryLeaf(`Path ${list.length}`)]); setDirty(true); }}
        style={{ alignSelf: 'flex-start' }}
      >
        + Add another path
      </Button>
    </div>
  );
}

function LeafCard({
  leaf, step, removable, onChange, onRemove,
}: {
  leaf: LeafDraft;
  step: number;
  removable: boolean;
  onChange: (fn: (l: LeafDraft) => LeafDraft) => void;
  onRemove: () => void;
}) {
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <SectionHeader step={step} title={leaf.label} color={removable ? colors.blue : colors.gold} />
        {removable && <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>}
      </div>
      {removable && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginBottom: leaf.enabled ? 14 : 0 }}>
          <input type="checkbox" checked={leaf.enabled} onChange={e => onChange(l => ({ ...l, enabled: e.target.checked }))} />
          <span style={{ fontSize: 13, color: colors.sub }}>Turn on this path</span>
        </label>
      )}
      {(leaf.enabled || !removable) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Path name">
            <Input value={leaf.label} onChange={e => onChange(l => ({ ...l, label: e.target.value }))} />
          </Field>
          <Field label="How many people?">
            <CountStepper
              value={leaf.plannedKeys} min={1} label="signers" color={removable ? colors.blue : colors.gold}
              onChange={n => onChange(l => ({ ...l, plannedKeys: n, quorum: Math.min(l.quorum, n) || 1, decayFloorQ: Math.min(l.decayFloorQ, n) || 1 }))}
            />
            <QuorumPicker max={leaf.plannedKeys} value={leaf.quorum} onChange={n => onChange(l => ({ ...l, quorum: n, decayFloorQ: Math.min(l.decayFloorQ, n) }))} color={removable ? colors.blue : colors.gold} />
          </Field>
          <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, marginTop: -6 }}>
            {keyLossLine(leaf.quorum, leaf.plannedKeys)}
          </p>
          <Field label="When does this open?">
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <Button size="sm" variant={leaf.unlockType === 'immediate' ? 'primary' : 'ghost'} onClick={() => onChange(l => ({ ...l, unlockType: 'immediate', decayEnabled: false }))}>
                Right away
              </Button>
              <Button size="sm" variant={leaf.unlockType === 'after' ? 'primary' : 'ghost'} onClick={() => onChange(l => ({ ...l, unlockType: 'after' }))}>
                After a fixed date
              </Button>
              <Button size="sm" variant={leaf.unlockType === 'older' ? 'primary' : 'ghost'} onClick={() => onChange(l => ({ ...l, unlockType: 'older', decayEnabled: false }))}>
                If left untouched
              </Button>
            </div>
            {leaf.unlockType === 'immediate' ? (
              <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, margin: 0 }}>
                No waiting -- the moment enough of these sign, funds move.
              </p>
            ) : leaf.unlockType === 'after' ? (
              <>
                <TimelockField label="" value={leaf.afterBlocks} onChange={v => onChange(l => ({ ...l, afterBlocks: v }))} />
                <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, lineHeight: 1.5, marginTop: 4 }}>
                  A fixed deadline. Once set, it never moves no matter what happens to the vault before
                  then -- not even normal spending resets it. Use this for anything that must open by a
                  specific point no matter what: recovery, inheritance, a rescue path.
                </p>
              </>
            ) : (
              <>
                <TimelockField label="" value={leaf.olderBlocks} onChange={v => onChange(l => ({ ...l, olderBlocks: Math.min(v, MAX_RELATIVE_BLOCKS) }))} max={MAX_RELATIVE_BLOCKS} />
                <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, lineHeight: 1.5, marginTop: 4 }}>
                  Unlike a fixed deadline, this clock resets every time the coins move -- it only measures
                  how long the vault has sat quiet, not a calendar date. That's why it's capped much
                  shorter: longest allowed is about 13.7 months ({MAX_RELATIVE_BLOCKS.toLocaleString()} blocks).
                  For a longer wait, or a deadline that must hold even if someone spends from the vault in
                  the meantime, use "after a fixed date" instead.
                </p>
              </>
            )}
          </Field>
          {leaf.unlockType === 'after' && (
            <div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={leaf.decayEnabled}
                  onChange={e => onChange(l => ({ ...l, decayEnabled: e.target.checked, decayFloorQ: Math.min(l.decayFloorQ, l.quorum) || 1 }))}
                />
                <span style={{ fontSize: 13, color: colors.sub }}>
                  Need one fewer signer every so often, the longer it waits
                </span>
              </label>
              {leaf.decayEnabled && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <Field label="One fewer required every">
                    <TimelockField label="" value={leaf.decayStepBlocks} onChange={v => onChange(l => ({ ...l, decayStepBlocks: v }))} />
                  </Field>
                  <Field label="Lowest it can ever drop to">
                    <QuorumPicker max={leaf.quorum} value={leaf.decayFloorQ} onChange={n => onChange(l => ({ ...l, decayFloorQ: n }))} color={colors.red} />
                  </Field>
                  <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, lineHeight: 1.5, marginTop: -4 }}>
                    Starts needing all {leaf.quorum}. Every {blocksToHuman(leaf.decayStepBlocks)} after that, one
                    fewer is needed, down to {leaf.decayFloorQ} of {leaf.plannedKeys}.
                    {leaf.decayFloorQ === 1 && ' A floor of 1 means a single lost or stolen key is eventually enough on its own -- consider 2 or higher.'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Local-time (not UTC) YYYY-MM-DD / HH:MM strings for <input type="date">
// and <input type="time"> -- those inputs are always local wall-clock,
// so formatting with toISOString() here would silently shift by the
// browser's UTC offset.
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localTimeStr(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function TimelockField({ label, value, onChange, max }: { label: string; value: number; onChange: (v: number) => void; max?: number }) {
  // Derived straight from `value` every render (no local state to drift
  // out of sync when a preset button or the raw-blocks input changes it
  // from underneath the date/time pickers).
  const target = approxWallclockDate(value);
  const dateStr = localDateStr(target);
  const timeStr = localTimeStr(target);
  // Clamp locally so the CONTROL ITSELF stops offering an out-of-range
  // choice, instead of silently correcting it after the fact -- a preset
  // button for "5 years" that a caller's own onChange later overwrites to
  // 13.7 months with no visible feedback is confusing, not a real cap.
  const clamp = (v: number) => (max !== undefined ? Math.min(v, max) : v);
  const maxDateStr = max !== undefined ? localDateStr(approxWallclockDate(max)) : undefined;

  function pickDateTime(newDateStr: string, newTimeStr: string) {
    if (!newDateStr) return;
    const [y, m, d] = newDateStr.split('-').map(Number);
    const [hh, mm] = (newTimeStr || '00:00').split(':').map(Number);
    const picked = new Date(y, m - 1, d, hh, mm);
    if (Number.isNaN(picked.getTime())) return;
    onChange(clamp(blocksUntilDate(picked)));
  }

  return (
    <Field label={label}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {TIMELOCK_PRESETS.filter(p => max === undefined || p.blocks <= max).map(p => (
          <Button key={p.label} size="sm" variant={value === p.blocks ? 'primary' : 'ghost'} onClick={() => onChange(p.blocks)}>
            {p.label}
          </Button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <Input
          type="date"
          value={dateStr}
          max={maxDateStr}
          onChange={e => pickDateTime(e.target.value, timeStr)}
          style={{ width: 168 }}
        />
        <Input
          type="time"
          value={timeStr}
          onChange={e => pickDateTime(dateStr, e.target.value)}
          style={{ width: 118 }}
        />
        <span style={{ fontSize: 13, color: colors.sub }}>a specific date -- your local time</span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Input
          type="number"
          min={0}
          max={max}
          style={{ width: 140 }}
          value={value}
          onChange={e => onChange(clamp(Math.max(0, Number(e.target.value) || 0)))}
        />
        <span style={{ fontSize: 13, color: colors.sub }}>
          blocks ({blocksToHuman(value)}, unlocks around {target.toLocaleDateString()})
        </span>
      </div>
    </Field>
  );
}

// ── Keys ──────────────────────────────────────────────────────────────

function KeysStep({
  shape, stdConfig, blocConfig, leafDrafts, leafKeys, setLeafKeys, allKeys,
  founderKeys, setFounderKeys, heirKeys, setHeirKeys,
  protectorKeys, setProtectorKeys, consentKeys, setConsentKeys,
  backupKeys, setBackupKeys, secondHeirKeys, setSecondHeirKeys,
  parentKeys, setParentKeys, kidKeys, setKidKeys,
  network, onChangeNetwork, networkBusy, genRole, setGenRole, onGenerateKey, onImportXpub, onImportTapitKey,
  slotsReady, onContinue, onSaveForLater,
}: {
  shape: Shape; stdConfig: StandardConfig; blocConfig: BlocConfig;
  leafDrafts: LeafDraft[];
  leafKeys: Record<string, SelectedKey[]>; setLeafKeys: (fn: (p: Record<string, SelectedKey[]>) => Record<string, SelectedKey[]>) => void;
  allKeys: LocalKey[];
  founderKeys: SelectedKey[]; setFounderKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  heirKeys: SelectedKey[]; setHeirKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  protectorKeys: SelectedKey[]; setProtectorKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  consentKeys: SelectedKey[]; setConsentKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  backupKeys: SelectedKey[]; setBackupKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  secondHeirKeys: SelectedKey[]; setSecondHeirKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  parentKeys: SelectedKey[]; setParentKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  kidKeys: SelectedKey[]; setKidKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  network: NetworkChoice;
  onChangeNetwork: (n: NetworkChoice) => void;
  networkBusy: boolean;
  genRole: string | null; setGenRole: (r: string | null) => void;
  onGenerateKey: (role: string, mode: 'test' | 'secure', password?: string) => void;
  onImportXpub: (role: string, xpub: string, derivationPath: string, masterFingerprint?: string) => void;
  onImportTapitKey: (role: string, xOnlyPubkey: string) => void;
  slotsReady: boolean;
  onContinue: () => void;
  onSaveForLater: () => void;
}) {
  const enabledLeaves = leafDrafts.filter(l => l.enabled);
  const claimed = new Set([
    ...founderKeys, ...heirKeys, ...protectorKeys, ...consentKeys, ...backupKeys, ...secondHeirKeys, ...parentKeys, ...kidKeys,
    ...enabledLeaves.flatMap(l => leafKeys[l.id] ?? []),
  ].map(k => k.keyId));
  const availableKeys = allKeys.filter(k => !claimed.has(k.keyId) && keyNetworkMatches(k.network, network));

  // Live cross-role key-reuse warnings -- see vault-education.ts's
  // keyReuseNotes for the shared computation both shapes below use.
  const leafReuseNotes = keyReuseNotes(
    enabledLeaves.map(l => ({ id: l.id, label: l.label, keys: leafKeys[l.id] ?? [] })),
  );
  const standardRoles: KeyReuseRole[] = [
    { id: 'founder', label: 'Signing keys', keys: founderKeys },
    ...(stdConfig.mode === 'inheritance' && stdConfig.plannedHeirs > 0
      ? [{ id: 'heir', label: 'Heir keys', keys: heirKeys }] : []),
    ...(stdConfig.protectorEnabled
      ? [{ id: 'protector', label: 'Protector keys', keys: protectorKeys }] : []),
    ...(stdConfig.consentEnabled
      ? [{ id: 'consent', label: 'Beneficiary-consent keys', keys: consentKeys }] : []),
    ...(stdConfig.backupEnabled
      ? [{ id: 'backup', label: 'Backup keys', keys: backupKeys }] : []),
    ...(stdConfig.secondInheritanceEnabled
      ? [{ id: 'second_heir', label: 'Second inheritance keys', keys: secondHeirKeys }] : []),
  ];
  const standardReuseNotes = keyReuseNotes(standardRoles);

  function role(
    key: string, label: string, target: number,
    selected: SelectedKey[], setSelected: (fn: (p: SelectedKey[]) => SelectedKey[]) => void,
    accent: string,
    description?: string,
  ) {
    return (
      <Card key={key}>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>{label}</div>
        {description && (
          <p style={{ fontSize: 12, color: colors.muted, marginTop: 0, marginBottom: 10 }}>
            {description}
          </p>
        )}
        <SlotHint targetCount={target} filledCount={selected.length} role={key} />
        <KeyPicker
          selected={selected}
          available={availableKeys}
          onAdd={id => {
            const k = allKeys.find(k => k.keyId === id);
            if (k) setSelected(p => [...p, toSelected(k)]);
          }}
          onRemove={id => setSelected(p => p.filter(k => k.keyId !== id))}
          role={key}
          accentColor={accent}
          allKeys={allKeys}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <Button size="sm" variant="ghost" onClick={() => setGenRole(key)}>+ Generate a new key</Button>
        </div>
        {genRole === key && (
          <InlineKeyCreate
            role={key}
            onGenerate={(mode, pw) => onGenerateKey(key, mode, pw)}
            onImport={(xpub, path, fp) => onImportXpub(key, xpub, path, fp)}
            onImportTapit={xOnlyPubkey => onImportTapitKey(key, xOnlyPubkey)}
            onCancel={() => setGenRole(null)}
          />
        )}
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>Network</div>
        {claimed.size === 0 ? (
          <>
            <p style={{ fontSize: 12, color: colors.muted, marginTop: 0, marginBottom: 10 }}>
              Every key you add below -- generated, imported, or linked from Tapit -- will be tagged
              for this network. Change it now if it's wrong; once a key is added it locks.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['signet', 'bitcoin'] as const).map(n => (
                <Button
                  key={n}
                  size="sm"
                  variant={network === n ? 'primary' : 'ghost'}
                  disabled={networkBusy}
                  onClick={() => onChangeNetwork(n)}
                >
                  {n}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <p style={{ fontSize: 12, color: colors.muted, margin: 0 }}>
            This vault is on <strong style={{ color: colors.text }}>{network}</strong>. Locked because
            keys are already added -- remove every key below first if you need to change it.
          </p>
        )}
      </Card>

      {shape === 'leaves' && (
        <>
          {enabledLeaves.map((leaf, i) => {
            const setLeafSelected = (fn: (p: SelectedKey[]) => SelectedKey[]) =>
              setLeafKeys(p => ({ ...p, [leaf.id]: fn(p[leaf.id] ?? []) }));
            const description = leaf.unlockType === 'immediate'
              ? `Can spend right away, no waiting -- needs ${leaf.quorum} of ${leaf.plannedKeys} to sign.`
              : leaf.unlockType === 'after'
                ? `Locked until ${blocksToHuman(leaf.afterBlocks)} from when the vault is funded. `
                  + `After that, ${leaf.quorum} of ${leaf.plannedKeys} can spend on their own.`
                  + (leaf.decayEnabled ? ` One fewer is needed every ${blocksToHuman(leaf.decayStepBlocks)} after that, down to ${leaf.decayFloorQ}.` : '')
                : `Opens if the vault sits untouched for ${blocksToHuman(leaf.olderBlocks)} -- ${leaf.quorum} of `
                  + `${leaf.plannedKeys} can then spend. Moving the coins resets this clock.`;
            const mySelected = leafKeys[leaf.id] ?? [];
            const reuseNote = leafReuseNotes.get(leaf.id) ?? '';
            return role(leaf.id, `${leaf.label} keys`, leaf.plannedKeys, mySelected, setLeafSelected, i === 0 ? colors.gold : colors.blue, description + reuseNote);
          })}
        </>
      )}
      {shape !== 'leaves' && (shape === 'standard' ? (
        <>
          {role(
            'founder', 'Signing keys', stdConfig.plannedFounders, founderKeys, setFounderKeys, colors.gold,
            `Can spend right away, no waiting -- needs ${stdConfig.founderQ} of ${stdConfig.plannedFounders} to sign.`
              + (stdConfig.consentEnabled
                ? ` Every spend also needs ${stdConfig.consentQ} of ${stdConfig.plannedConsenters} beneficiary-consent signatures (below).`
                : '')
              + (standardReuseNotes.get('founder') ?? ''),
          )}
          {stdConfig.mode === 'inheritance' && stdConfig.plannedHeirs > 0 &&
            role(
              'heir', 'Heir keys', stdConfig.plannedHeirs, heirKeys, setHeirKeys, colors.blue,
              `Locked until ${blocksToHuman(stdConfig.inheritanceAfter)} from when the vault is funded. `
                + `After that, ${stdConfig.heirQ} of ${stdConfig.plannedHeirs} heirs can spend on their own -- `
                + `founders no longer have a say.`
                + (standardReuseNotes.get('heir') ?? ''),
            )}
          {stdConfig.protectorEnabled &&
            role(
              'protector', 'Protector keys', stdConfig.plannedProtectors, protectorKeys, setProtectorKeys, colors.orange,
              `Can rescue funds starting ${blocksToHuman(stdConfig.protectorAfter)} from funding, independent of `
                + `the founders -- a safety net if trustees go quiet before inheritance kicks in.`
                + (standardReuseNotes.get('protector') ?? ''),
            )}
          {stdConfig.consentEnabled &&
            role(
              'consent', 'Beneficiary-consent keys', stdConfig.plannedConsenters, consentKeys, setConsentKeys, colors.green,
              `No timelock -- required on every founders' spend from day one. ${stdConfig.consentQ} of `
                + `${stdConfig.plannedConsenters} must consent alongside the founder quorum above.`
                + (standardReuseNotes.get('consent') ?? ''),
            )}
          {stdConfig.backupEnabled &&
            role(
              'backup', 'Backup keys', stdConfig.plannedBackups, backupKeys, setBackupKeys, colors.orange,
              `No waiting, but a separate, harder-to-reach key set from the founders' -- ${stdConfig.backupQ} of `
                + `${stdConfig.plannedBackups} can spend anytime on their own. Replaces the timelocked recovery path.`
                + (standardReuseNotes.get('backup') ?? ''),
            )}
          {stdConfig.secondInheritanceEnabled &&
            role(
              'second_heir', 'Second inheritance keys', stdConfig.plannedSecondHeirs, secondHeirKeys, setSecondHeirKeys, colors.green,
              `A second, independent heir group. Locked until ${blocksToHuman(stdConfig.secondInheritanceAfter)} `
                + `from funding -- ${stdConfig.secondHeirQ} of ${stdConfig.plannedSecondHeirs} can spend after that, `
                + `separate from the first heir group above.`
                + (standardReuseNotes.get('second_heir') ?? ''),
            )}
        </>
      ) : (
        <>
          {role(
            'parent', 'Parent keys', blocConfig.plannedParents, parentKeys, setParentKeys, colors.gold,
            `Parents can spend together right away, no waiting -- ${blocConfig.parentsTogetherQ} of `
              + `${blocConfig.plannedParents} parents sign, or ${blocConfig.coparentQ} parent plus every kid together.`,
          )}
          {role(
            'kid', 'Kid keys', blocConfig.plannedKids, kidKeys, setKidKeys, colors.blue,
            `Kids alone unlock starting ${blocksToHuman(blocConfig.kidsDecayStartAfter)} from funding -- all `
              + `${blocConfig.plannedKids} needed at first, one fewer required every `
              + `${blocksToHuman(blocConfig.kidsDecayStepBlocks)} after that, down to ${blocConfig.kidsDecayFloorQ}.`,
          )}
        </>
      ))}

      <div style={{ display: 'flex', gap: 10 }}>
        <Button variant="ghost" onClick={onSaveForLater}>Save and finish later</Button>
        <Button disabled={!slotsReady} onClick={onContinue}>
          {slotsReady ? 'All slots filled -- compile' : 'Fill every slot to continue'}
        </Button>
      </div>
    </div>
  );
}

function InlineKeyCreate({
  role, onGenerate, onImport, onImportTapit, onCancel,
}: {
  role: string;
  onGenerate: (mode: 'test' | 'secure', password?: string) => void;
  onImport: (xpub: string, derivationPath: string, masterFingerprint?: string) => void;
  onImportTapit: (xOnlyPubkey: string) => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<'generate' | 'import' | 'tapit'>('generate');
  const [secure, setSecure] = useState(true);
  const [password, setPassword] = useState('');
  const [xpub, setXpub] = useState('');
  const [path, setPath] = useState("m/48'/1'/0'/2'");
  // The ONLY trustworthy source of the master fingerprint hardware-wallet
  // signing needs -- a bare xpub carries no information about its own
  // ancestors, so there's no way to derive it after the fact (see
  // keystore.ts's importXpub doc comment). Populated from a scan/file
  // import when available; editable so a manual paste can still supply it.
  const [masterFingerprint, setMasterFingerprint] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [showQrScan, setShowQrScan] = useState(false);
  const exportFileRef = useRef<HTMLInputElement>(null);
  const [tapitPubkey, setTapitPubkey] = useState('');
  const [tapitErr, setTapitErr] = useState<string | null>(null);

  function handleQrResult(scannedXpub: string, scannedPath: string | null, scannedFingerprint: string | null) {
    setXpub(scannedXpub);
    if (scannedPath) setPath(scannedPath);
    if (scannedFingerprint) setMasterFingerprint(scannedFingerprint);
    setFileName(null);
    setShowQrScan(false);
  }

  async function handleExportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileErr(null);
    const text = await file.text();
    const parsed = parseXpubText(text);
    if (!parsed) {
      setFileErr(`Couldn't find an xpub in "${file.name}". Paste it in manually instead.`);
      return;
    }
    setXpub(parsed.xpub);
    // null only means this specific export had no path info (a bare
    // xpub, no brackets) -- leave whatever was already in the field
    // rather than blank out a value that might already be correct.
    if (parsed.path) setPath(parsed.path);
    if (parsed.fingerprint) setMasterFingerprint(parsed.fingerprint);
    setFileName(file.name);
  }

  return (
    <div style={{ marginTop: 12, padding: 14, background: colors.inset, borderRadius: radii.md, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" variant={tab === 'generate' ? 'primary' : 'ghost'} onClick={() => setTab('generate')}>Generate</Button>
        <Button size="sm" variant={tab === 'import' ? 'primary' : 'ghost'} onClick={() => setTab('import')}>Import xpub</Button>
        <Button size="sm" variant={tab === 'tapit' ? 'primary' : 'ghost'} onClick={() => setTab('tapit')}>From Tapit</Button>
      </div>
      {tab === 'generate' ? (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: colors.sub }}>
            <input type="checkbox" checked={secure} onChange={e => setSecure(e.target.checked)} />
            Password-protect this key (recommended for real funds)
          </label>
          {secure && <Input type="password" placeholder="Password (min 8 characters)" value={password} onChange={e => setPassword(e.target.value)} />}
          <Button
            size="sm"
            disabled={secure && password.length < 8}
            onClick={() => onGenerate(secure ? 'secure' : 'test', secure ? password : undefined)}
          >
            Generate {role} key
          </Button>
        </>
      ) : tab === 'tapit' ? (
        <>
          <div style={{ fontSize: 11, color: colors.muted }}>
            Open Tapit, go to Settings, tap "Your public key," and copy or scan it -- then paste it here. A
            direct handoff between the two apps is coming later; paste works today.
          </div>
          <Input
            placeholder="Tapit public key (64 hex characters)"
            mono
            value={tapitPubkey}
            onChange={e => { setTapitPubkey(e.target.value); setTapitErr(null); }}
          />
          {tapitErr && <div style={{ fontSize: 11, color: colors.red }}>{tapitErr}</div>}
          <Button
            size="sm"
            disabled={!tapitPubkey.trim()}
            onClick={() => {
              const clean = tapitPubkey.trim().toLowerCase();
              if (!/^[0-9a-f]{64}$/.test(clean)) {
                setTapitErr('Expected 64 hex characters (32 bytes) -- copy the whole key from Tapit, no extra spaces.');
                return;
              }
              onImportTapit(clean);
            }}
          >
            Add {role} key from Tapit
          </Button>
        </>
      ) : showQrScan ? (
        <XpubQrScanner onResult={handleQrResult} onCancel={() => setShowQrScan(false)} />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="ghost" style={{ flex: 1 }} onClick={() => setShowQrScan(true)}>
              Scan QR
            </Button>
            <Button size="sm" variant="ghost" style={{ flex: 1 }} onClick={() => exportFileRef.current?.click()}>
              {fileName ? `Loaded: ${fileName}` : 'Import from file'}
            </Button>
          </div>
          <input ref={exportFileRef} type="file" accept=".json,.txt" style={{ display: 'none' }} onChange={handleExportFile} />
          <div style={{ fontSize: 11, color: colors.muted }}>
            Scan a QR from your signing device, or import its export file -- no typing needed. Or paste manually below.
          </div>
          {fileErr && <div style={{ fontSize: 11, color: colors.red }}>{fileErr}</div>}
          <Input placeholder="xpub / tpub from a hardware signer" value={xpub} onChange={e => { setXpub(e.target.value); setFileName(null); }} />
          <Input placeholder="Derivation path" value={path} onChange={e => setPath(e.target.value)} />
          <Input
            placeholder="Master fingerprint (e.g. c8fe8d4e) -- from the signer's export"
            value={masterFingerprint}
            onChange={e => setMasterFingerprint(e.target.value)}
          />
          <div style={{ fontSize: 11, color: colors.muted }}>
            Filled in automatically from a scan or file import. Without it, this key
            won't be recognized by a hardware wallet at spend time.
          </div>
          <Button
            size="sm"
            disabled={!xpub.trim()}
            onClick={() => {
              const fp = masterFingerprint.trim().toLowerCase();
              if (fp && !/^[0-9a-f]{8}$/.test(fp)) {
                setFileErr('Fingerprint must be 8 hex characters, e.g. c8fe8d4e.');
                return;
              }
              onImport(xpub.trim(), path.trim(), fp || undefined);
            }}
          >
            Import
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

// ── Backup ────────────────────────────────────────────────────────────

function BackupStep({
  vault, metalBackedUp, setMetalBackedUp, onContinue,
}: {
  vault: Vault; metalBackedUp: boolean; setMetalBackedUp: (b: boolean) => void; onContinue: () => void;
}) {
  const [downloaded, setDownloaded] = useState(false);
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>Back up your vault</div>
        <p style={{ fontSize: 13, color: colors.muted, lineHeight: 1.5 }}>
          This file lets you or your family rebuild this exact vault with any compatible wallet, even if this app disappears. Store it somewhere durable -- ideally on metal, alongside your key backups.
        </p>
        {vault.address && <CopyField label="Address" value={vault.address} />}
        {vault.descriptor && (
          <details>
            <summary style={{ fontSize: 12, color: colors.muted, cursor: 'pointer' }}>Show descriptor + QR</summary>
            <div style={{ marginTop: 10 }}>
              <CopyField label="Descriptor" value={vault.descriptor} multiline />
              <div style={{ marginTop: 10 }}>
                <DescriptorQr descriptor={vault.descriptor} label="Descriptor QR" size={200} />
              </div>
            </div>
          </details>
        )}
        <Button variant="ghost" onClick={() => { downloadVault(vault); setDownloaded(true); }}>
          {downloaded ? 'Downloaded' : 'Download backup file'}
        </Button>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer', padding: 12, background: colors.raised, borderRadius: radii.md }}>
          <input type="checkbox" checked={metalBackedUp} onChange={e => setMetalBackedUp(e.target.checked)} />
          <span style={{ fontSize: 13, color: colors.sub }}>I have a durable (metal) backup for every signing key in this vault.</span>
        </label>
        <Button disabled={!downloaded || !metalBackedUp} onClick={onContinue}>
          Continue to funding
        </Button>
      </div>
    </Card>
  );
}
