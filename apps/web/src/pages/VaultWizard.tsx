import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  listKeys, generateTestKey, generateSoftwareKey, importXpub, parseXpubText,
  type LocalKey,
} from '../lib/keystore';
import {
  upgradeDescriptor, buildKeyOrigins, buildPsbtKeyOrigins, toPubkeyHex,
  type SelectedKey,
} from '../lib/descriptor-keys';
import { api, type Vault, type VaultProposal, type BlocPolicy } from '../lib/api';
import { downloadVault } from '../lib/descriptor-backup';
import { blocksToHuman, TIMELOCK_PRESETS } from '../lib/blocks';
import { approxWallclockDate, blocksUntilDate } from '../lib/chain';
import { VAULT_TEMPLATES, type VaultMode, type VaultTemplate } from '../lib/vault-templates';
import { colors, radii } from '../theme';
import { Button, Input, Card, Field } from '../components/ui';
import { DescriptorQr } from '../components/DescriptorQr';
import { XpubQrScanner } from '../components/XpubQrScanner';
import {
  QuorumPicker, KeyPicker, SlotHint, CopyField, BackupFlow, FundingStep,
  BehaviorTimeline, type SpendLeg,
} from '../components/vault-builder';

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

type Shape = 'standard' | 'bloc';
type Step = 'configure' | 'keys' | 'compile' | 'backup' | 'fund' | 'done';
type NetworkChoice = 'testnet' | 'signet' | 'bitcoin';

interface StandardConfig {
  mode: VaultMode;
  plannedFounders: number;
  founderQ: number;
  plannedHeirs: number;
  heirQ: number;
  // "Gift Locker"-shaped vaults (founders-now OR a single timelocked
  // beneficiary path, no separate founders-after-a-delay recovery leaf
  // in between) turn this off -- see DynastyPolicy::has_recovery() in
  // protocol/src/policy_compiler.rs. When false, recoveryAfter is never
  // sent to the compiler (forced to 0 in confirmConfigure()).
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
}

interface BlocConfig {
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

const DEFAULT_STANDARD_CONFIG: StandardConfig = {
  mode: 'inheritance',
  plannedFounders: 2, founderQ: 2,
  plannedHeirs: 2, heirQ: 2,
  recoveryEnabled: true, recoveryAfter: 26_280, inheritanceAfter: 52_560,
  protectorEnabled: false, protectorAfter: 39_000, protectorQ: 1, plannedProtectors: 1,
  consentEnabled: false, consentQ: 1, plannedConsenters: 1,
};

const DEFAULT_BLOC_CONFIG: BlocConfig = {
  plannedParents: 2, parentsTogetherQ: 2, coparentQ: 1, kidsWithParentQ: 1,
  parentSoloQ: 1, parentSoloAfter: 26_280,
  plannedKids: 3, kidsDecayStartQ: 3, kidsDecayFloorQ: 1,
  kidsDecayStartAfter: 52_560, kidsDecayStepBlocks: 26_280,
};

function templateToStandardConfig(t: VaultTemplate): StandardConfig {
  const c = t.config;
  return {
    mode: c.mode,
    plannedFounders: c.plannedFounders, founderQ: c.founderQ,
    plannedHeirs: c.plannedHeirs, heirQ: c.heirQ,
    // A template that ships with recoveryAfter: 0 means "Gift Locker"
    // shaped -- no recovery leaf at all -- so the toggle starts off; the
    // fallback default (26_280, ~6 months) only matters if the user
    // re-enables it from here.
    recoveryEnabled: c.recoveryAfter > 0,
    recoveryAfter: c.recoveryAfter > 0 ? c.recoveryAfter : 26_280,
    inheritanceAfter: c.inheritanceAfter,
    protectorEnabled: !!c.protectorEnabled,
    protectorAfter: c.protectorAfter ?? 39_000,
    protectorQ: c.protectorQ ?? 1,
    plannedProtectors: c.plannedProtectors ?? 1,
    consentEnabled: !!c.consentEnabled,
    consentQ: c.consentQ ?? 1,
    plannedConsenters: c.plannedConsenters ?? 1,
  };
}

function keyNetworkMatches(keyNet: string, vaultNet: NetworkChoice): boolean {
  if (keyNet === vaultNet) return true;
  return keyNet === 'mainnet' && vaultNet === 'bitcoin';
}

function toSelected(k: LocalKey): SelectedKey {
  return {
    keyId: k.keyId, label: k.label, persona: k.persona, xpub: k.xpub,
    pubkey: k.pubkey, fingerprint: k.fingerprint, masterFingerprint: k.masterFingerprint,
    derivationPath: k.derivationPath, network: k.network,
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

  const [allKeys, setAllKeys] = useState<LocalKey[]>([]);
  useEffect(() => { setAllKeys(listKeys().filter(k => k.status === 'active')); }, []);
  const refreshKeys = () => setAllKeys(listKeys().filter(k => k.status === 'active'));

  const [shape, setShape] = useState<Shape>('standard');
  const [step, setStep] = useState<Step>('configure');
  const [name, setName] = useState('My Vault');
  const [network, setNetwork] = useState<NetworkChoice>('testnet');

  const [stdConfig, setStdConfig] = useState<StandardConfig>(DEFAULT_STANDARD_CONFIG);
  const [blocConfig, setBlocConfig] = useState<BlocConfig>(DEFAULT_BLOC_CONFIG);

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
    const t = VAULT_TEMPLATES.find(t => t.id === prefill.template);
    if (!t) return;
    setShape('standard');
    setName(t.title);
    setStdConfig(templateToStandardConfig(t));
    window.history.replaceState({}, '');
  }, [location.state]);

