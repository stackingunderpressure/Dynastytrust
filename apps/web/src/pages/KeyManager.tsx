import { useState, useEffect, useCallback } from 'react';
import {
  listKeys, generateTestKey, generateSoftwareKey, importXpub,
  updateKeyStatus, deleteKey, revealMnemonic, secureTestKey,
  markBackedUp, exportKeyring, DEFAULT_PERSONAS,
  type LocalKey, type Network,
} from '../lib/keystore';

const C = {
  bg: '#07070F', surface: '#0F0F1A', raised: '#141422',
  border: '#1E1E30', gold: '#C9A84C', goldDim: '#8B6914',
  text: '#E8E4D8', muted: '#5A5570', sub: '#9994A8',
  red: '#E05C5C', green: '#52C47A', blue: '#4A90D9',
  orange: '#E09050',
};
const inp: React.CSSProperties = {
  width: '100%', padding: '11px 13px', background: '#161622',
  border: `1px solid ${C.border}`, borderRadius: 8, color: C.text,
  fontSize: 14, fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box',
};
const monoInp: React.CSSProperties = { ...inp, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 };
const lbl: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: C.muted,
  textTransform: 'uppercase', marginBottom: 5, display: 'block',
};
const goldBtn: React.CSSProperties = {
  padding: '10px 20px', background: C.gold, border: 'none', borderRadius: 8,
  color: C.bg, fontWeight: 700, fontSize: 14, fontFamily: "'DM Sans', sans-serif", cursor: 'pointer',
};
const ghostBtn: React.CSSProperties = {
  padding: '9px 16px', background: 'none', border: `1px solid ${C.border}`,
  borderRadius: 8, color: C.sub, fontSize: 13, fontFamily: "'DM Sans', sans-serif", cursor: 'pointer',
};

// ── Word grid ─────────────────────────────────────────────────────────────────
function WordGrid({ words }: { words: string[] }) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <button style={{ ...ghostBtn, fontSize: 12, padding: '4px 10px' }}
          onClick={() => setVisible(v => !v)}>
          {visible ? 'Hide' : 'Show words'}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
        {words.map((w, i) => (
          <div key={i} style={{
            background: '#0A0A14', border: `1px solid ${C.border}`,
            borderRadius: 6, padding: '6px 10px',
            display: 'flex', gap: 6, alignItems: 'center',
          }}>
            <span style={{ fontSize: 10, color: C.muted, minWidth: 16, flexShrink: 0 }}>{i + 1}</span>
            <span style={{
              fontSize: 12, fontFamily: "'IBM Plex Mono', monospace",
              color: visible ? C.text : 'transparent',
              textShadow: visible ? 'none' : `0 0 8px ${C.muted}`,
              userSelect: visible ? 'text' : 'none',
            }}>{w}</span>
          </div>
        ))}
      </div>
      {visible && (
        <button style={{ ...ghostBtn, width: '100%', marginTop: 10, fontSize: 12 }}
          onClick={() => navigator.clipboard.writeText(words.join(' '))}>
          Copy all words
        </button>
      )}
    </div>
  );
}

// ── Persona picker ────────────────────────────────────────────────────────────
function PersonaPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const all = [...DEFAULT_PERSONAS, ...(value && !DEFAULT_PERSONAS.includes(value) ? [value] : [])];
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {all.map(p => (
          <button key={p} onClick={() => { onChange(p); setShowCustom(false); }} style={{
            ...ghostBtn, padding: '5px 12px', fontSize: 12,
            ...(value === p ? { borderColor: C.gold, color: C.gold, background: C.gold + '11' } : {}),
          }}>{p}</button>
        ))}
        <button onClick={() => setShowCustom(s => !s)} style={{ ...ghostBtn, padding: '5px 12px', fontSize: 12 }}>
          + Custom
        </button>
      </div>
      {showCustom && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...inp, flex: 1 }} placeholder="Custom name"
            value={custom} onChange={e => setCustom(e.target.value)} />
          <button style={ghostBtn} onClick={() => { if (custom.trim()) { onChange(custom.trim()); setShowCustom(false); } }}>
            Set
          </button>
        </div>
      )}
    </div>
  );
}

