import { useEffect, useState, useCallback } from 'react';
import { api, type Vault, type BalanceResult } from '../lib/api';

interface Props { onSelectVault: (v: Vault) => void; }

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
  const [vaults, setVaults]     = useState<Vault[]>([]);
  const [balances, setBalances] = useState<Record<string, BalanceResult>>({});
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadVaults = useCallback(async () => {
    try {
      setError(null);
      const { vaults } = await api.vaults.list();
      setVaults(vaults);
      for (const v of vaults) {
        api.balance(v.address, v.network)
          .then(b => setBalances(prev => ({ ...prev, [v.id]: b })))
          .catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vaults');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadVaults(); }, [loadVaults]);

  return (
    <div style={{ fontFamily: '"DM Sans", sans-serif' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: 24 }}>
        <span style={{ fontSize: 14, color: '#5A5570' }}>
          {vaults.length} vault{vaults.length !== 1 ? 's' : ''}
        </span>
        <button style={s.navBtn} onClick={() => setShowCreate(true)}>+ Add vault manually</button>
      </div>

      {loading && <p style={s.muted}>Loading…</p>}
      {error   && <p style={s.errText}>{error}</p>}

      {!loading && vaults.length === 0 && (
        <div style={s.empty}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🏦</div>
          <p style={{ fontSize: 18, fontWeight: 600, color: '#E8E4D8', marginBottom: 8 }}>No vaults yet</p>
          <p style={{ color: '#5A5570', fontSize: 14, marginBottom: 24, maxWidth: 360, textAlign: 'center' }}>
            Use the Policy Builder tab to generate keys, configure your policy, and compile your first vault.
          </p>
        </div>
      )}

      <div style={s.grid}>
        {vaults.map(v => {
          const bal = balances[v.id];
          return (
            <button key={v.id} style={s.card} onClick={() => onSelectVault(v)}>
              <div style={s.cardTop}>
                <span style={s.vaultName}>{v.name}</span>
                <span style={{ ...s.badge,
                  background: v.network === 'bitcoin' ? '#2A1F0A' : '#0A1F14',
                  color: v.network === 'bitcoin' ? '#C9A84C' : '#52C47A' }}>
                  {v.network === 'bitcoin' ? 'MAINNET' : 'TESTNET'}
                </span>
              </div>
              <div style={s.balanceRow}>
                <span style={s.btcAmount}>{bal ? satsToBtc(bal.total_sats) : '—'}</span>
                <span style={s.unit}> BTC</span>
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
function CreateVaultModal({ onClose, onCreated }: {
  onClose: () => void; onCreated: (v: Vault) => void;
}) {
  const [name, setName]         = useState('My Vault');
  const [network, setNetwork]   = useState<'testnet' | 'bitcoin'>('testnet');
  const [address, setAddress]   = useState('');
  const [descriptor, setDesc]   = useState('');
  const [policy, setPolicy]     = useState('');
  const [founderKeys, setFK]    = useState('');
  const [heirKeys, setHK]       = useState('');
  const [founderQ, setFQ]       = useState(2);
  const [heirQ, setHQ]          = useState(1);
  const [recovery, setRecovery] = useState(26000);
  const [inherit, setInherit]   = useState(52560);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const { vault } = await api.vaults.create({
        name, network, address, descriptor, miniscript_policy: policy,
        founder_quorum: founderQ, heir_quorum: heirQ,
        recovery_after: recovery, inheritance_after: inherit,
        founder_keys: founderKeys.split('\n').map(k => k.trim()).filter(Boolean),
        heir_keys: heirKeys.split('\n').map(k => k.trim()).filter(Boolean),
      });
      onCreated(vault);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(false); }
  }

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: '#E8E4D8',
            fontFamily: '"Playfair Display", serif', margin: 0 }}>Add vault manually</h2>
          <button style={{ background: 'none', border: 'none', color: '#5A5570',
            fontSize: 18, cursor: 'pointer' }} onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: '#5A5570', marginBottom: 20, lineHeight: 1.5 }}>
          Paste in a vault compiled elsewhere, or use the Policy Builder tab to compile one automatically.
        </p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 2 }}>
              <label style={s.lbl}>Name</label>
              <input style={s.inp} value={name} onChange={e => setName(e.target.value)} required />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.lbl}>Network</label>
              <select style={s.inp} value={network} onChange={e => setNetwork(e.target.value as 'testnet' | 'bitcoin')}>
                <option value="testnet">Testnet</option>
                <option value="bitcoin">Mainnet</option>
              </select>
            </div>
          </div>
          <div><label style={s.lbl}>Bitcoin address</label><input style={s.monoInp} value={address} onChange={e => setAddress(e.target.value)} required /></div>
          <div><label style={s.lbl}>Output descriptor</label><textarea style={s.ta} value={descriptor} onChange={e => setDesc(e.target.value)} required rows={3} /></div>
          <div><label style={s.lbl}>Miniscript policy</label><textarea style={s.ta} value={policy} onChange={e => setPolicy(e.target.value)} required rows={2} /></div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}><label style={s.lbl}>Founder keys (one per line)</label><textarea style={s.ta} value={founderKeys} onChange={e => setFK(e.target.value)} rows={3} /></div>
            <div style={{ flex: 1 }}><label style={s.lbl}>Heir keys (one per line)</label><textarea style={s.ta} value={heirKeys} onChange={e => setHK(e.target.value)} rows={3} /></div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}><label style={s.lbl}>Founder quorum</label><input style={s.inp} type="number" min={1} value={founderQ} onChange={e => setFQ(+e.target.value)} /></div>
            <div style={{ flex: 1 }}><label style={s.lbl}>Heir quorum</label><input style={s.inp} type="number" min={1} value={heirQ} onChange={e => setHQ(+e.target.value)} /></div>
            <div style={{ flex: 1 }}><label style={s.lbl}>Recovery (blocks)</label><input style={s.inp} type="number" value={recovery} onChange={e => setRecovery(+e.target.value)} /></div>
            <div style={{ flex: 1 }}><label style={s.lbl}>Inheritance (blocks)</label><input style={s.inp} type="number" value={inherit} onChange={e => setInherit(+e.target.value)} /></div>
          </div>
          {error && <p style={{ color: '#E05C5C', fontSize: 13 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
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
  navBtn:  { padding: '8px 16px', background: '#C9A84C', border: 'none', borderRadius: 8, color: '#07070F', fontWeight: 700, fontSize: 13, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
  muted:   { color: '#5A5570', fontSize: 14 },
  errText: { color: '#E05C5C', fontSize: 14 },
  empty:   { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '72px 24px' },
  grid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 },
  card:    { background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 14, padding: 22, cursor: 'pointer', textAlign: 'left', width: '100%', fontFamily: '"DM Sans", sans-serif' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  vaultName:{ fontSize: 17, fontWeight: 600, color: '#E8E4D8' },
  badge:   { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', padding: '3px 8px', borderRadius: 4 },
  balanceRow: { display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 },
  btcAmount: { fontSize: 24, fontWeight: 700, color: '#E8E4D8', fontFamily: '"Playfair Display", serif' },
  unit:    { fontSize: 13, color: '#5A5570' },
  usd:     { fontSize: 14, color: '#9994A8' },
  addrRow: { marginBottom: 14 },
  addr:    { fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: '#5A5570' },
  cardFooter: { display: 'flex', gap: 10, borderTop: '1px solid #1A1A28', paddingTop: 12, flexWrap: 'wrap' },
  meta:    { fontSize: 11, color: '#5A5570' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 },
  modal:   { background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 16, padding: '28px 32px', width: '100%', maxWidth: 700, maxHeight: '90vh', overflowY: 'auto' },
  lbl:     { fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: '#5A5570', textTransform: 'uppercase', marginBottom: 4, display: 'block' },
  inp:     { width: '100%', padding: '10px 12px', background: '#161622', border: '1px solid #1E1E30', borderRadius: 8, color: '#E8E4D8', fontSize: 14, fontFamily: '"DM Sans", sans-serif', boxSizing: 'border-box' },
  monoInp: { width: '100%', padding: '10px 12px', background: '#161622', border: '1px solid #1E1E30', borderRadius: 8, color: '#E8E4D8', fontSize: 12, fontFamily: '"IBM Plex Mono", monospace', boxSizing: 'border-box' },
  ta:      { width: '100%', padding: '10px 12px', background: '#161622', border: '1px solid #1E1E30', borderRadius: 8, color: '#E8E4D8', fontSize: 12, fontFamily: '"IBM Plex Mono", monospace', boxSizing: 'border-box', resize: 'vertical' },
  goldBtn: { padding: '11px 22px', background: '#C9A84C', border: 'none', borderRadius: 8, color: '#07070F', fontWeight: 700, fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
  ghostBtn:{ padding: '11px 18px', background: 'none', border: '1px solid #1E1E30', borderRadius: 8, color: '#9994A8', fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
};
