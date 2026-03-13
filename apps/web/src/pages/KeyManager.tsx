import { useState, useEffect, useCallback } from 'react';
import {
  listKeys, generateSoftwareKey, importXpub,
  updateKeyStatus, deleteKey, revealMnemonic,
  exportKeyring, DEFAULT_PERSONAS,
  type LocalKey, type Network,
} from '../lib/keystore';

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg: '#07070F', surface: '#0F0F1A', raised: '#141422',
  border: '#1E1E30', gold: '#C9A84C', goldDim: '#8B6914',
  text: '#E8E4D8', muted: '#5A5570', sub: '#9994A8',
  red: '#E05C5C', green: '#52C47A', blue: '#4A90D9',
};

const inp: React.CSSProperties = {
  width: '100%', padding: '11px 13px', background: '#161622',
  border: `1px solid ${C.border}`, borderRadius: 8, color: C.text,
  fontSize: 14, fontFamily: '"DM Sans", sans-serif', boxSizing: 'border-box',
};
const monoInp: React.CSSProperties = { ...inp, fontFamily: '"IBM Plex Mono", monospace', fontSize: 12 };
const lbl: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: C.muted,
  textTransform: 'uppercase', marginBottom: 5, display: 'block',
};
const goldBtn: React.CSSProperties = {
  padding: '10px 20px', background: C.gold, border: 'none', borderRadius: 8,
  color: C.bg, fontWeight: 700, fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer',
};
const ghostBtn: React.CSSProperties = {
  padding: '9px 16px', background: 'none', border: `1px solid ${C.border}`,
  borderRadius: 8, color: C.sub, fontSize: 13, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer',
};

// ── Badges ────────────────────────────────────────────────────────────────────
function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
      padding: '3px 8px', borderRadius: 4, background: color + '22', color }}>
      {label}
    </span>
  );
}

// ── Mnemonic word grid ────────────────────────────────────────────────────────
function WordGrid({ words, hidden = false }: { words: string[]; hidden?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
      {words.map((w, i) => (
        <div key={i} style={{
          background: '#0A0A14', border: `1px solid ${C.border}`,
          borderRadius: 6, padding: '7px 10px',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <span style={{ fontSize: 10, color: C.muted, minWidth: 18, flexShrink: 0 }}>{i + 1}</span>
          <span style={{
            fontSize: 12, fontFamily: '"IBM Plex Mono", monospace',
            color: hidden ? 'transparent' : C.text,
            textShadow: hidden ? `0 0 8px ${C.muted}` : 'none',
            userSelect: hidden ? 'none' : 'text',
          }}>{w}</span>
        </div>
      ))}
    </div>
  );
}

// ── Persona pill selector ─────────────────────────────────────────────────────
function PersonaPicker({ value, onChange, custom }: {
  value: string;
  onChange: (v: string) => void;
  custom?: boolean;
}) {
  const [customVal, setCustomVal] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const all = [...DEFAULT_PERSONAS];
  if (value && !all.includes(value)) all.push(value);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {all.map(p => (
          <button key={p} onClick={() => { onChange(p); setShowCustom(false); }} style={{
            ...ghostBtn, padding: '5px 12px', fontSize: 12,
            ...(value === p ? { borderColor: C.gold, color: C.gold, background: C.gold + '11' } : {}),
          }}>{p}</button>
        ))}
        <button onClick={() => setShowCustom(s => !s)} style={{
          ...ghostBtn, padding: '5px 12px', fontSize: 12,
        }}>+ Custom</button>
      </div>
      {showCustom && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...inp, flex: 1 }} placeholder="Custom persona name"
            value={customVal} onChange={e => setCustomVal(e.target.value)} />
          <button style={ghostBtn} onClick={() => {
            if (customVal.trim()) { onChange(customVal.trim()); setShowCustom(false); }
          }}>Set</button>
        </div>
      )}
    </div>
  );
}

// ── Modal shell ───────────────────────────────────────────────────────────────
function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200, padding: 16,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16,
        padding: '28px 32px', width: '100%', maxWidth: 580,
        maxHeight: '90vh', overflowY: 'auto', fontFamily: '"DM Sans", sans-serif',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: C.text,
            fontFamily: '"Playfair Display", serif', margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none',
            color: C.muted, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Generate modal ─────────────────────────────────────────────────────────────
