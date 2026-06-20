import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { listKeys, type LocalKey } from '../lib/keystore';
import { api } from '../lib/api';
import { colors, fonts, radii } from '../theme';
import { Button, Input, Label } from '../components/ui';
import { DescriptorQr } from '../components/DescriptorQr';
import {
  upgradeDescriptor,
  buildKeyOrigins,
  toPubkeyHex,
  type SelectedKey,
} from '../lib/descriptor-keys';

// // -- Dynasty Bloc builder (Phase 1: compile + export)
//
// A decaying-multisig family vault. Five+ spend paths, each its own
// Taproot leaf:
//   A  parents together                                 now
//   B  one parent + every kid                           now
//   C  one parent alone                  after parent_solo timelock
//   D+ kids alone, threshold DECAYING    after kids_decay timelock
//      one rung at a time down to the floor.
//
// Phase 1 is compile + hardware-wallet export only: copy the
// descriptor / address into Nunchuk / Sparrow / Coldcard, fund it,
// hold it. In-app spending of these leaves is Phase 2.

const TIMELOCK_PRESETS = [
  { label: '6 months', blocks: 26_280 },
  { label: '1 year', blocks: 52_560 },
  { label: '2 years', blocks: 105_120 },
  { label: '3 years', blocks: 157_680 },
  { label: '5 years', blocks: 262_800 },
];

function blocksToHuman(b: number): string {
  const days = Math.round((b * 10) / 60 / 24);
  if (days < 30) return `~${days} days`;
  if (days < 365) return `~${Math.round(days / 30)} months`;
  return `~${(days / 365).toFixed(1)} years`;
}

const selectStyle: CSSProperties = {
  width: '100%',
  padding: '11px 13px',
  background: colors.input,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  color: colors.muted,
  fontSize: 16,
  fontFamily: fonts.sans,
  boxSizing: 'border-box',
};

function toSelected(k: LocalKey): SelectedKey {
  return {
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
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>{title}</div>
        {sub && <div style={{ fontSize: 13, color: colors.muted, marginTop: 2, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function QuorumPicker({ max, value, onChange, color }: { max: number; value: number; onChange: (n: number) => void; color: string }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: colors.muted, marginRight: 4 }}>Required:</span>
      {Array.from({ length: max }, (_, i) => i + 1).map(n => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          style={{
            width: 34, height: 34, borderRadius: radii.md, border: '1px solid',
            borderColor: value === n ? color : colors.border,
            background: value === n ? color + '22' : 'transparent',
            color: value === n ? color : colors.muted,
            fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: fonts.sans,
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
  selected, available, onAdd, onRemove, role, accentColor,
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
            display: 'flex', alignItems: 'center', gap: 12, background: colors.inset,
            borderRadius: radii.md, padding: '10px 14px', border: `1px solid ${accentColor}44`, marginBottom: 6,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>{k.label}</div>
            <div style={{ fontSize: 11, color: colors.muted }}>
              <span style={{ color: accentColor }}>{k.persona}</span>
              {' . '}{k.fingerprint}{' . '}{k.network}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onRemove(k.keyId)}
            style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 16 }}
          >
            x
          </button>
        </div>
      ))}
      {available.length > 0 && (
        <select
          style={selectStyle}
          value=""
          onChange={e => { if (e.target.value) onAdd(e.target.value); }}
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
        <p style={{ fontSize: 13, color: colors.muted }}>No active keys available. Generate keys in the Keys tab first.</p>
      )}
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
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
          background: colors.inset, borderRadius: radii.md, padding: '10px 12px',
          fontFamily: fonts.mono, fontSize: 11, color: colors.sub,
          wordBreak: 'break-all', lineHeight: 1.7, maxHeight: 120, overflowY: 'auto',
        }}
      >
        {value}
      </div>
    </div>
  );
}

interface CompiledBloc {
  address: string;
  descriptor: string;
  miniscript_policy: string;
  network: string;
  address_type: string;
}

interface Rung {
  q: number;
  afterBlocks: number;
}