// ── Modal shell ───────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200, padding: 16,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16,
        padding: '28px 32px', width: '100%', maxWidth: wide ? 640 : 520,
        maxHeight: '92vh', overflowY: 'auto', fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: C.text,
            fontFamily: "'Playfair Display', serif", margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none',
            color: C.muted, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Quick test key modal ──────────────────────────────────────────────────────
function QuickModal({ onDone, onClose }: {
  onClose: () => void;
  onDone: (key: LocalKey, mnemonic: string) => void;
}) {
  const [label, setLabel]     = useState('');
  const [persona, setPersona] = useState(DEFAULT_PERSONAS[0]);
  const [network, setNetwork] = useState<Network>('testnet');
  const [busy, setBusy]       = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { key, mnemonic } = generateTestKey({ label: label.trim() || persona, network, persona });
      onDone(key, mnemonic);
    } finally { setBusy(false); }


  return (
    <Modal title="Quick test key" onClose={onClose}>
      <div style={{ padding: '10px 14px', background: '#0A1A14',
        border: `1px solid ${C.green}44`, borderRadius: 8, marginBottom: 18 }}>
        <p style={{ fontSize: 13, color: C.green, margin: 0 }}>
          ⚡ No password needed. Mnemonic stored locally for easy access.
          <span style={{ color: C.muted }}> Only use for testnet testing.</span>
        </p>
      </div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={lbl}>Label (optional)</label>
          <input style={inp} value={label} onChange={e => setLabel(e.target.value)}
            placeholder={persona} />
        </div>
        <div>
          <label style={lbl}>Persona</label>
          <PersonaPicker value={persona} onChange={setPersona} />
        </div>
        <div>
          <label style={lbl}>Network</label>
          <select style={inp} value={network} onChange={e => setNetwork(e.target.value as Network)}>
            <option value="testnet">Testnet (recommended for testing)</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <button type="button" style={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="submit" style={{ ...goldBtn, background: C.green, opacity: busy ? 0.6 : 1 }} disabled={busy}>
            ⚡ Generate instantly
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Test key created modal (shows mnemonic, no verify required) ───────────────
function TestKeyCreated({ keyData, mnemonic, onClose }: {
  keyData: LocalKey; mnemonic: string; onClose: () => void;
}) {
  return (
    <Modal title="Key generated" onClose={onClose} wide>
      <div style={{ padding: '10px 14px', background: '#0A1A14',
        border: `1px solid ${C.green}44`, borderRadius: 8, marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: C.green, margin: 0 }}>
          ✓ <strong>{keyData.label}</strong> created for <strong>{keyData.persona}</strong>.
          Mnemonic saved locally — you can view it anytime from the key details.
        </p>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
          Recovery phrase — stored in your browser. Back up when ready.
        </div>
        <WordGrid words={mnemonic.split(' ')} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button style={{ ...ghostBtn, flex: 1 }} onClick={onClose}>
          Done — back up later
        </button>
        <button style={{ ...goldBtn, flex: 1 }} onClick={onClose}>
          Continue →
        </button>
      </div>
    </Modal>
  );
}

// ── Secure generate modal ─────────────────────────────────────────────────────
function SecureModal({ onDone, onClose }: {
  onClose: () => void;
  onDone: (key: LocalKey, mnemonic: string) => void;
}) {
  const [label, setLabel]       = useState('');
  const [persona, setPersona]   = useState(DEFAULT_PERSONAS[0]);
  const [network, setNetwork]   = useState<Network>('testnet');
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
      const { key, mnemonic } = await generateSoftwareKey({
        label: label.trim() || persona, network, password, persona,
      });
      onDone(key, mnemonic);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }


  return (
    <Modal title="Secure key" onClose={onClose}>
      <p style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.5 }}>
        Mnemonic encrypted with your password. Required for real funds.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={lbl}>Label</label>
          <input style={inp} value={label} onChange={e => setLabel(e.target.value)} placeholder={persona} />
        </div>
        <div>
          <label style={lbl}>Persona</label>
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
          <input style={inp} type="password" value={password} onChange={e => setPassword(e.target.value)}
            required minLength={8} placeholder="Min 8 characters" />
        </div>
        <div>
          <label style={lbl}>Confirm password</label>
          <input style={inp} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        </div>
        {err && <p style={{ color: C.red, fontSize: 13, margin: 0 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="submit" style={{ ...goldBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}>
            {busy ? 'Generating…' : 'Generate secure key'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Backup verify (for secure keys) ──────────────────────────────────────────
function BackupFlow({ keyData, mnemonic, onDone }: {
  keyData: LocalKey; mnemonic: string; onDone: () => void;
}) {
  const words    = mnemonic.split(' ');
  const [step, setStep] = useState<'show' | 'verify'>('show');
  const [confirmed, setConfirmed] = useState(false);
  const [positions] = useState<number[]>(() => {
    const p: number[] = [];
    while (p.length < 4) { const n = Math.floor(Math.random() * 24); if (!p.includes(n)) p.push(n); }
    return p.sort((a, b) => a - b);
  });
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);

  function verify() {
    const wrong = positions.filter(p => answers[p]?.trim().toLowerCase() !== words[p]);
    if (wrong.length) { setErr(`Word${wrong.length > 1 ? 's' : ''} ${wrong.map(p => `#${p+1}`).join(', ')} incorrect.`); return; }
    markBackedUp(keyData.keyId);
    onDone();


  if (step === 'show') return (
    <Modal title="Write down your recovery phrase" onClose={() => {}} wide>
      <div style={{ padding: '10px 14px', background: '#1A0A0A', border: '1px solid #3A1A1A',
        borderRadius: 8, marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: C.red, margin: 0 }}>
          ⚠️ Write all 24 words on paper. Never store digitally. This is shown once.
        </p>
      </div>
      <WordGrid words={words} />
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer',
        marginTop: 16, padding: 12, background: C.raised, borderRadius: 8 }}>
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
        <span style={{ fontSize: 13, color: C.sub }}>I have written all 24 words in order.</span>
      </label>
      <button style={{ ...goldBtn, width: '100%', marginTop: 12, opacity: confirmed ? 1 : 0.4 }}
        disabled={!confirmed} onClick={() => setStep('verify')}>
        Verify backup →
      </button>
    </Modal>
  );

  return (
    <Modal title="Verify your backup" onClose={() => {}}>
      <p style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.5 }}>
        Enter the words at the requested positions.
      </p>
      {positions.map(pos => (
        <div key={pos} style={{ marginBottom: 12 }}>
          <label style={lbl}>Word #{pos + 1}</label>
          <input style={inp} value={answers[pos] ?? ''} autoComplete="off" autoCorrect="off" spellCheck={false}
            onChange={e => setAnswers(p => ({ ...p, [pos]: e.target.value }))} />
        </div>
      ))}
      {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}
      <button style={{ ...goldBtn, width: '100%', marginTop: 8 }} onClick={verify}>
        Confirm ✓
      </button>
    </Modal>
  );
}

// ── Reveal / backup modal ─────────────────────────────────────────────────────
function RevealModal({ keyData, onClose, onBackedUp }: {
  keyData: LocalKey; onClose: () => void; onBackedUp: () => void;
}) {
  const [pw, setPw]       = useState('');
  const [mnemonic, setMn] = useState<string | null>(keyData.testMnemonic ?? null);
  const [err, setErr]     = useState<string | null>(null);
  const [busy, setBusy]   = useState(false);
  const [doBackup, setDoBackup] = useState(false);
  const isTest = !!keyData.testMnemonic;

  async function unlock(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setMn(await revealMnemonic(keyData.keyId, pw)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }


  if (doBackup && mnemonic) {
    return <BackupFlow keyData={keyData} mnemonic={mnemonic} onDone={() => { onBackedUp(); onClose(); }} />;


  return (
    <Modal title="Recovery phrase" onClose={onClose} wide>
      {!mnemonic && !isTest ? (
        <form onSubmit={unlock} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: C.muted }}>
            Enter password for <strong style={{ color: C.text }}>{keyData.label}</strong>.
          </p>
          <div>
            <label style={lbl}>Password</label>
            <input style={inp} type="password" value={pw} onChange={e => setPw(e.target.value)} required autoFocus />
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
          {isTest && (
            <div style={{ padding: '10px 14px', background: '#0A1400',
              border: `1px solid ${C.green}44`, borderRadius: 8, marginBottom: 14 }}>
              <p style={{ fontSize: 12, color: C.green, margin: 0 }}>
                Test key — mnemonic accessible without password.
              </p>
            </div>
          )}
          {!isTest && (
            <div style={{ padding: '10px 14px', background: '#1A0A0A', border: '1px solid #3A1A1A',
              borderRadius: 8, marginBottom: 14 }}>
              <p style={{ fontSize: 12, color: C.red, margin: 0 }}>⚠️ Keep this private. Close when done.</p>
            </div>
          )}
          <WordGrid words={mnemonic!.split(' ')} />
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button style={{ ...ghostBtn, flex: 1 }} onClick={onClose}>Close</button>
            {!keyData.backedUp && (
              <button style={{ ...goldBtn, flex: 1 }} onClick={() => setDoBackup(true)}>
                Verify backup →
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

// ── Secure upgrade modal ──────────────────────────────────────────────────────
function SecureUpgradeModal({ keyData, onDone, onClose }: {
  keyData: LocalKey; onDone: () => void; onClose: () => void;
}) {
  const [pw, setPw]       = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== confirm) { setErr('Passwords do not match'); return; }
    if (pw.length < 8)  { setErr('Min 8 characters'); return; }
    setBusy(true); setErr(null);
    try { await secureTestKey(keyData.keyId, pw); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }


  return (
    <Modal title="Secure this key" onClose={onClose}>
      <p style={{ fontSize: 13, color: C.muted, marginBottom: 18, lineHeight: 1.5 }}>
        Set a password to encrypt the mnemonic for <strong style={{ color: C.text }}>{keyData.label}</strong>.
        The plaintext mnemonic will be deleted.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={lbl}>New password</label>
          <input style={inp} type="password" value={pw} onChange={e => setPw(e.target.value)} required minLength={8} autoFocus />
        </div>
        <div>
          <label style={lbl}>Confirm</label>
          <input style={inp} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        </div>
        {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="submit" style={{ ...goldBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}>
            {busy ? 'Encrypting…' : 'Secure key'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Import xpub modal ─────────────────────────────────────────────────────────
function ImportModal({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [label, setLabel]     = useState('');
  const [persona, setPersona] = useState(DEFAULT_PERSONAS[0]);
  const [network, setNetwork] = useState<Network>('testnet');
  const [xpub, setXpub]       = useState('');
  const [path, setPath]       = useState("m/48'/1'/0'/2'");
  const [err, setErr]         = useState<string | null>(null);

  function handleNetwork(n: Network) {
    setNetwork(n); setPath(`m/48'/${n === 'mainnet' ? '0' : '1'}'/0'/2'`);

  function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { importXpub({ label: label.trim() || persona, persona, network, xpub: xpub.trim(), derivationPath: path.trim() }); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Import failed'); }


  return (
    <Modal title="Import xpub" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={lbl}>Label</label>
          <input style={inp} value={label} onChange={e => setLabel(e.target.value)} placeholder={persona} />
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

// ── Key row ───────────────────────────────────────────────────────────────────
function KeyRow({ k, accentColor, onDetail, onReveal }: {
  k: LocalKey; accentColor: string;
  onDetail: () => void; onReveal: () => void;
}) {
  const isTest = !!k.testMnemonic;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
      padding: '14px 18px', cursor: 'pointer',
    }} onClick={onDetail}>
      <div style={{
        width: 40, height: 40, borderRadius: 9, flexShrink: 0,
        background: isTest ? C.green + '18' : C.blue + '18',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
      }}>
        {k.origin === 'software' ? (isTest ? '⚡' : '🔐') : '🔑'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{k.label}</span>
          {isTest && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
              background: C.green + '22', color: C.green }}>TEST</span>
          )}
          {!k.backedUp && k.origin === 'software' && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
              background: C.orange + '22', color: C.orange }}>NOT BACKED UP</span>
          )}
          {k.backedUp && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
              background: C.green + '22', color: C.green }}>✓ BACKED UP</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: accentColor }}>{k.persona}</span>
          <span style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", color: C.muted }}>{k.fingerprint}</span>
          <span style={{ fontSize: 11, color: k.network === 'mainnet' ? C.gold : C.green }}>{k.network.toUpperCase()}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
        {k.origin === 'software' && (
          <button style={{ ...ghostBtn, fontSize: 12, padding: '5px 11px' }} onClick={onReveal}>
            {k.testMnemonic ? '⚡ Mnemonic' : 'Backup'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Detail modal ──────────────────────────────────────────────────────────────
function DetailModal({ k, onClose, onReveal, onSecure, onArchive, onDelete }: {
  k: LocalKey; onClose: () => void; onReveal: () => void;
  onSecure: () => void; onArchive: () => void; onDelete: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(null), 1500); });

  return (
    <Modal title={k.label} onClose={onClose} wide>
      <div style={{ background: '#0A0A14', borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
        {([
          ['Persona', k.persona],
          ['Type', k.testMnemonic ? 'Test key (plaintext mnemonic)' : k.origin === 'imported_xpub' ? 'Imported xpub' : 'Secure key (encrypted)'],
          ['Network', k.network.toUpperCase()],
          ['Fingerprint', k.fingerprint],
          ['Path', k.derivationPath],
          ['Backed up', k.backedUp ? '✓ Yes' : '✗ Not yet'],
          ['Created', new Date(k.createdAt).toLocaleDateString()],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', padding: '9px 14px', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 12, color: C.muted }}>{label}</span>
            <span style={{ fontSize: 13, color: C.text,
              fontFamily: ['Fingerprint','Path'].includes(label) ? "'IBM Plex Mono', monospace" : 'inherit' }}>
              {value}
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
          <span style={lbl}>xpub</span>
          <button style={{ ...ghostBtn, padding: '3px 9px', fontSize: 11 }} onClick={() => copy(k.xpub, 'xpub')}>
            {copied === 'xpub' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <div style={{ background: '#0A0A14', borderRadius: 8, padding: '10px 12px',
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.sub,
          wordBreak: 'break-all', lineHeight: 1.6 }}>{k.xpub}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {k.origin === 'software' && (
          <button style={{ ...ghostBtn, fontSize: 13 }} onClick={onReveal}>
            {k.testMnemonic ? '⚡ View mnemonic' : 'View / backup'}
          </button>
        )}
        {k.testMnemonic && (
          <button style={{ ...ghostBtn, fontSize: 13, color: C.gold, borderColor: C.goldDim }} onClick={onSecure}>
            🔐 Secure key
          </button>
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

// ── Main ──────────────────────────────────────────────────────────────────────

type ModalState =
  | { type: 'quick' }
  | { type: 'secure' }
  | { type: 'import' }
  | { type: 'test-created'; key: LocalKey; mnemonic: string }
  | { type: 'backup'; key: LocalKey; mnemonic: string }
  | { type: 'reveal'; key: LocalKey }
  | { type: 'detail'; key: LocalKey }
  | { type: 'upgrade'; key: LocalKey };

export default function KeyManager() {
  const [keys, setKeys]           = useState<LocalKey[]>([]);
  const [modal, setModal]         = useState<ModalState | null>(null);
  const [personaFilter, setFilter] = useState('all');

  const reload = useCallback(() => setKeys(listKeys()), []);
  useEffect(() => { reload(); }, [reload]);

  const personas = ['all', ...Array.from(new Set(keys.map(k => k.persona)))];
  const visible  = keys.filter(k => {
    if (k.status !== 'active') return false;
    if (personaFilter !== 'all' && k.persona !== personaFilter) return false;
    return true;
  });

  const palette = [C.gold, C.blue, C.green, '#B06AE0', '#E06A6A', '#6AB8E0'];
  const personaColors: Record<string, string> = {};
  Array.from(new Set(keys.map(k => k.persona))).forEach((p, i) => {
    personaColors[p] = palette[i % palette.length];
  });

  function handleArchive(keyId: string) {
    if (!confirm('Archive this key?')) return;
    updateKeyStatus(keyId, 'archived'); reload(); setModal(null);

  function handleDelete(keyId: string) {
    if (!confirm('Permanently delete? This cannot be undone.')) return;
    deleteKey(keyId); reload(); setModal(null);

  function doExport() {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([exportKeyring()], { type: 'application/json' })),
      download: `dynastytrust-keyring-${Date.now()}.json`,
    });
    a.click(); URL.revokeObjectURL(a.href);


  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Two generate buttons */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <button style={{ ...goldBtn, background: C.green, fontSize: 14 }}
          onClick={() => setModal({ type: 'quick' })}>
          ⚡ Quick test key
        </button>
        <button style={{ ...ghostBtn, borderColor: C.goldDim, color: C.gold }}
          onClick={() => setModal({ type: 'secure' })}>
          🔐 Secure key
        </button>
        <button style={ghostBtn} onClick={() => setModal({ type: 'import' })}>
          Import xpub
        </button>
        <button style={{ ...ghostBtn, marginLeft: 'auto' }} onClick={doExport}>
          Export
        </button>
      </div>

      {/* Persona filter */}
      {personas.length > 2 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {personas.map(p => (
            <button key={p} onClick={() => setFilter(p)} style={{
              ...ghostBtn, padding: '5px 12px', fontSize: 12,
              ...(personaFilter === p ? {
                borderColor: p === 'all' ? C.gold : personaColors[p] ?? C.gold,
                color: p === 'all' ? C.gold : personaColors[p] ?? C.gold,
              } : {}),
            }}>{p === 'all' ? 'All' : p}</button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {visible.length === 0 && (
        <div style={{ textAlign: 'center', padding: '64px 24px', background: C.surface,
          borderRadius: 14, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>🔑</div>
          <p style={{ fontSize: 18, fontWeight: 600, color: C.text, marginBottom: 8 }}>No keys yet</p>
          <p style={{ color: C.muted, fontSize: 14, marginBottom: 24, maxWidth: 320, margin: '0 auto 24px' }}>
            Hit <strong style={{ color: C.green }}>Quick test key</strong> to generate keys for each
            persona instantly — no password needed.
          </p>
          <button style={{ ...goldBtn, background: C.green }}
            onClick={() => setModal({ type: 'quick' })}>
            ⚡ Generate first key
          </button>
        </div>
      )}

      {/* Keys grouped by persona */}
      {Array.from(new Set(visible.map(k => k.persona))).map(persona => (
        <div key={persona} style={{ marginBottom: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: personaColors[persona] ?? C.gold }}>
              {persona}
            </span>
            <span style={{ fontSize: 11, color: C.muted }}>
              {visible.filter(k => k.persona === persona).length} key{visible.filter(k => k.persona === persona).length !== 1 ? 's' : ''}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {visible.filter(k => k.persona === persona).map(key => (
              <KeyRow key={key.keyId} k={key}
                accentColor={personaColors[persona] ?? C.gold}
                onDetail={() => setModal({ type: 'detail', key })}
                onReveal={() => setModal({ type: 'reveal', key })} />
            ))}
          </div>
        </div>
      ))}

      {/* Modals */}
      {modal?.type === 'quick' && (
        <QuickModal onClose={() => setModal(null)}
          onDone={(key, mnemonic) => { reload(); setModal({ type: 'test-created', key, mnemonic }); }} />
      )}
      {modal?.type === 'secure' && (
        <SecureModal onClose={() => setModal(null)}
          onDone={(key, mnemonic) => { reload(); setModal({ type: 'backup', key, mnemonic }); }} />
      )}
      {modal?.type === 'import' && (
        <ImportModal onClose={() => setModal(null)} onDone={() => { reload(); setModal(null); }} />
      )}
      {modal?.type === 'test-created' && (
        <TestKeyCreated keyData={modal.key} mnemonic={modal.mnemonic}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === 'backup' && (
        <BackupFlow keyData={modal.key} mnemonic={modal.mnemonic}
          onDone={() => { reload(); setModal(null); }} />
      )}
      {modal?.type === 'reveal' && (
        <RevealModal keyData={modal.key}
          onClose={() => { reload(); setModal(null); }}
          onBackedUp={() => reload()} />
      )}
      {modal?.type === 'detail' && (
        <DetailModal k={modal.key}
          onClose={() => setModal(null)}
          onReveal={() => setModal({ type: 'reveal', key: modal.key })}
          onSecure={() => setModal({ type: 'upgrade', key: modal.key })}
          onArchive={() => handleArchive(modal.key.keyId)}
          onDelete={() => handleDelete(modal.key.keyId)} />
      )}
      {modal?.type === 'upgrade' && (
        <SecureUpgradeModal keyData={modal.key}
          onClose={() => setModal(null)}
          onDone={() => { reload(); setModal(null); }} />
      )}
    </div>
  );




}