function GenerateModal({ onDone, onClose }: {
  onClose: () => void;
  onDone: (key: LocalKey, mnemonic: string) => void;
}) {
  const [label, setLabel]       = useState('');
  const [network, setNetwork]   = useState<Network>('testnet');
  const [persona, setPersona]   = useState(DEFAULT_PERSONAS[0]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setErr('Passwords do not match'); return; }
    if (password.length < 8)  { setErr('Password must be at least 8 characters'); return; }
    setBusy(true); setErr(null);
    try {
      const { key, mnemonic } = await generateSoftwareKey({ label: label.trim(), network, password, persona });
      onDone(key, mnemonic);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Generate software key" onClose={onClose}>
      <p style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.5 }}>
        A 24-word BIP39 mnemonic is generated in your browser and encrypted locally.
        Assign it to a <strong style={{ color: C.text }}>persona</strong> to simulate
        different signers from one browser session.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={lbl}>Key label</label>
          <input style={inp} value={label} onChange={e => setLabel(e.target.value)}
            required placeholder="e.g. Founder Key 1" />
        </div>
        <div>
          <label style={lbl}>Persona (simulates a different signer)</label>
          <PersonaPicker value={persona} onChange={setPersona} />
        </div>
        <div>
          <label style={lbl}>Network</label>
          <select style={inp} value={network} onChange={e => setNetwork(e.target.value as Network)}>
            <option value="testnet">Testnet</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </div>
        <div>
          <label style={lbl}>Encryption password</label>
          <input style={inp} type="password" value={password}
            onChange={e => setPassword(e.target.value)} required minLength={8}
            placeholder="Min 8 characters — not stored anywhere" />
        </div>
        <div>
          <label style={lbl}>Confirm password</label>
          <input style={inp} type="password" value={confirm}
            onChange={e => setConfirm(e.target.value)} required />
        </div>
        {err && <p style={{ color: C.red, fontSize: 13, margin: 0 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="submit" style={{ ...goldBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}>
            {busy ? 'Generating…' : 'Generate key'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Backup: show mnemonic ─────────────────────────────────────────────────────
function BackupShow({ mnemonic, keyLabel, onNext }: {
  mnemonic: string; keyLabel: string; onNext: () => void;
}) {
  const words = mnemonic.split(' ');
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Modal title="Write down your recovery phrase" onClose={() => {}}>
      <div style={{ padding: '10px 14px', background: '#1A0A0A', border: '1px solid #3A1A1A',
        borderRadius: 8, marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: C.red, margin: 0 }}>
          ⚠️ These 24 words are the <strong>only</strong> way to recover{' '}
          <strong>{keyLabel}</strong>. Write them on paper. Never store digitally.
        </p>
      </div>
      <WordGrid words={words} />
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer',
        marginTop: 18, padding: 14, background: C.raised, borderRadius: 8 }}>
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
        <span style={{ fontSize: 13, color: C.sub }}>
          I have written all 24 words down in order and stored them safely.
        </span>
      </label>
      <button style={{ ...goldBtn, width: '100%', marginTop: 14, opacity: confirmed ? 1 : 0.4 }}
        disabled={!confirmed} onClick={onNext}>
        Verify backup →
      </button>
    </Modal>
  );
}

// ── Backup: verify ────────────────────────────────────────────────────────────
function BackupVerify({ mnemonic, keyLabel, onDone }: {
  mnemonic: string; keyLabel: string; onDone: () => void;
}) {
  const words = mnemonic.split(' ');
  const [positions] = useState<number[]>(() => {
    const p: number[] = [];
    while (p.length < 4) {
      const n = Math.floor(Math.random() * 24);
      if (!p.includes(n)) p.push(n);
    }
    return p.sort((a, b) => a - b);
  });
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);

  function verify() {
    const wrong = positions.filter(p => answers[p]?.trim().toLowerCase() !== words[p]);
    if (wrong.length) {
      setErr(`Word${wrong.length > 1 ? 's' : ''} ${wrong.map(p => `#${p + 1}`).join(', ')} incorrect.`);
      return;
    }
    onDone();
  }

  return (
    <Modal title="Verify your backup" onClose={() => {}}>
      <p style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.5 }}>
        Enter the words at the positions below from your written backup of{' '}
        <strong style={{ color: C.text }}>{keyLabel}</strong>.
      </p>
      {positions.map(pos => (
        <div key={pos} style={{ marginBottom: 12 }}>
          <label style={lbl}>Word #{pos + 1}</label>
          <input style={inp} value={answers[pos] ?? ''}
            onChange={e => setAnswers(p => ({ ...p, [pos]: e.target.value }))}
            autoComplete="off" autoCorrect="off" spellCheck={false} />
        </div>
      ))}
      {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}
      <button style={{ ...goldBtn, width: '100%', marginTop: 8 }} onClick={verify}>
        Confirm backup ✓
      </button>
    </Modal>
  );
}

