import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { listKeys, type LocalKey } from '../lib/keystore';
import { api } from '../lib/api';
import { colors, fonts, radii } from '../theme';
import { Button, Input, Label } from '../components/ui';

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

function validate(
  fk: SelectedKey[],
  hk: SelectedKey[],
  fq: number,
  hq: number,
  ra: number,
  ia: number,
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!fk.length) errors.push('At least one founder key is required.');
  if (fq < 1) errors.push('Founder quorum must be >= 1.');
  if (fq > fk.length) errors.push(`Founder quorum (${fq}) exceeds founder key count (${fk.length}).`);
  if (!hk.length) warnings.push('No heir keys -- inheritance path will not be compiled.');
  if (hk.length && hq > hk.length)
    errors.push(`Heir quorum (${hq}) exceeds heir key count (${hk.length}).`);
  if (ra < 26_000)
    errors.push(`Recovery timelock must be >= 26,000 blocks (~6 months). Got ${ra.toLocaleString()}.`);
  if (ia <= ra) errors.push('Inheritance timelock must be greater than recovery timelock.');
  const nets = new Set([...fk, ...hk].map(k => k.network));
  if (nets.size > 1) errors.push('All selected keys must be on the same network.');
  if (fk.length === 1 && fq === 1) warnings.push('1-of-1 founder path -- single point of failure.');
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
  fontSize: 14,
  fontFamily: fonts.sans,
  boxSizing: 'border-box',
};

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div
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
  const [heirQ, setHQ] = useState(1);
  const [recovery, setRecovery] = useState(26_280);
  const [inherit, setInherit] = useState(52_560);
  const [compiled, setCompiled] = useState<CompiledVault | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompErr] = useState<string | null>(null);
  const [slowHint, setSlowHint] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    setAllKeys(listKeys().filter(k => k.status === 'active'));
  }, []);

  const network = [...founderKeys, ...heirKeys][0]?.network ?? 'testnet';
  const { errors, warnings } = validate(founderKeys, heirKeys, founderQ, heirQ, recovery, inherit);
  const canCompile = errors.length === 0 && founderKeys.length > 0;

  function addKey(keyId: string, role: 'founder' | 'heir') {
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
        setFQ(q => Math.min(q, n.length));
        return n;
      });
    } else {
      setHK(prev => {
        const n = [...prev, sk];
        setHQ(q => Math.min(q, n.length));
        return n;
      });
    }
    setCompiled(null);
  }

  function removeKey(keyId: string, role: 'founder' | 'heir') {
    if (role === 'founder') {
      setFK(prev => {
        const n = prev.filter(k => k.keyId !== keyId);
        setFQ(q => Math.min(q, n.length || 1));
        return n;
      });
    } else {
      setHK(prev => {
        const n = prev.filter(k => k.keyId !== keyId);
        setHQ(q => Math.min(q, n.length || 1));
        return n;
      });
    }
    setCompiled(null);
  }

  const availForFounder = allKeys.filter(k => !founderKeys.some(fk => fk.keyId === k.keyId));
  const availForHeir = allKeys.filter(k => !heirKeys.some(hk => hk.keyId === k.keyId));

  async function compile() {
    setCompiling(true);
    setCompErr(null);
    setCompiled(null);
    setSlowHint(false);
    const slowTimer = window.setTimeout(() => setSlowHint(true), 1500);
    try {
      const res = await api.compile({
        name,
        network: network as 'testnet' | 'bitcoin',
        address_type: addrType,
        founder_keys: founderKeys.map(toPubkeyHex),
        founder_quorum: founderQ,
        heir_keys: heirKeys.map(toPubkeyHex),
        heir_quorum: heirQ,
        recovery_after: recovery,
        inheritance_after: inherit,
        save: false,
      });
      const raw = res.compiled as CompiledVault;
      const origins = buildKeyOrigins([...founderKeys, ...heirKeys]);
      setCompiled({ ...raw, descriptor: upgradeDescriptor(raw.descriptor, origins) });
    } catch (e) {
      setCompErr(e instanceof Error ? e.message : 'Compilation failed');
    } finally {
      window.clearTimeout(slowTimer);
      setCompiling(false);
      setSlowHint(false);
    }
  }

  async function save() {
    if (!compiled) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await api.vaults.create({
        name,
        network: compiled.network as 'testnet' | 'bitcoin',
        address: compiled.address,
        descriptor: compiled.descriptor,
        miniscript_policy: compiled.miniscript_policy,
        address_type: compiled.address_type,
        founder_quorum: founderQ,
        heir_quorum: heirQ,
        recovery_after: recovery,
        inheritance_after: inherit,
        founder_keys: founderKeys.map(k => k.xpub),
        heir_keys: heirKeys.map(k => k.xpub),
      });
      navigate(`/vaults/${res.vault.id}`, { state: { vault: res.vault } });
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

      <Section title="Founder keys" sub="Day-to-day spending -- available immediately">
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
      </Section>

      <Section title="Heir keys" sub="Inheritance path -- unlocks after timelock">
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
            <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>Compile vault</div>
            <div style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>
              Sends xpubs to your Fly.io Rust compiler -- returns address, descriptor, Miniscript
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
    </div>
  );
}
