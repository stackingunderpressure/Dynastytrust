import { useEffect, useState, useCallback } from 'react';
import { api, type Vault, type BalanceResult } from '../lib/api';
import { supabase } from '../lib/supabase';

interface Props {
  onSelectVault: (v: Vault) => void;
}

function satsToBtc(sats: number) {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') || '0';
}

function blocksToLabel(blocks: number) {
  if (!blocks) return '—';
  const days = Math.round(blocks * 10 / 60 / 24);
  if (days < 30)  return `~${days}d`;
  if (days < 365) return `~${Math.round(days / 30)}mo`;
  return `~${(days / 365).toFixed(1)}yr`;
}

export default function Dashboard({ onSelectVault }: Props) {
  const [vaults, setVaults]   = useState<Vault[]>([]);
  const [balances, setBalances] = useState<Record<string, BalanceResult>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadVaults = useCallback(async () => {
    try {
      setError(null);
      const { vaults } = await api.vaults.list();
      setVaults(vaults);
      // Load balances in background
      for (const v of vaults) {
        api.balance(v.address, v.network)
          .then(b => setBalances(prev => ({ ...prev, [v.id]: b })))
          .catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vaults');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadVaults(); }, [loadVaults]);

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <div style={s.page}>
      {/* Top nav */}
      <header style={s.header}>
        <div style={s.logo}>DYNASTYTRUST</div>
        <div style={s.nav}>
          <button style={s.navBtn} onClick={() => setShowCreate(true)}>+ New Vault</button>
          <button style={s.navGhost} onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main style={s.main}>
        <div style={s.titleRow}>
          <h1 style={s.title}>Your Vaults</h1>
          <span style={s.count}>{vaults.length} vault{vaults.length !== 1 ? 's' : ''}</span>
        </div>

        {loading && <p style={s.muted}>Loading…</p>}
        {error   && <p style={s.errText}>{error}</p>}

        {!loading && vaults.length === 0 && (
          <div style={s.empty}>
            <div style={s.emptyIcon}>⬡</div>
            <p style={s.emptyTitle}>No vaults yet</p>
            <p style={s.emptyBody}>Create your first Bitcoin vault to get started.</p>
            <button style={s.goldBtn} onClick={() => setShowCreate(true)}>Create vault</button>
          </div>
        )}

        <div style={s.grid}>
          {vaults.map(v => {
            const bal = balances[v.id];
            return (
              <button key={v.id} style={s.card} onClick={() => onSelectVault(v)}>
                <div style={s.cardTop}>
                  <span style={s.vaultName}>{v.name}</span>
                  <span style={{ ...s.badge, background: v.network === 'bitcoin' ? '#2A1F0A' : '#0A1F14', color: v.network === 'bitcoin' ? '#C9A84C' : '#52C47A' }}>
                    {v.network === 'bitcoin' ? 'MAINNET' : 'TESTNET'}
                  </span>
                </div>

                <div style={s.balanceRow}>
                  <span style={s.btcAmount}>
                    {bal ? satsToBtc(bal.total_sats) : '—'} <span style={s.unit}>BTC</span>
                  </span>
                  {bal?.usd_value != null && (
                    <span style={s.usd}>${bal.usd_value.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                  )}
                </div>

                <div style={s.addrRow}>
                  <span style={s.addr}>{v.address.slice(0, 16)}…{v.address.slice(-8)}</span>
                </div>

                <div style={s.cardFooter}>
                  <span style={s.meta}>{v.founder_quorum}/{v.founder_keys.length} founders</span>
                  <span style={s.meta}>{v.heir_quorum}/{v.heir_keys.length} heirs</span>
                  <span style={s.meta}>Recovery {blocksToLabel(v.recovery_after)}</span>
                </div>
              </button>
            );
          })}
        </div>
      </main>

      {showCreate && (
        <CreateVaultModal
          onClose={() => setShowCreate(false)}
          onCreated={(v) => { setShowCreate(false); void loadVaults(); onSelectVault(v); }}
        />
      )}
    </div>
  );
}

// ── Create Vault Modal ─────────────────────────────────────────────────────────

interface CreateProps {
  onClose: () => void;
  onCreated: (v: Vault) => void;
}

function CreateVaultModal({ onClose, onCreated }: CreateProps) {
  const [name, setName]               = useState('My Vault');
  const [network, setNetwork]         = useState<'testnet' | 'bitcoin'>('testnet');
  const [address, setAddress]         = useState('');
  const [descriptor, setDescriptor]   = useState('');
  const [policy, setPolicy]           = useState('');
  const [founderKeys, setFounderKeys] = useState('');
  const [heirKeys, setHeirKeys]       = useState('');
  const [founderQ, setFounderQ]       = useState(2);
  const [heirQ, setHeirQ]             = useState(1);
  const [recovery, setRecovery]       = useState(26000);
  const [inheritance, setInheritance] = useState(52560);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { vault } = await api.vaults.create({
        name,
        network,
        address,
        descriptor,
        miniscript_policy: policy,
        founder_quorum: founderQ,
        heir_quorum: heirQ,
        recovery_after: recovery,
        inheritance_after: inheritance,
        founder_keys: founderKeys.split('\n').map(k => k.trim()).filter(Boolean),
        heir_keys:    heirKeys.split('\n').map(k => k.trim()).filter(Boolean),
      });
      onCreated(vault);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create vault');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={s.modalHeader}>
          <h2 style={s.modalTitle}>New Vault</h2>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <p style={s.modalNote}>
          Paste in a vault you've already compiled, or use the{' '}
          <code style={{ color: '#C9A84C' }}>/api/compile</code> endpoint to generate one from your keys.
        </p>

        <form onSubmit={submit} style={s.mForm}>
          <div style={s.mRow}>
            <div style={{ flex: 2 }}>
              <label style={s.label}>Vault name</label>
              <input style={s.input} value={name} onChange={e => setName(e.target.value)} required />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Network</label>
              <select style={s.input} value={network} onChange={e => setNetwork(e.target.value as 'testnet' | 'bitcoin')}>
                <option value="testnet">Testnet</option>
                <option value="bitcoin">Mainnet</option>
              </select>
            </div>
          </div>

          <label style={s.label}>Bitcoin address</label>
          <input style={s.monoInput} value={address} onChange={e => setAddress(e.target.value)} required placeholder="tb1p… or bc1p…" />

          <label style={s.label}>Output descriptor</label>
          <textarea style={s.textarea} value={descriptor} onChange={e => setDescriptor(e.target.value)} required rows={3} placeholder="tr(…)" />

          <label style={s.label}>Miniscript policy</label>
          <textarea style={s.textarea} value={policy} onChange={e => setPolicy(e.target.value)} required rows={2} placeholder="thresh(…)" />

          <div style={s.mRow}>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Founder keys (one per line)</label>
              <textarea style={s.textarea} value={founderKeys} onChange={e => setFounderKeys(e.target.value)} rows={3} placeholder="xpub…" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Heir keys (one per line)</label>
              <textarea style={s.textarea} value={heirKeys} onChange={e => setHeirKeys(e.target.value)} rows={3} placeholder="xpub…" />
            </div>
          </div>

          <div style={s.mRow}>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Founder quorum</label>
              <input style={s.input} type="number" min={1} max={10} value={founderQ} onChange={e => setFounderQ(+e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Heir quorum</label>
              <input style={s.input} type="number" min={1} max={10} value={heirQ} onChange={e => setHeirQ(+e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Recovery (blocks)</label>
              <input style={s.input} type="number" min={144} value={recovery} onChange={e => setRecovery(+e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Inheritance (blocks)</label>
              <input style={s.input} type="number" min={144} value={inheritance} onChange={e => setInheritance(+e.target.value)} />
            </div>
          </div>

          {error && <p style={s.errText}>{error}</p>}

          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <button type="button" style={s.ghostBtn} onClick={onClose}>Cancel</button>
            <button type="submit" style={{ ...s.goldBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}>
              {busy ? 'Creating…' : 'Create vault'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page:     { minHeight: '100vh', background: '#07070F', fontFamily: '"DM Sans", sans-serif' },
  header:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px', height: 64, borderBottom: '1px solid #1E1E30', background: '#0A0A12' },
  logo:     { fontFamily: '"Playfair Display", serif', fontSize: 18, fontWeight: 700, letterSpacing: '0.12em', color: '#C9A84C' },
  nav:      { display: 'flex', gap: 12, alignItems: 'center' },
  navBtn:   { padding: '8px 18px', background: '#C9A84C', border: 'none', borderRadius: 8, color: '#07070F', fontWeight: 700, fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
  navGhost: { padding: '8px 14px', background: 'none', border: '1px solid #1E1E30', borderRadius: 8, color: '#5A5570', fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
  main:     { maxWidth: 1100, margin: '0 auto', padding: '40px 32px' },
  titleRow: { display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 28 },
  title:    { fontSize: 28, fontWeight: 600, color: '#E8E4D8', fontFamily: '"Playfair Display", serif', margin: 0 },
  count:    { fontSize: 14, color: '#5A5570' },
  muted:    { color: '#5A5570', fontSize: 14 },
  errText:  { color: '#E05C5C', fontSize: 14 },
  grid:     { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 },
  card:     { background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 14, padding: 24, cursor: 'pointer', textAlign: 'left' as const, width: '100%', fontFamily: '"DM Sans", sans-serif', transition: 'border-color 0.15s' },
  cardTop:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  vaultName:{ fontSize: 18, fontWeight: 600, color: '#E8E4D8' },
  badge:    { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', padding: '3px 8px', borderRadius: 4 },
  balanceRow: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 },
  btcAmount:{ fontSize: 26, fontWeight: 700, color: '#E8E4D8', fontFamily: '"Playfair Display", serif' },
  unit:     { fontSize: 14, color: '#5A5570' },
  usd:      { fontSize: 16, color: '#9994A8' },
  addrRow:  { marginBottom: 16 },
  addr:     { fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, color: '#5A5570' },
  cardFooter: { display: 'flex', gap: 12, borderTop: '1px solid #1A1A28', paddingTop: 14, flexWrap: 'wrap' as const },
  meta:     { fontSize: 12, color: '#5A5570' },
  empty:    { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', padding: '80px 24px', gap: 12 },
  emptyIcon:{ fontSize: 48, color: '#1E1E30' },
  emptyTitle: { fontSize: 20, fontWeight: 600, color: '#E8E4D8', margin: 0 },
  emptyBody:  { fontSize: 14, color: '#5A5570', margin: 0 },
  goldBtn:  { padding: '12px 24px', background: '#C9A84C', border: 'none', borderRadius: 8, color: '#07070F', fontWeight: 700, fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
  ghostBtn: { padding: '12px 24px', background: 'none', border: '1px solid #1E1E30', borderRadius: 8, color: '#9994A8', fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
  // Modal
  overlay:  { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 },
  modal:    { background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 16, padding: '32px', width: '100%', maxWidth: 720, maxHeight: '90vh', overflowY: 'auto' as const, fontFamily: '"DM Sans", sans-serif' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  modalTitle: { fontSize: 22, fontWeight: 600, color: '#E8E4D8', fontFamily: '"Playfair Display", serif', margin: 0 },
  modalNote:  { fontSize: 13, color: '#5A5570', marginBottom: 24, lineHeight: 1.5 },
  closeBtn: { background: 'none', border: 'none', color: '#5A5570', fontSize: 18, cursor: 'pointer' },
  mForm:    { display: 'flex', flexDirection: 'column' as const, gap: 10 },
  mRow:     { display: 'flex', gap: 12 },
  label:    { fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: '#5A5570', textTransform: 'uppercase' as const, marginBottom: 4, display: 'block' },
  input:    { width: '100%', padding: '10px 12px', background: '#161622', border: '1px solid #1E1E30', borderRadius: 8, color: '#E8E4D8', fontSize: 14, fontFamily: '"DM Sans", sans-serif', boxSizing: 'border-box' as const },
  monoInput:{ width: '100%', padding: '10px 12px', background: '#161622', border: '1px solid #1E1E30', borderRadius: 8, color: '#E8E4D8', fontSize: 12, fontFamily: '"IBM Plex Mono", monospace', boxSizing: 'border-box' as const },
  textarea: { width: '100%', padding: '10px 12px', background: '#161622', border: '1px solid #1E1E30', borderRadius: 8, color: '#E8E4D8', fontSize: 12, fontFamily: '"IBM Plex Mono", monospace', boxSizing: 'border-box' as const, resize: 'vertical' as const },
};
