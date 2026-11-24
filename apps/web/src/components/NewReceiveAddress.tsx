import { useCallback, useEffect, useState } from 'react';
import { api, type Vault } from '../lib/api';
import { colors, fonts, radii } from '../theme';
import { Button, Input, Label } from './ui';
import { QrImage } from './QrImage';

// Ranged slice 3 (docs/ranged-addresses-slice3-build-note.md): a vault made
// with "a new address every time" hands out receive addresses derived from
// its own stored descriptors (netlify/functions/vault-addresses.js).
//
// 2026-11-24 (docs/receive-address-reuse-until-paid-build-note.md; operator:
// "If I click on an address and don't use it there is no way to go back and
// use it it just skips to next one. Nunchick only counts after it's used on
// chain"): the address shown is the newest one never paid, the same one
// every time, until it is paid. "I need a different one" gives a new one for
// a second person paying at the same time, refused at 20 unpaid in a row
// (wallets restoring the vault stop looking after 20 empty addresses). The
// list shows every address given out, paid or still waiting; an unpaid one
// can be shown again. Labels are sealed with the vault key.

type Shown = { index: number; address: string; label: string | null; reused: boolean };
type Listed = { index: number; address: string; label: string | null; paid: boolean };

export function NewReceiveAddress({ vault }: { vault: Vault }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [copied, setCopied] = useState(false);
  const [list, setList] = useState<{ addresses: Listed[]; unpaid_run: number; gap_limit: number } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setListErr(null);
    try {
      setList(await api.vaults.receiveAddresses(vault.id));
    } catch (e) {
      setListErr(e instanceof Error ? e.message : 'Could not load the addresses');
    }
  }, [vault.id]);

  useEffect(() => { if (listOpen) void loadList(); }, [listOpen, loadList]);

  async function get(mode: 'current' | 'new') {
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const r = await api.vaults.newReceiveAddress(vault.id, label.trim() || undefined, mode);
      setShown({ index: r.index, address: r.address, label: r.label ?? null, reused: !!r.reused });
      setLabel('');
      if (listOpen) void loadList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const note = { fontSize: 15, color: colors.muted, lineHeight: 1.5 } as const;

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={note}>
        This vault gives each payment its own address, so people who pay you cannot see your other payments or
        your balance. The address below stays yours to give out until money arrives on it; then you get the next one.
      </div>
      <div>
        <Label>Who is it for? (optional, only your vault sees it)</Label>
        <Input value={label} maxLength={80} onChange={e => setLabel(e.target.value)} placeholder="e.g. Paycheck, Mom's gift" />
      </div>
      <Button disabled={busy} style={{ minHeight: 44 }} onClick={() => void get('current')}>
        {busy ? 'Getting the address...' : 'Show receive address'}
      </Button>
      {err && <div style={{ fontSize: 15, color: colors.red, lineHeight: 1.5 }}>{err}</div>}
      {shown && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          {shown.label && <div style={{ fontSize: 15, color: colors.text }}>For: {shown.label}</div>}
          <div style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.text, wordBreak: 'break-all' }}>{shown.address}</div>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 16, minHeight: 44 }}
            onClick={() => { void navigator.clipboard.writeText(shown.address).then(() => setCopied(true)); }}
          >
            {copied ? 'Copied!' : 'Copy this address'}
          </Button>
          <QrImage data={shown.address} size={220} />
          <div style={{ fontSize: 15, color: colors.sub, lineHeight: 1.5 }}>
            Address number {shown.index}, {shown.reused ? 'given out before and not paid yet' : 'never used before'}. Check that
            the wallet you send from shows an address ending in{' '}
            <span style={{ fontFamily: fonts.mono }}>{shown.address.slice(-8)}</span>.
          </div>
          <Button variant="ghost" size="sm" style={{ fontSize: 16, minHeight: 44 }} disabled={busy} onClick={() => void get('new')}>
            I need a different one
          </Button>
          <div style={note}>
            Only when two people are paying you at the same time. Each unpaid address you take adds to a row that
            wallets restoring this vault have to look past; after 20 in a row they stop, so this vault will not give
            out more than that.
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setListOpen(v => !v)}
        style={{ background: 'none', border: 'none', padding: '10px 0', minHeight: 44, fontSize: 15, color: colors.muted, cursor: 'pointer', textDecoration: 'underline', textAlign: 'left' }}
      >
        {listOpen ? 'Hide addresses given out' : 'Addresses given out'}
      </button>
      {listOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {listErr && <div style={{ fontSize: 15, color: colors.red }}>{listErr}</div>}
          {!list && !listErr && <div style={note}>Checking which have been paid...</div>}
          {list && (
            <div style={note}>
              {list.unpaid_run} unpaid in a row (the limit is {list.gap_limit}). Giving an unpaid address to a second
              person works, but the two payments then sit on one address and each payer could see the other's.
            </div>
          )}
          {list?.addresses.length === 0 && <div style={note}>None yet beyond the vault's own address.</div>}
          {list?.addresses.map(a => (
            <button
              key={a.index}
              type="button"
              disabled={a.paid}
              onClick={() => { setShown({ index: a.index, address: a.address, label: a.label, reused: true }); setCopied(false); }}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', minHeight: 44, padding: '8px 10px',
                background: colors.inset, border: `1px solid ${colors.border}`, borderRadius: radii.md, textAlign: 'left',
                cursor: a.paid ? 'default' : 'pointer', color: colors.text,
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ fontSize: 15 }}>#{a.index}{a.label ? ` -- ${a.label}` : ''}</span>
                <span style={{ display: 'block', fontFamily: fonts.mono, fontSize: 14, color: colors.sub, wordBreak: 'break-all' }}>
                  ...{a.address.slice(-12)}
                </span>
              </span>
              <span style={{ fontSize: 15, color: a.paid ? colors.green : colors.orange, flexShrink: 0 }}>{a.paid ? 'Paid' : 'Waiting -- show'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