  // Selected keys per role, keyed off allKeys so removing/archiving a key
  // elsewhere is reflected here too.
  const [founderKeys, setFounderKeys] = useState<SelectedKey[]>([]);
  const [heirKeys, setHeirKeys] = useState<SelectedKey[]>([]);
  const [protectorKeys, setProtectorKeys] = useState<SelectedKey[]>([]);
  const [consentKeys, setConsentKeys] = useState<SelectedKey[]>([]);
  const [parentKeys, setParentKeys] = useState<SelectedKey[]>([]);
  const [kidKeys, setKidKeys] = useState<SelectedKey[]>([]);

  const [draftVault, setDraftVault] = useState<Vault | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [configureErr, setConfigureErr] = useState<string | null>(null);

  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState<string | null>(null);
  const [compiledVault, setCompiledVault] = useState<Vault | null>(null);

  const [metalBackedUp, setMetalBackedUp] = useState(false);

  // Inline key creation: which role slot triggered it, and the
  // in-progress backup-and-verify gate for a freshly generated key.
  const [genRole, setGenRole] = useState<string | null>(null);
  const [pendingBackup, setPendingBackup] = useState<{ key: LocalKey; mnemonic: string; role: string } | null>(null);

  function addKeyToRole(role: string, key: LocalKey) {
    const sk = toSelected(key);
    if (role === 'founder') setFounderKeys(p => [...p, sk]);
    else if (role === 'heir') setHeirKeys(p => [...p, sk]);
    else if (role === 'protector') setProtectorKeys(p => [...p, sk]);
    else if (role === 'consent') setConsentKeys(p => [...p, sk]);
    else if (role === 'parent') setParentKeys(p => [...p, sk]);
    else if (role === 'kid') setKidKeys(p => [...p, sk]);
  }

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

