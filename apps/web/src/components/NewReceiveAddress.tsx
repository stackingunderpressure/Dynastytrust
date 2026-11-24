import { useState } from 'react';
import { api, type Vault } from '../lib/api';
import { colors, fonts } from '../theme';
import { Button, Input, Label } from './ui';
import { QrImage } from './QrImage';

// Ranged slice 3 (docs/ranged-addresses-slice3-build-note.md): a vault made
// with "a new address every time" hands out a never-used receive address on
// request (netlify/functions/vault-addresses.js derives it from the vault's
// own stored descriptors and records it before answering). The optional
// label is sealed with the vault key; the server never reads it.

export function NewReceiveAddress({ vault }: { vault: Vault }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ index: number; address: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function issue() {
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const r = await api.vaults.newReceiveAddress(vault.id, label.trim() || undefined);
      setIssued({ index: r.index, address: r.address });
      setLabel('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 15, color: colors.muted, lineHeight: 1.5 }}>
        This vault gives every payment its own address, so people who pay you cannot see your other
        payments or your balance. Get a new one each time someone sends to you.
      </div>
      <div>
        <Label>Who is it for? (optional, only your vault sees it)</Label>
        <Input value={label} maxLength={80} onChange={e => setLabel(e.target.value)} placeholder="e.g. Paycheck, Mom's gift" />
      </div>
      <Button disabled={busy} style={{ minHeight: 44 }} onClick={() => void issue()}>
        {busy ? 'Getting a new address...' : 'New receive address'}
      </Button>
      {err && <div style={{ fontSize: 15, color: colors.red, lineHeight: 1.5 }}>{err}</div>}
      {issued && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <div style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.text, wordBreak: 'break-all' }}>{issued.address}</div>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 16, minHeight: 44 }}
            onClick={() => { void navigator.clipboard.writeText(issued.address).then(() => setCopied(true)); }}
          >
            {copied ? 'Copied!' : 'Copy this address'}
          </Button>
          <QrImage data={issued.address} size={220} />
          <div style={{ fontSize: 15, color: colors.sub, lineHeight: 1.5 }}>
            Address number {issued.index}, never used before. Check that the wallet you send from shows an address
            ending in <span style={{ fontFamily: fonts.mono }}>{issued.address.slice(-8)}</span>.
          </div>
        </div>
      )}
    </div>
  );
}