export default function BlocBuilder() {
  const navigate = useNavigate();
  const [allKeys, setAllKeys] = useState<LocalKey[]>([]);
  const [name, setName] = useState('Family Bloc');
  const [parents, setParents] = useState<SelectedKey[]>([]);
  const [kids, setKids] = useState<SelectedKey[]>([]);

  // Quorums. Defaults track the Bloc shape: parents act n-of-n;
  // one parent joins the kids; kids start n-of-n and decay to 1.
  const [parentsTogetherQ, setParentsTogetherQ] = useState(2);
  const [coparentQ, setCoparentQ] = useState(1);
  const [kidsWithParentQ, setKidsWithParentQ] = useState(1);
  const [parentSoloQ, setParentSoloQ] = useState(1);
  const [kidsDecayStartQ, setKidsDecayStartQ] = useState(1);
  const [kidsDecayFloorQ, setKidsDecayFloorQ] = useState(1);

  // Timelocks (RELATIVE block offsets; the server bakes tip + offset).
  const [parentSoloAfter, setParentSoloAfter] = useState(52_560); // ~1 year
  const [kidsDecayStartAfter, setKidsDecayStartAfter] = useState(105_120); // ~2 years
  const [kidsDecayStep, setKidsDecayStep] = useState(52_560); // ~1 year per rung

  const [compiled, setCompiled] = useState<CompiledBloc | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setAllKeys(listKeys().filter(k => k.status === 'active'));
  }, []);

  // When the key counts change, keep the "all of them" quorums sensible
  // without stomping a smaller value the user deliberately chose.
  useEffect(() => {
    const n = parents.length;
    setParentsTogetherQ(q => Math.min(Math.max(q, Math.min(2, n)), n || 1));
    setCoparentQ(q => Math.min(q || 1, n || 1));
    setParentSoloQ(q => Math.min(q || 1, n || 1));
  }, [parents.length]);

  useEffect(() => {
    const n = kids.length;
    setKidsWithParentQ(q => Math.min(Math.max(q, n), n || 1)); // default all kids
    setKidsDecayStartQ(q => Math.min(Math.max(q, n), n || 1)); // default all kids
    setKidsDecayFloorQ(q => Math.min(q || 1, n || 1));
  }, [kids.length]);

  const claimed = new Set<string>([...parents.map(k => k.keyId), ...kids.map(k => k.keyId)]);
  const available = allKeys.filter(k => !claimed.has(k.keyId));

  const network = [...parents, ...kids][0]?.network ?? 'testnet';

  function addKey(id: string, role: 'parent' | 'kid') {
    const k = allKeys.find(x => x.keyId === id);
    if (!k) return;
    if (role === 'parent') setParents(p => [...p, toSelected(k)]);
    else setKids(p => [...p, toSelected(k)]);
    setCompiled(null);
  }
  function removeKey(id: string, role: 'parent' | 'kid') {
    if (role === 'parent') setParents(p => p.filter(k => k.keyId !== id));
    else setKids(p => p.filter(k => k.keyId !== id));
    setCompiled(null);
  }

  // Live decay-ladder preview -- exactly what will be compiled. The
  // first rung sits at kidsDecayStartAfter; each lower quorum pushes
  // the unlock height out by one step. Verify, don't trust.
  const ladder = useMemo<Rung[]>(() => {
    const out: Rung[] = [];
    if (kids.length === 0) return out;
    let q = kidsDecayStartQ;
    let rung = 0;
    // Guard against an inverted range producing an endless loop.
    if (kidsDecayFloorQ > kidsDecayStartQ) return out;
    while (true) {
      out.push({ q, afterBlocks: kidsDecayStartAfter + rung * kidsDecayStep });
      if (q === kidsDecayFloorQ) break;
      q -= 1;
      rung += 1;
    }
    return out;
  }, [kids.length, kidsDecayStartQ, kidsDecayFloorQ, kidsDecayStartAfter, kidsDecayStep]);

  const errors: string[] = [];
  if (parents.length === 0) errors.push('Add at least one parent key.');
  if (kids.length === 0) errors.push('Add at least one kid key.');
  if (kidsDecayFloorQ > kidsDecayStartQ)
    errors.push('Kid decay floor cannot exceed the starting kid quorum.');
  if (kidsDecayStartQ > kidsDecayFloorQ && kidsDecayStep <= 0)
    errors.push('Decay step must be greater than 0 blocks for a multi-rung ladder.');
  if (kidsDecayStartAfter <= parentSoloAfter)
    errors.push('Kids-alone timelock must be later than the single-parent timelock.');
  const nets = new Set([...parents, ...kids].map(k => k.network));
  if (nets.size > 1) errors.push('All selected keys must be on the same network.');

  const canCompile = errors.length === 0;

  async function compile() {
    setCompiling(true);
    setErr(null);
    setCompiled(null);
    setSlow(false);
    const slowTimer = window.setTimeout(() => setSlow(true), 1500);
    try {
      const res = await api.compileBloc({
        name,
        network: network as 'testnet' | 'signet' | 'bitcoin',
        parent_keys: parents.map(toPubkeyHex),
        parents_together_quorum: parentsTogetherQ,
        coparent_quorum: coparentQ,
        kid_keys: kids.map(toPubkeyHex),
        kids_with_parent_quorum: kidsWithParentQ,
        parent_solo_after: parentSoloAfter,
        parent_solo_quorum: parentSoloQ,
        kids_decay_start_after: kidsDecayStartAfter,
        kids_decay_step_blocks: kidsDecayStep,
        kids_decay_start_quorum: kidsDecayStartQ,
        kids_decay_floor_quorum: kidsDecayFloorQ,
      });
      const raw = res.compiled;
      const origins = buildKeyOrigins([...parents, ...kids]);
      setCompiled({ ...raw, descriptor: upgradeDescriptor(raw.descriptor, origins) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Compilation failed');
    } finally {
      window.clearTimeout(slowTimer);
      setCompiling(false);
      setSlow(false);
    }
  }

  function downloadBackup() {
    if (!compiled) return;
    const lines = [
      '# DynastyTrust -- Dynasty Bloc vault backup',
      `# Name: ${name}`,
      `# Network: ${compiled.network}`,
      `# Address type: ${compiled.address_type}`,
      `# Generated: ${new Date().toISOString()}`,
      '',
      '# Receive address',
      compiled.address,
      '',
      '# Output descriptor (Sparrow / Bitcoin Core import)',
      compiled.descriptor,
      '',
      '# Miniscript policy',
      compiled.miniscript_policy,
      '',
      '# Spending paths',
      `Parents together:    ${parentsTogetherQ} of ${parents.length} parents -- anytime`,
      `One parent + kids:   ${coparentQ} of ${parents.length} parents AND ${kidsWithParentQ} of ${kids.length} kids -- anytime`,
      `One parent alone:    ${parentSoloQ} of ${parents.length} parents -- after ${parentSoloAfter.toLocaleString()} blocks (${blocksToHuman(parentSoloAfter)})`,
      '# Kids-alone decaying ladder (relative to funding):',
      ...ladder.map(
        r => `  ${r.q} of ${kids.length} kids -- after ${r.afterBlocks.toLocaleString()} blocks (${blocksToHuman(r.afterBlocks)})`,
      ),
      '',
      '# Parent xpubs',
      ...parents.map(p => p.xpub),
      '',
      '# Kid xpubs',
      ...kids.map(k => k.xpub),
      '',
      '# NOTE: timelocks above are shown as relative offsets from funding.',
      '# The compiled descriptor bakes ABSOLUTE block heights (chain tip',
      '# at compile time + offset). The descriptor is the source of truth.',
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-bloc-backup.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 780 }}>
      <button
        type="button"
        onClick={() => navigate('/policy')}
        style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 13, textAlign: 'left', padding: 0 }}
      >
        &lt;- Back to Policy Builder
      </button>

      <Section
        title="Dynasty Bloc -- decaying family multisig"
        sub="Two parents and their kids. Parents can always spend together; one parent plus every kid can always spend; later timelocks let a single parent act alone, then let the kids take over with a multisig that decays over time. Phase 1 compiles the address + descriptor so you can fund it and hold it in Nunchuk, Sparrow, or Coldcard. In-app spending is coming next."
      >
        <Label>Vault name</Label>
        <Input value={name} onChange={e => { setName(e.target.value); setCompiled(null); }} />
      </Section>

      <Section title="Parents" sub="Each parent holds one key. Parents acting together can spend at any time.">
        <KeyPicker
          selected={parents}
          available={available}
          onAdd={id => addKey(id, 'parent')}
          onRemove={id => removeKey(id, 'parent')}
          role="parent"
          accentColor={colors.gold}
        />
        {parents.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, color: colors.text, marginBottom: 2 }}>Parents-together quorum (Path A)</div>
            <div style={{ fontSize: 12, color: colors.muted }}>How many parents must sign to spend together, anytime. Usually all of them.</div>
            <QuorumPicker max={parents.length} value={parentsTogetherQ} onChange={n => { setParentsTogetherQ(n); setCompiled(null); }} color={colors.gold} />
          </div>
        )}
      </Section>

      <Section title="Kids" sub="Each kid holds one key. Kids can never act without a parent until the kids-alone timelock.">
        <KeyPicker
          selected={kids}
          available={available}
          onAdd={id => addKey(id, 'kid')}
          onRemove={id => removeKey(id, 'kid')}
          role="kid"
          accentColor={colors.green}
        />
        {kids.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, color: colors.text, marginBottom: 2 }}>Kids required with a parent (Path B)</div>
            <div style={{ fontSize: 12, color: colors.muted }}>How many kids must co-sign alongside one parent for an anytime spend. Your rule: every kid.</div>
            <QuorumPicker max={kids.length} value={kidsWithParentQ} onChange={n => { setKidsWithParentQ(n); setCompiled(null); }} color={colors.green} />
          </div>
        )}
      </Section>

      {parents.length > 0 && (
        <Section title="One parent, after a timelock (Path C)" sub="If only one parent is reachable, this lets a reduced parent quorum spend alone once the timelock elapses.">
          <div style={{ fontSize: 13, color: colors.text, marginBottom: 2 }}>Parent quorum for the solo path</div>
          <QuorumPicker max={parents.length} value={parentSoloQ} onChange={n => { setParentSoloQ(n); setCompiled(null); }} color={colors.blue} />
          <div style={{ marginTop: 14 }}>
            <Label>Unlocks after</Label>
            <div style={{ fontSize: 16, fontWeight: 700, color: colors.gold, fontFamily: fonts.display }}>{blocksToHuman(parentSoloAfter)}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
              {TIMELOCK_PRESETS.map(p => (
                <Button
                  key={p.blocks}
                  variant="ghost"
                  size="sm"
                  onClick={() => { setParentSoloAfter(p.blocks); setCompiled(null); }}
                  style={{ padding: '5px 11px', fontSize: 12, ...(parentSoloAfter === p.blocks ? { borderColor: colors.gold, color: colors.gold } : null) }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <Input
              type="number"
              value={parentSoloAfter}
              min={1}
              onChange={e => { setParentSoloAfter(Math.max(1, parseInt(e.target.value) || 1)); setCompiled(null); }}
              style={{ width: 140 }}
            />
            <span style={{ fontSize: 12, color: colors.muted, marginLeft: 8 }}>blocks</span>
          </div>
        </Section>
      )}

      {kids.length > 0 && (
        <Section title="Kids alone, decaying (Path D+)" sub="After the parents are long out of the picture, the kids take over. They start needing many signatures and the requirement drops by one at each later step -- a deadman that loosens as time passes.">
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13, color: colors.text, marginBottom: 2 }}>Start quorum (first rung)</div>
              <QuorumPicker max={kids.length} value={kidsDecayStartQ} onChange={n => { setKidsDecayStartQ(n); setCompiled(null); }} color={colors.green} />
            </div>
            <div>
              <div style={{ fontSize: 13, color: colors.text, marginBottom: 2 }}>Floor quorum (last rung)</div>
              <QuorumPicker max={kids.length} value={kidsDecayFloorQ} onChange={n => { setKidsDecayFloorQ(n); setCompiled(null); }} color={colors.green} />
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <Label>Kids-alone unlocks after</Label>
            <div style={{ fontSize: 16, fontWeight: 700, color: colors.gold, fontFamily: fonts.display }}>{blocksToHuman(kidsDecayStartAfter)}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
              {TIMELOCK_PRESETS.filter(p => p.blocks > parentSoloAfter).map(p => (
                <Button
                  key={p.blocks}
                  variant="ghost"
                  size="sm"
                  onClick={() => { setKidsDecayStartAfter(p.blocks); setCompiled(null); }}
                  style={{ padding: '5px 11px', fontSize: 12, ...(kidsDecayStartAfter === p.blocks ? { borderColor: colors.gold, color: colors.gold } : null) }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <Input
              type="number"
              value={kidsDecayStartAfter}
              min={parentSoloAfter + 1}
              onChange={e => { setKidsDecayStartAfter(Math.max(parentSoloAfter + 1, parseInt(e.target.value) || parentSoloAfter + 1)); setCompiled(null); }}
              style={{ width: 140 }}
            />
            <span style={{ fontSize: 12, color: colors.muted, marginLeft: 8 }}>blocks</span>
          </div>
          <div style={{ marginTop: 14 }}>
            <Label>Step between rungs</Label>
            <div style={{ fontSize: 13, color: colors.muted, marginBottom: 6 }}>{blocksToHuman(kidsDecayStep)} between each drop in the required kid count.</div>
            <Input
              type="number"
              value={kidsDecayStep}
              min={1}
              onChange={e => { setKidsDecayStep(Math.max(1, parseInt(e.target.value) || 1)); setCompiled(null); }}
              style={{ width: 140 }}
            />
            <span style={{ fontSize: 12, color: colors.muted, marginLeft: 8 }}>blocks</span>
          </div>

          {ladder.length > 0 && (
            <div style={{ marginTop: 16, background: colors.inset, border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: '12px 14px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: colors.green, marginBottom: 8 }}>Decay ladder preview</div>
              {ladder.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: colors.sub, padding: '3px 0' }}>
                  <span>{r.q}-of-{kids.length} kids</span>
                  <span style={{ color: colors.muted }}>after {blocksToHuman(r.afterBlocks)} ({r.afterBlocks.toLocaleString()} blocks)</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {errors.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {errors.map((e, i) => (
            <div key={i} style={{ padding: '10px 14px', borderRadius: radii.md, fontSize: 13, background: colors.red + '11', border: `1px solid ${colors.red}33`, color: colors.red }}>
              {e}
            </div>
          ))}
        </div>
      )}

      <div style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>Compile address + descriptor</div>
            <div style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>Builds the Taproot tree on the Fly.io compiler and returns the address + descriptor for export.</div>
          </div>
          <Button disabled={!canCompile || compiling} onClick={compile}>
            {compiling ? (slow ? 'Waking compiler...' : 'Compiling...') : compiled ? 'Recompile' : 'Compile ->'}
          </Button>
        </div>

        {err && (
          <div style={{ padding: 12, background: colors.dangerBg, border: `1px solid ${colors.borderDanger}`, borderRadius: radii.md, color: colors.red, fontSize: 13, marginBottom: 12 }}>
            {err}
          </div>
        )}

        {compiled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ padding: '10px 14px', background: colors.successBg, border: `1px solid ${colors.green}44`, borderRadius: radii.md, color: colors.green, fontSize: 13 }}>
              check Compiled -- {compiled.network.toUpperCase()} . {compiled.address_type.toUpperCase()}
            </div>
            <CopyField label="Bitcoin address" value={compiled.address} />
            <CopyField label="Output descriptor (Sparrow / Coldcard)" value={compiled.descriptor} />
            <CopyField label="Miniscript policy" value={compiled.miniscript_policy} />
            <DescriptorQr descriptor={compiled.descriptor} label="Sparrow-ready QR" size={220} />
            <Button variant="ghost" onClick={downloadBackup}>Download backup (.txt)</Button>
            <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.5 }}>
              Import the descriptor into Nunchuk, Sparrow, or Coldcard to watch + fund this vault. Back up every parent and kid seed on metal before funding. Saving to your dashboard and in-app spending arrive in Phase 2.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