  function onImportXpub(role: string, xpub: string, derivationPath: string) {
    const netForKey = network === 'bitcoin' ? 'mainnet' : network;
    const key = importXpub({ label: `${role[0].toUpperCase()}${role.slice(1)} (imported)`, network: netForKey, xpub, derivationPath, persona: role });
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

  // ---- Keys -> compile once every slot is filled ------------------------

  const slotsReady = useMemo(() => {
    if (shape === 'standard') {
      const c = stdConfig;
      const foundersReady = founderKeys.length >= c.plannedFounders;
      const heirsReady = c.mode !== 'inheritance' || c.plannedHeirs === 0 || heirKeys.length >= c.plannedHeirs;
      const protectorsReady = !c.protectorEnabled || protectorKeys.length >= c.plannedProtectors;
      const consentersReady = !c.consentEnabled || consentKeys.length >= c.plannedConsenters;
      return foundersReady && heirsReady && protectorsReady && consentersReady;
    }
    const c = blocConfig;
    return parentKeys.length >= c.plannedParents && kidKeys.length >= c.plannedKids;
  }, [shape, stdConfig, blocConfig, founderKeys, heirKeys, protectorKeys, consentKeys, parentKeys, kidKeys]);

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
        });
        // Upgrade the descriptor to Nunchuk/Sparrow key-origin form,
        // same post-processing PolicyBuilder's save() already did.
        const origins = buildKeyOrigins([...founderKeys, ...heirKeys, ...protectorKeys, ...consentKeys]);
        const upgraded = res.vault.descriptor ? upgradeDescriptor(res.vault.descriptor, origins) : res.vault.descriptor;
        setCompiledVault({ ...res.vault, descriptor: upgraded });
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

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <StepRail current={step} />

      {step === 'configure' && (
        <ConfigureStep
          shape={shape} setShape={setShape}
          name={name} setName={setName}
          network={network} setNetwork={setNetwork}
          stdConfig={stdConfig} setStdConfig={setStdConfig}
          blocConfig={blocConfig} setBlocConfig={setBlocConfig}
          blocLegs={blocLegs}
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
          allKeys={allKeys}
          founderKeys={founderKeys} setFounderKeys={setFounderKeys}
          heirKeys={heirKeys} setHeirKeys={setHeirKeys}
          protectorKeys={protectorKeys} setProtectorKeys={setProtectorKeys}
          consentKeys={consentKeys} setConsentKeys={setConsentKeys}
          parentKeys={parentKeys} setParentKeys={setParentKeys}
          kidKeys={kidKeys} setKidKeys={setKidKeys}
          network={network}
          genRole={genRole} setGenRole={setGenRole}
          onGenerateKey={onGenerateKey}
          onImportXpub={onImportXpub}
          slotsReady={slotsReady}
          onContinue={() => { setStep('compile'); void runCompile(); }}
          onSaveForLater={() => navigate(`/vaults/${draftVault.id}`, { state: { vault: draftVault } })}
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

      {pendingBackup && (
        <BackupFlow
          keyData={pendingBackup.key}
          mnemonic={pendingBackup.mnemonic}
          onDone={() => {
            addKeyToRole(pendingBackup.role, pendingBackup.key);
            setPendingBackup(null);
          }}
        />
      )}
    </div>
  );
}

// ── Configure ─────────────────────────────────────────────────────────

function ConfigureStep({
  shape, setShape, name, setName, network, setNetwork,
  stdConfig, setStdConfig, blocConfig, setBlocConfig, blocLegs,
  onConfirm, busy, err,
}: {
  shape: Shape; setShape: (s: Shape) => void;
  name: string; setName: (n: string) => void;
  network: NetworkChoice; setNetwork: (n: NetworkChoice) => void;
  stdConfig: StandardConfig; setStdConfig: (fn: (c: StandardConfig) => StandardConfig) => void;
  blocConfig: BlocConfig; setBlocConfig: (fn: (c: BlocConfig) => BlocConfig) => void;
  blocLegs: SpendLeg[];
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
              {(['testnet', 'signet', 'bitcoin'] as const).map(n => (
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
            </div>
          </Field>
        </div>
      </Card>

      {shape === 'standard' ? (
        <StandardConfigureFields config={stdConfig} setConfig={setStdConfig} />
      ) : (
        <BlocConfigureFields config={blocConfig} setConfig={setBlocConfig} />
      )}

      {shape === 'bloc' && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 10 }}>
            How this vault behaves over time
          </div>
          <BehaviorTimeline legs={blocLegs} floorWarning={blocConfig.kidsDecayFloorQ === 1} kidCount={blocConfig.plannedKids} />
        </Card>
      )}

      {err && <p style={{ color: colors.red, fontSize: 13 }}>{err}</p>}
      <Button disabled={busy} onClick={onConfirm} style={{ alignSelf: 'flex-start' }}>
        {busy ? 'Saving...' : 'Continue -- add keys next'}
      </Button>
    </div>
  );
}