// ── Import xpub ───────────────────────────────────────────────────────────────
function ImportModal({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [label, setLabel]     = useState('');
  const [persona, setPersona] = useState(DEFAULT_PERSONAS[0]);
  const [network, setNetwork] = useState<Network>('testnet');
  const [xpub, setXpub]       = useState('');
  const [path, setPath]       = useState("m/48'/1'/0'/2'");
  const [err, setErr]         = useState<string | null>(null);

  function handleNetwork(n: Network) {
    setNetwork(n);
    setPath(`m/48'/${n === 'mainnet' ? '0' : '1'}'/0'/2'`);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      importXpub({ label: label.trim(), persona, network, xpub: xpub.trim(), derivationPath: path.trim() });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Import failed'); }
  }

  return (
    <Modal title="Import xpub" onClose={onClose}>
      <p style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.5 }}>
        Import an extended public key from a hardware wallet. Export the xpub at the
        multisig path from your device.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={lbl}>Label</label>
          <input style={inp} value={label} onChange={e => setLabel(e.target.value)}
            required placeholder="e.g. Coldcard — Safe" />
        </div>
        <div>
          <label style={lbl}>Persona</label>
          <PersonaPicker value={persona} onChange={setPersona} />
        </div>
        <div>
          <label style={lbl}>Network</label>
          <select style={inp} value={network} onChange={e => handleNetwork(e.target.value as Network)}>
            <option value="testnet">Testnet</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </div>
        <div>
          <label style={lbl}>xpub / tpub</label>
          <textarea style={{ ...monoInp, resize: 'vertical' }} rows={3}
            value={xpub} onChange={e => setXpub(e.target.value)} required placeholder="xpub6… or tpub…" />
        </div>
        <div>
          <label style={lbl}>Derivation path</label>
          <input style={monoInp} value={path} onChange={e => setPath(e.target.value)} />
        </div>
        {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="submit" style={goldBtn}>Import</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Reveal mnemonic ───────────────────────────────────────────────────────────
function RevealModal({ keyData, onClose }: { keyData: LocalKey; onClose: () => void }) {
  const [pw, setPw]           = useState('');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [err, setErr]         = useState<string | null>(null);
  const [busy, setBusy]       = useState(false);

  async function unlock(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setMnemonic(await revealMnemonic(keyData.keyId, pw)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={mnemonic ? 'Recovery phrase' : 'Unlock mnemonic'} onClose={onClose}>
      {!mnemonic ? (
        <form onSubmit={unlock} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
            Enter the password for <strong style={{ color: C.text }}>{keyData.label}</strong>.
          </p>
          <div>
            <label style={lbl}>Password</label>
            <input style={inp} type="password" value={pw}
              onChange={e => setPw(e.target.value)} required autoFocus />
          </div>
          {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" style={ghostBtn} onClick={onClose}>Cancel</button>
            <button type="submit" style={{ ...goldBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}>
              {busy ? 'Decrypting…' : 'Reveal'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div style={{ padding: '10px 14px', background: '#1A0A0A', border: '1px solid #3A1A1A',
            borderRadius: 8, marginBottom: 16 }}>
            <p style={{ fontSize: 12, color: C.red, margin: 0 }}>
              ⚠️ Keep this screen private. Close when done.
            </p>
          </div>
          <WordGrid words={mnemonic.split(' ')} />
          <button style={{ ...ghostBtn, width: '100%', marginTop: 16 }} onClick={onClose}>
            Done — close
          </button>
        </>
      )}
    </Modal>
  );
}

// ── Detail modal ──────────────────────────────────────────────────────────────
function DetailModal({ keyData: k, onClose, onReveal, onArchive, onDelete }: {
  keyData: LocalKey; onClose: () => void;
  onReveal: () => void; onArchive: () => void; onDelete: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(null), 1600); });
  }

  return (
    <Modal title={k.label} onClose={onClose}>
      <div style={{ background: '#0A0A14', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
        {([
          ['Persona',    k.persona],
          ['Origin',     k.origin],
          ['Network',    k.network.toUpperCase()],
          ['Fingerprint', k.fingerprint],
          ['Path',       k.derivationPath],
          ['Status',     k.status],
          ['Created',    new Date(k.createdAt).toLocaleDateString()],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between',
            padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 12, color: C.muted }}>{label}</span>
            <span style={{ fontSize: 13, color: C.text, fontFamily: label === 'Fingerprint' || label === 'Path' ? '"IBM Plex Mono", monospace' : 'inherit' }}>{value}</span>
          </div>
        ))}
      </div>

      {/* xpub */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={lbl}>xpub</span>
          <button style={{ ...ghostBtn, padding: '3px 9px', fontSize: 11 }} onClick={() => copy(k.xpub, 'xpub')}>
            {copied === 'xpub' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <div style={{ background: '#0A0A14', borderRadius: 8, padding: '10px 12px',
          fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: C.sub,
          wordBreak: 'break-all', lineHeight: 1.6 }}>{k.xpub}</div>
      </div>

      {k.pubkey && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={lbl}>Compressed pubkey</span>
            <button style={{ ...ghostBtn, padding: '3px 9px', fontSize: 11 }} onClick={() => copy(k.pubkey, 'pub')}>
              {copied === 'pub' ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <div style={{ background: '#0A0A14', borderRadius: 8, padding: '10px 12px',
            fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: C.sub,
            wordBreak: 'break-all' }}>{k.pubkey}</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {k.origin === 'software' && k.encryptedMnemonic && (
          <button style={{ ...ghostBtn, fontSize: 13 }} onClick={onReveal}>Show recovery phrase</button>
        )}
        {k.status === 'active' && (
          <button style={{ ...ghostBtn, fontSize: 13 }} onClick={onArchive}>Archive</button>
        )}
        <button style={{ ...ghostBtn, fontSize: 13, color: C.red, borderColor: '#3A1A1A', marginLeft: 'auto' }}
          onClick={onDelete}>Delete</button>
      </div>
    </Modal>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

type ModalState =
  | { type: 'generate' }
  | { type: 'import' }
  | { type: 'backup-show'; key: LocalKey; mnemonic: string }
  | { type: 'backup-verify'; key: LocalKey; mnemonic: string }
  | { type: 'reveal'; key: LocalKey }
  | { type: 'detail'; key: LocalKey };

export default function KeyManager() {
  const [keys, setKeys]         = useState<LocalKey[]>([]);
  const [modal, setModal]       = useState<ModalState | null>(null);
  const [personaFilter, setPersonaFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter]   = useState<'active' | 'all'>('active');

  const reload = useCallback(() => setKeys(listKeys()), []);
  useEffect(() => { reload(); }, [reload]);

  const personas = ['all', ...Array.from(new Set(keys.map(k => k.persona)))];

  const visible = keys.filter(k => {
    if (personaFilter !== 'all' && k.persona !== personaFilter) return false;
    if (statusFilter === 'active' && k.status !== 'active') return false;
    return true;
  });

  function handleArchive(keyId: string) {
    if (!confirm('Archive this key?')) return;
    updateKeyStatus(keyId, 'archived');
    reload(); setModal(null);
  }
  function handleDelete(keyId: string) {
    if (!confirm('Permanently delete this key? This cannot be undone if you have no backup.')) return;
    deleteKey(keyId); reload(); setModal(null);
  }
  function doExport() {
    const blob = new Blob([exportKeyring()], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: `dynastytrust-keyring-${Date.now()}.json`,
    });
    a.click(); URL.revokeObjectURL(a.href);
  }

  const personaColors: Record<string, string> = {};
  const palette = [C.gold, C.blue, C.green, '#B06AE0', '#E06A6A', '#6AB8E0'];
  Array.from(new Set(keys.map(k => k.persona))).forEach((p, i) => {
    personaColors[p] = palette[i % palette.length];
  });

  return (
    <div style={{ fontFamily: '"DM Sans", sans-serif' }}>

      {/* Testing callout */}
      <div style={{ padding: '14px 18px', background: '#0A1400', border: `1px solid ${C.green}44`,
        borderRadius: 10, marginBottom: 20, fontSize: 13, color: C.sub, lineHeight: 1.5 }}>
        <strong style={{ color: C.green }}>Multi-persona testing:</strong> Generate keys under different
        personas (Founder 1, Heir 1, etc.) to simulate a full quorum from one browser.
        Each persona's keys are grouped and labeled so you can track who's who.
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {/* Persona filter */}
          {personas.map(p => (
            <button key={p} onClick={() => setPersonaFilter(p)} style={{
              ...ghostBtn, padding: '5px 12px', fontSize: 12,
              ...(personaFilter === p ? {
                borderColor: p === 'all' ? C.gold : personaColors[p] ?? C.gold,
                color: p === 'all' ? C.gold : personaColors[p] ?? C.gold,
              } : {}),
            }}>
              {p === 'all' ? 'All personas' : p}
            </button>
          ))}
          <button onClick={() => setStatusFilter(s => s === 'active' ? 'all' : 'active')} style={{
            ...ghostBtn, padding: '5px 12px', fontSize: 12,
            ...(statusFilter === 'all' ? { borderColor: C.muted, color: C.muted } : {}),
          }}>
            {statusFilter === 'active' ? 'Showing active' : 'Showing all'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{ ...ghostBtn, fontSize: 13 }} onClick={doExport}>Export</button>
          <button style={ghostBtn} onClick={() => setModal({ type: 'import' })}>Import xpub</button>
          <button style={goldBtn} onClick={() => setModal({ type: 'generate' })}>+ Generate key</button>
        </div>
      </div>

      {/* Empty */}
      {visible.length === 0 && (
        <div style={{ textAlign: 'center', padding: '64px 24px', background: C.surface,
          borderRadius: 14, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🔑</div>
          <p style={{ fontSize: 18, fontWeight: 600, color: C.text, marginBottom: 8 }}>No keys yet</p>
          <p style={{ color: C.muted, fontSize: 14, marginBottom: 24, maxWidth: 360, margin: '0 auto 24px' }}>
            Generate software keys for each persona to simulate a full multisig quorum.
          </p>
          <button style={goldBtn} onClick={() => setModal({ type: 'generate' })}>
            Generate first key
          </button>
        </div>
      )}

      {/* Key list — grouped by persona */}
      {Array.from(new Set(visible.map(k => k.persona))).map(persona => (
        <div key={persona} style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600,
              color: personaColors[persona] ?? C.gold }}>{persona}</span>
            <span style={{ fontSize: 11, color: C.muted }}>
              {visible.filter(k => k.persona === persona).length} key{visible.filter(k => k.persona === persona).length !== 1 ? 's' : ''}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.filter(k => k.persona === persona).map(key => (
              <KeyRow key={key.keyId} keyData={key}
                accentColor={personaColors[persona] ?? C.gold}
                onDetail={() => setModal({ type: 'detail', key })}
                onReveal={() => setModal({ type: 'reveal', key })} />
            ))}
          </div>
        </div>
      ))}

      {/* Modals */}
      {modal?.type === 'generate' && (
        <GenerateModal onClose={() => setModal(null)}
          onDone={(key, mnemonic) => setModal({ type: 'backup-show', key, mnemonic })} />
      )}
      {modal?.type === 'import' && (
        <ImportModal onClose={() => setModal(null)} onDone={() => { reload(); setModal(null); }} />
      )}
      {modal?.type === 'backup-show' && (
        <BackupShow mnemonic={modal.mnemonic} keyLabel={modal.key.label}
          onNext={() => setModal({ type: 'backup-verify', key: modal.key, mnemonic: modal.mnemonic })} />
      )}
      {modal?.type === 'backup-verify' && (
        <BackupVerify mnemonic={modal.mnemonic} keyLabel={modal.key.label}
          onDone={() => { reload(); setModal(null); }} />
      )}
      {modal?.type === 'reveal' && (
        <RevealModal keyData={modal.key} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'detail' && (
        <DetailModal keyData={modal.key}
          onClose={() => setModal(null)}
          onReveal={() => setModal({ type: 'reveal', key: modal.key })}
          onArchive={() => handleArchive(modal.key.keyId)}
          onDelete={() => handleDelete(modal.key.keyId)} />
      )}
    </div>
  );
}
