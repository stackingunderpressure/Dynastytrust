import { useEffect, useState, useCallback } from 'react';
import { api, type Vault, type Proposal, type BalanceResult } from '../lib/api';

interface Props {
  vault: Vault;
  onBack: () => void;
}

function satsToBtc(sats: number) {
  return (sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function blocksToLabel(blocks: number) {
  if (!blocks) return '—';
  const days = Math.round(blocks * 10 / 60 / 24);
  if (days < 30)  return `~${days} days`;
  if (days < 365) return `~${Math.round(days / 30)} months`;
  return `~${(days / 365).toFixed(1)} years`;
}

function statusColor(s: Proposal['status']): string {
  return s === 'broadcast' ? '#52C47A' : s === 'signed' ? '#C9A84C' : s === 'cancelled' ? '#5A5570' : '#4A90D9';
}

export default function VaultDetail({ vault, onBack }: Props) {
  const [balance, setBalance]     = useState<BalanceResult | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [tab, setTab]             = useState<'overview' | 'proposals' | 'keys'>('overview');
  const [showSpend, setShowSpend] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const load = useCallback(async () => {
    const [balRes, propRes] = await Promise.allSettled([
      api.balance(vault.address, vault.network),
      api.proposals.list(vault.id),
    ]);
    if (balRes.status  === 'fulfilled') setBalance(balRes.value);
    if (propRes.status === 'fulfilled') setProposals(propRes.value.proposals);
  }, [vault]);

  useEffect(() => { void load(); }, [load]);

  async function archive() {
    if (!confirm(`Archive vault "${vault.name}"? It will no longer appear by default.`)) return;
    setArchiving(true);
    try { await api.vaults.archive(vault.id); onBack(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
    finally { setArchiving(false); }
  }

  async function downloadPdf() {
    try {
      const url = await api.pdfUrl(vault.id);
      window.open(url, '_blank');
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  }

  return (
    <div style={s.page}>
      {/* Header */}
      <header style={s.header}>
        <button style={s.back} onClick={onBack}>← Vaults</button>
        <div style={s.headerCenter}>
          <span style={s.logo}>DYNASTYTRUST</span>
        </div>
        <div style={s.headerRight}>
          <button style={s.ghostBtn} onClick={downloadPdf}>Download PDF</button>
          <button style={{ ...s.ghostBtn, color: '#E05C5C', borderColor: '#3A1A1A' }} onClick={archive} disabled={archiving}>
            {archiving ? '…' : 'Archive'}
          </button>
        </div>
      </header>

      <main style={s.main}>
        {/* Vault title + balance hero */}
        <div style={s.hero}>
          <div>
            <div style={s.networkBadge}>
              {vault.network === 'bitcoin' ? '● MAINNET' : '○ TESTNET'}
            </div>
            <h1 style={s.vaultTitle}>{vault.name}</h1>
            <div style={s.address}>{vault.address}</div>
          </div>
          <div style={s.balanceCard}>
            <div style={s.balLabel}>Total balance</div>
            <div style={s.balBtc}>
              {balance ? satsToBtc(balance.total_sats) : '—'}
              <span style={s.balUnit}> BTC</span>
            </div>
            {balance?.usd_value != null && (
              <div style={s.balUsd}>${balance.usd_value.toLocaleString('en-US', { maximumFractionDigits: 0 })} USD</div>
            )}
            {balance && (
              <div style={s.balSplit}>
                <span>✓ {satsToBtc(balance.confirmed_sats)} confirmed</span>
                {balance.unconfirmed_sats !== 0 && (
                  <span>⟳ {satsToBtc(balance.unconfirmed_sats)} pending</span>
                )}
              </div>
            )}
            <button style={s.spendBtn} onClick={() => setShowSpend(true)}>
              Initiate spend →
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          {(['overview', 'proposals', 'keys'] as const).map(t => (
            <button key={t} style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {t === 'proposals' && proposals.length > 0 && (
                <span style={s.pill}>{proposals.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Overview */}
        {tab === 'overview' && (
          <div style={s.section}>
            <div style={s.policyGrid}>
              <PolicyPath
                number={1} color="#C9A84C" label="Founders — Available Now"
                body={`${vault.founder_quorum} of ${vault.founder_keys.length} founder signatures. Available at any time.`}
              />
              <PolicyPath
                number={2} color="#4A90D9" label={`Founder Recovery — After ${blocksToLabel(vault.recovery_after)}`}
                body={`Unlocks after ${vault.recovery_after.toLocaleString()} blocks (${blocksToLabel(vault.recovery_after)}). For lost or unavailable devices.`}
              />
              <PolicyPath
                number={3} color="#52C47A" label={`Heir Inheritance — After ${blocksToLabel(vault.inheritance_after)}`}
                body={`${vault.heir_quorum} of ${vault.heir_keys.length} heir signatures after ${vault.inheritance_after.toLocaleString()} blocks (${blocksToLabel(vault.inheritance_after)}).`}
              />
            </div>

            <div style={s.detailGrid}>
              {[
                ['Address type',       vault.address_type.toUpperCase()],
                ['Founder quorum',     `${vault.founder_quorum} of ${vault.founder_keys.length}`],
                ['Heir quorum',        `${vault.heir_quorum} of ${vault.heir_keys.length}`],
                ['Recovery timelock',  `${vault.recovery_after.toLocaleString()} blocks`],
                ['Inheritance timelock',`${vault.inheritance_after.toLocaleString()} blocks`],
                ['Created',            new Date(vault.created_at).toLocaleDateString()],
              ].map(([k, v]) => (
                <div key={k} style={s.detailRow}>
                  <span style={s.detailKey}>{k}</span>
                  <span style={s.detailVal}>{v}</span>
                </div>
              ))}
            </div>

            <div style={s.box}>
              <div style={s.boxLabel}>OUTPUT DESCRIPTOR</div>
              <div style={s.mono}>{vault.descriptor}</div>
            </div>
          </div>
        )}

        {/* Proposals */}
        {tab === 'proposals' && (
          <div style={s.section}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <p style={s.muted}>Spend proposals for this vault</p>
              <button style={s.goldBtn} onClick={() => setShowSpend(true)}>+ New proposal</button>
            </div>
            {proposals.length === 0 && <p style={s.muted}>No proposals yet.</p>}
            {proposals.map(p => (
              <div key={p.id} style={s.proposalRow}>
                <div style={s.proposalLeft}>
                  <span style={{ ...s.statusDot, background: statusColor(p.status) }} />
                  <div>
                    <div style={s.propAmount}>{satsToBtc(p.amount_sats)} BTC</div>
                    <div style={s.propDest}>{p.destination.slice(0, 20)}…{p.destination.slice(-8)}</div>
                  </div>
                </div>
                <div style={s.proposalRight}>
                  <span style={{ ...s.statusTag, background: statusColor(p.status) + '22', color: statusColor(p.status) }}>
                    {p.status}
                  </span>
                  <span style={s.propMeta}>{p.path.replace('_', ' ')}</span>
                  {p.txid && (
                    <a href={`https://mempool.space/${vault.network === 'bitcoin' ? '' : 'testnet/'}tx/${p.txid}`}
                       target="_blank" rel="noreferrer" style={s.txLink}>
                      View tx ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Keys */}
        {tab === 'keys' && (
          <div style={s.section}>
            <div style={s.keyGroup}>
              <h3 style={s.keyGroupTitle}>Founder Keys ({vault.founder_keys.length})</h3>
              {vault.founder_keys.length === 0 && <p style={s.muted}>No founder keys stored.</p>}
              {vault.founder_keys.map((k, i) => (
                <div key={i} style={s.keyRow}>
                  <span style={s.keyIndex}>F{i + 1}</span>
                  <span style={s.keyVal}>{k}</span>
                </div>
              ))}
            </div>
            <div style={s.keyGroup}>
              <h3 style={s.keyGroupTitle}>Heir Keys ({vault.heir_keys.length})</h3>
              {vault.heir_keys.length === 0 && <p style={s.muted}>No heir keys stored.</p>}
              {vault.heir_keys.map((k, i) => (
                <div key={i} style={s.keyRow}>
                  <span style={{ ...s.keyIndex, background: '#0A1F14', color: '#52C47A' }}>H{i + 1}</span>
                  <span style={s.keyVal}>{k}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {showSpend && (
        <SpendModal
          vault={vault}
          onClose={() => setShowSpend(false)}
          onCreated={() => { setShowSpend(false); void load(); setTab('proposals'); }}
        />
      )}
    </div>
  );
}

function PolicyPath({ number, color, label, body }: { number: number; color: string; label: string; body: string }) {
  return (
    <div style={{ background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 12, padding: 20, borderLeft: `3px solid ${color}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color, marginBottom: 6 }}>PATH {number}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#E8E4D8', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#9994A8', lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}

function SpendModal({ vault, onClose, onCreated }: { vault: Vault; onClose: () => void; onCreated: () => void }) {
  const [dest, setDest]     = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo]     = useState('');
  const [path, setPath]     = useState<'founders_now' | 'recovery' | 'inheritance'>('founders_now');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const sats = Math.round(parseFloat(amount) * 1e8);
      await api.proposals.create({ vault_id: vault.id, destination: dest, amount_sats: sats, path, memo });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ ...s.modal, maxWidth: 480 }}>
        <div style={s.modalHeader}>
          <h2 style={s.modalTitle}>Initiate Spend</h2>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={s.label}>Spending path</label>
            <select style={s.input} value={path} onChange={e => setPath(e.target.value as typeof path)}>
              <option value="founders_now">Founders (available now)</option>
              <option value="recovery">Founder recovery (timelock)</option>
              <option value="inheritance">Heir inheritance (timelock)</option>
            </select>
          </div>
          <div>
            <label style={s.label}>Destination address</label>
            <input style={s.monoInput} value={dest} onChange={e => setDest(e.target.value)} required placeholder="bc1p… or tb1p…" />
          </div>
          <div>
            <label style={s.label}>Amount (BTC)</label>
            <input style={s.input} type="number" step="0.00000001" min="0.00000546" value={amount} onChange={e => setAmount(e.target.value)} required placeholder="0.001" />
          </div>
          <div>
            <label style={s.label}>Memo (optional)</label>
            <input style={s.input} value={memo} onChange={e => setMemo(e.target.value)} placeholder="Purpose of this spend" />
          </div>
          {error && <p style={s.errText}>{error}</p>}
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button type="button" style={s.ghostBtn} onClick={onClose}>Cancel</button>
            <button type="submit" style={{ ...s.goldBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}>
              {busy ? 'Creating…' : 'Create proposal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page:          { minHeight: '100vh', background: '#07070F', fontFamily: '"DM Sans", sans-serif' },
  header:        { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px', height: 64, borderBottom: '1px solid #1E1E30', background: '#0A0A12' },
  back:          { background: 'none', border: 'none', color: '#5A5570', fontSize: 14, cursor: 'pointer', fontFamily: '"DM Sans", sans-serif', padding: 0 },
  headerCenter:  { position: 'absolute' as const, left: '50%', transform: 'translateX(-50%)' },
  logo:          { fontFamily: '"Playfair Display", serif', fontSize: 16, fontWeight: 700, letterSpacing: '0.12em', color: '#C9A84C' },
  headerRight:   { display: 'flex', gap: 10 },
  ghostBtn:      { padding: '8px 14px', background: 'none', border: '1px solid #1E1E30', borderRadius: 8, color: '#9994A8', fontSize: 13, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
  goldBtn:       { padding: '10px 20px', background: '#C9A84C', border: 'none', borderRadius: 8, color: '#07070F', fontWeight: 700, fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
  main:          { maxWidth: 1000, margin: '0 auto', padding: '40px 32px' },
  hero:          { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 40, gap: 24, flexWrap: 'wrap' as const },
  networkBadge:  { fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: '#5A5570', marginBottom: 8 },
  vaultTitle:    { fontSize: 36, fontWeight: 700, color: '#E8E4D8', fontFamily: '"Playfair Display", serif', margin: '0 0 10px' },
  address:       { fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, color: '#5A5570', wordBreak: 'break-all' as const, maxWidth: 500 },
  balanceCard:   { background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 14, padding: 24, minWidth: 260 },
  balLabel:      { fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', color: '#5A5570', textTransform: 'uppercase' as const, marginBottom: 8 },
  balBtc:        { fontSize: 32, fontWeight: 700, color: '#E8E4D8', fontFamily: '"Playfair Display", serif', marginBottom: 4 },
  balUnit:       { fontSize: 16, color: '#5A5570' },
  balUsd:        { fontSize: 18, color: '#9994A8', marginBottom: 12 },
  balSplit:      { fontSize: 12, color: '#5A5570', display: 'flex', flexDirection: 'column' as const, gap: 2, marginBottom: 16 },
  spendBtn:      { width: '100%', padding: '12px', background: '#C9A84C', border: 'none', borderRadius: 8, color: '#07070F', fontWeight: 700, fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer' },
  tabs:          { display: 'flex', gap: 4, borderBottom: '1px solid #1E1E30', marginBottom: 28 },
  tab:           { padding: '10px 20px', background: 'none', border: 'none', color: '#5A5570', fontSize: 14, fontFamily: '"DM Sans", sans-serif', cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6 },
  tabActive:     { color: '#E8E4D8', borderBottomColor: '#C9A84C' },
  pill:          { background: '#C9A84C', color: '#07070F', fontSize: 10, fontWeight: 700, borderRadius: 10, padding: '1px 6px' },
  section:       {},
  policyGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14, marginBottom: 28 },
  detailGrid:    { background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 12, overflow: 'hidden', marginBottom: 24 },
  detailRow:     { display: 'flex', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #1A1A28' },
  detailKey:     { fontSize: 13, color: '#5A5570' },
  detailVal:     { fontSize: 13, color: '#E8E4D8', fontWeight: 500 },
  box:           { background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 12, padding: 16 },
  boxLabel:      { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: '#5A5570', marginBottom: 10 },
  mono:          { fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: '#9994A8', wordBreak: 'break-all' as const, lineHeight: 1.6 },
  muted:         { color: '#5A5570', fontSize: 14 },
  errText:       { color: '#E05C5C', fontSize: 13 },
  proposalRow:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 10, marginBottom: 8 },
  proposalLeft:  { display: 'flex', alignItems: 'center', gap: 12 },
  proposalRight: { display: 'flex', alignItems: 'center', gap: 12 },
  statusDot:     { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  propAmount:    { fontSize: 15, fontWeight: 600, color: '#E8E4D8', fontFamily: '"Playfair Display", serif' },
  propDest:      { fontSize: 12, color: '#5A5570', fontFamily: '"IBM Plex Mono", monospace' },
  statusTag:     { fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase' as const },
  propMeta:      { fontSize: 12, color: '#5A5570' },
  txLink:        { fontSize: 12, color: '#C9A84C', textDecoration: 'none' },
  keyGroup:      { marginBottom: 28 },
  keyGroupTitle: { fontSize: 14, fontWeight: 600, color: '#E8E4D8', marginBottom: 12 },
  keyRow:        { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 8, marginBottom: 6 },
  keyIndex:      { fontSize: 11, fontWeight: 700, background: '#2A1F0A', color: '#C9A84C', padding: '3px 7px', borderRadius: 4, flexShrink: 0 },
  keyVal:        { fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: '#9994A8', wordBreak: 'break-all' as const },
  // Modal
  overlay:       { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 },
  modal:         { background: '#0F0F1A', border: '1px solid #1E1E30', borderRadius: 16, padding: '32px', width: '100%', maxWidth: 720, maxHeight: '90vh', overflowY: 'auto' as const },
  modalHeader:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle:    { fontSize: 22, fontWeight: 600, color: '#E8E4D8', fontFamily: '"Playfair Display", serif', margin: 0 },
  closeBtn:      { background: 'none', border: 'none', color: '#5A5570', fontSize: 18, cursor: 'pointer' },
  label:         { fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: '#5A5570', textTransform: 'uppercase' as const, marginBottom: 4, display: 'block' },
  input:         { width: '100%', padding: '10px 12px', background: '#161622', border: '1px solid #1E1E30', borderRadius: 8, color: '#E8E4D8', fontSize: 14, fontFamily: '"DM Sans", sans-serif', boxSizing: 'border-box' as const },
  monoInput:     { width: '100%', padding: '10px 12px', background: '#161622', border: '1px solid #1E1E30', borderRadius: 8, color: '#E8E4D8', fontSize: 12, fontFamily: '"IBM Plex Mono", monospace', boxSizing: 'border-box' as const },
};