function StandardConfigureFields({ config, setConfig }: { config: StandardConfig; setConfig: (fn: (c: StandardConfig) => StandardConfig) => void }) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="How many people sign?">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Input
              type="number" min={1} style={{ width: 90 }}
              value={config.plannedFounders}
              onChange={e => setConfig(c => ({ ...c, plannedFounders: Math.max(1, Number(e.target.value) || 1) }))}
            />
            <span style={{ fontSize: 12, color: colors.muted }}>signers</span>
          </div>
          <QuorumPicker max={config.plannedFounders} value={config.founderQ} onChange={n => setConfig(c => ({ ...c, founderQ: n }))} color={colors.gold} />
        </Field>

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={config.mode === 'inheritance'}
            onChange={e => setConfig(c => ({ ...c, mode: e.target.checked ? 'inheritance' : 'plain' }))}
          />
          <span style={{ fontSize: 13, color: colors.sub }}>Add heirs + an inheritance path</span>
        </label>

        {config.mode === 'inheritance' && (
          <>
            <Field label="How many heirs?">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Input
                  type="number" min={0} style={{ width: 90 }}
                  value={config.plannedHeirs}
                  onChange={e => setConfig(c => ({ ...c, plannedHeirs: Math.max(0, Number(e.target.value) || 0) }))}
                />
                <span style={{ fontSize: 12, color: colors.muted }}>heirs</span>
              </div>
              {config.plannedHeirs > 0 && (
                <QuorumPicker max={config.plannedHeirs} value={config.heirQ} onChange={n => setConfig(c => ({ ...c, heirQ: n }))} color={colors.blue} />
              )}
            </Field>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={config.recoveryEnabled}
                onChange={e => setConfig(c => ({
                  ...c,
                  recoveryEnabled: e.target.checked,
                  // A protector branch requires a recovery branch --
                  // turning recovery off while a protector is configured
                  // would otherwise get rejected server-side.
                  protectorEnabled: e.target.checked ? c.protectorEnabled : false,
                }))}
              />
              <span style={{ fontSize: 13, color: colors.sub }}>
                Add a separate recovery path (founders can also spend after a delay, before the heir path opens)
              </span>
            </label>
            {!config.recoveryEnabled && (
              <div style={{ fontSize: 12, color: colors.muted, marginTop: -8 }}>
                "Gift Locker" shape: founders spend now, or the heir alone after the timelock below -- nothing in between.
              </div>
            )}
            {config.recoveryEnabled && (
              <TimelockField label="Recovery unlocks after" value={config.recoveryAfter} onChange={v => setConfig(c => ({ ...c, recoveryAfter: v }))} />
            )}
            <TimelockField label="Inheritance unlocks after" value={config.inheritanceAfter} onChange={v => setConfig(c => ({ ...c, inheritanceAfter: v }))} />
          </>
        )}

        <details>
          <summary style={{ fontSize: 12, color: colors.muted, cursor: 'pointer' }}>Advanced: protector + beneficiary consent</summary>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: config.recoveryEnabled ? 'pointer' : 'not-allowed' }}>
              <input
                type="checkbox"
                checked={config.protectorEnabled}
                disabled={!config.recoveryEnabled}
                onChange={e => setConfig(c => ({ ...c, protectorEnabled: e.target.checked }))}
              />
              <span style={{ fontSize: 13, color: config.recoveryEnabled ? colors.sub : colors.muted }}>
                Add a protector (independent rescue path){!config.recoveryEnabled && ' -- requires a recovery path'}
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
    </Card>
  );
}

function BlocConfigureFields({ config, setConfig }: { config: BlocConfig; setConfig: (fn: (c: BlocConfig) => BlocConfig) => void }) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="How many parents?">
          <Input type="number" min={1} style={{ width: 90 }} value={config.plannedParents} onChange={e => setConfig(c => ({ ...c, plannedParents: Math.max(1, Number(e.target.value) || 1) }))} />
          <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>Parents together, right away:</div>
          <QuorumPicker max={config.plannedParents} value={config.parentsTogetherQ} onChange={n => setConfig(c => ({ ...c, parentsTogetherQ: n }))} color={colors.gold} />
        </Field>
        <Field label="How many kids?">
          <Input type="number" min={1} style={{ width: 90 }} value={config.plannedKids} onChange={e => setConfig(c => ({ ...c, plannedKids: Math.max(1, Number(e.target.value) || 1) }))} />
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

function TimelockField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  // Derived straight from `value` every render (no local state to drift
  // out of sync when a preset button or the raw-blocks input changes it
  // from underneath the date/time pickers).
  const target = approxWallclockDate(value);
  const dateStr = localDateStr(target);
  const timeStr = localTimeStr(target);

  function pickDateTime(newDateStr: string, newTimeStr: string) {
    if (!newDateStr) return;
    const [y, m, d] = newDateStr.split('-').map(Number);
    const [hh, mm] = (newTimeStr || '00:00').split(':').map(Number);
    const picked = new Date(y, m - 1, d, hh, mm);
    if (Number.isNaN(picked.getTime())) return;
    onChange(blocksUntilDate(picked));
  }

  return (
    <Field label={label}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {TIMELOCK_PRESETS.map(p => (
          <Button key={p.label} size="sm" variant={value === p.blocks ? 'primary' : 'ghost'} onClick={() => onChange(p.blocks)}>
            {p.label}
          </Button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <Input
          type="date"
          value={dateStr}
          onChange={e => pickDateTime(e.target.value, timeStr)}
          style={{ width: 168 }}
        />
        <Input
          type="time"
          value={timeStr}
          onChange={e => pickDateTime(dateStr, e.target.value)}
          style={{ width: 118 }}
        />
        <span style={{ fontSize: 12, color: colors.muted }}>a specific date -- your local time</span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Input type="number" min={0} style={{ width: 140 }} value={value} onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))} />
        <span style={{ fontSize: 12, color: colors.muted }}>
          blocks ({blocksToHuman(value)}, unlocks around {target.toLocaleDateString()})
        </span>
      </div>
    </Field>
  );
}

// ── Keys ──────────────────────────────────────────────────────────────

function KeysStep({
  shape, stdConfig, blocConfig, allKeys,
  founderKeys, setFounderKeys, heirKeys, setHeirKeys,
  protectorKeys, setProtectorKeys, consentKeys, setConsentKeys,
  parentKeys, setParentKeys, kidKeys, setKidKeys,
  network, genRole, setGenRole, onGenerateKey, onImportXpub,
  slotsReady, onContinue, onSaveForLater,
}: {
  shape: Shape; stdConfig: StandardConfig; blocConfig: BlocConfig;
  allKeys: LocalKey[];
  founderKeys: SelectedKey[]; setFounderKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  heirKeys: SelectedKey[]; setHeirKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  protectorKeys: SelectedKey[]; setProtectorKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  consentKeys: SelectedKey[]; setConsentKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  parentKeys: SelectedKey[]; setParentKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  kidKeys: SelectedKey[]; setKidKeys: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  network: NetworkChoice;
  genRole: string | null; setGenRole: (r: string | null) => void;
  onGenerateKey: (role: string, mode: 'test' | 'secure', password?: string) => void;
  onImportXpub: (role: string, xpub: string, derivationPath: string) => void;
  slotsReady: boolean;
  onContinue: () => void;
  onSaveForLater: () => void;
}) {
  const claimed = new Set([...founderKeys, ...heirKeys, ...protectorKeys, ...consentKeys, ...parentKeys, ...kidKeys].map(k => k.keyId));
  const availableKeys = allKeys.filter(k => !claimed.has(k.keyId) && keyNetworkMatches(k.network, network));

  function role(
    key: string, label: string, target: number,
    selected: SelectedKey[], setSelected: (fn: (p: SelectedKey[]) => SelectedKey[]) => void,
    accent: string,
  ) {
    return (
      <Card key={key}>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 10 }}>{label}</div>
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
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <Button size="sm" variant="ghost" onClick={() => setGenRole(key)}>+ Generate a new key</Button>
        </div>
        {genRole === key && (
          <InlineKeyCreate
            role={key}
            onGenerate={(mode, pw) => onGenerateKey(key, mode, pw)}
            onImport={(xpub, path) => onImportXpub(key, xpub, path)}
            onCancel={() => setGenRole(null)}
          />
        )}
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {shape === 'standard' ? (
        <>
          {role('founder', 'Signing keys', stdConfig.plannedFounders, founderKeys, setFounderKeys, colors.gold)}
          {stdConfig.mode === 'inheritance' && stdConfig.plannedHeirs > 0 &&
            role('heir', 'Heir keys', stdConfig.plannedHeirs, heirKeys, setHeirKeys, colors.blue)}
          {stdConfig.protectorEnabled &&
            role('protector', 'Protector keys', stdConfig.plannedProtectors, protectorKeys, setProtectorKeys, colors.orange)}
          {stdConfig.consentEnabled &&
            role('consent', 'Beneficiary-consent keys', stdConfig.plannedConsenters, consentKeys, setConsentKeys, colors.green)}
        </>
      ) : (
        <>
          {role('parent', 'Parent keys', blocConfig.plannedParents, parentKeys, setParentKeys, colors.gold)}
          {role('kid', 'Kid keys', blocConfig.plannedKids, kidKeys, setKidKeys, colors.blue)}
        </>
      )}

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
  role, onGenerate, onImport, onCancel,
}: {
  role: string;
  onGenerate: (mode: 'test' | 'secure', password?: string) => void;
  onImport: (xpub: string, derivationPath: string) => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<'generate' | 'import'>('generate');
  const [secure, setSecure] = useState(true);
  const [password, setPassword] = useState('');
  const [xpub, setXpub] = useState('');
  const [path, setPath] = useState("m/48'/1'/0'/2'");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [showQrScan, setShowQrScan] = useState(false);
  const exportFileRef = useRef<HTMLInputElement>(null);

  function handleQrResult(scannedXpub: string, scannedPath: string | null) {
    setXpub(scannedXpub);
    if (scannedPath) setPath(scannedPath);
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
    setFileName(file.name);
  }

  return (
    <div style={{ marginTop: 12, padding: 14, background: colors.inset, borderRadius: radii.md, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" variant={tab === 'generate' ? 'primary' : 'ghost'} onClick={() => setTab('generate')}>Generate</Button>
        <Button size="sm" variant={tab === 'import' ? 'primary' : 'ghost'} onClick={() => setTab('import')}>Import xpub</Button>
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
            Scan a QR from Coldcard, Sparrow, or SeedSigner, or import its export file -- no typing needed. Or paste manually below.
          </div>
          {fileErr && <div style={{ fontSize: 11, color: colors.red }}>{fileErr}</div>}
          <Input placeholder="xpub / tpub from a hardware signer" value={xpub} onChange={e => { setXpub(e.target.value); setFileName(null); }} />
          <Input placeholder="Derivation path" value={path} onChange={e => setPath(e.target.value)} />
          <Button size="sm" disabled={!xpub.trim()} onClick={() => onImport(xpub.trim(), path.trim())}>
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
                <DescriptorQr descriptor={vault.descriptor} label="Sparrow import QR" size={200} />
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
