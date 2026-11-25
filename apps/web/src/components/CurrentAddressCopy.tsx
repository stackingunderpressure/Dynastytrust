import { useState } from 'react';
import { api, type Vault } from '../lib/api';
import { colors, fonts } from '../theme';
import { Button } from './ui';
import { QrImage } from './QrImage';

// The vault page's "Copy address" for a vault with a new address every time
// (operator, 2026-11-25: "Copy address should pick the correct one and make
// it known each un used it's copying"). It used to copy the vault's FIRST
// address every time, even after it had been paid -- the reuse this vault
// shape exists to avoid. Now it asks which address to give out (the vault's
// own until it is paid, then the newest one not yet paid, then a new one;
// netlify/functions/vault-addresses.js), copies that, and says which.

type Got = { index: number; address: string; reused: boolean; first: boolean };

/** Copy text that is still being fetched. iPhone browsers refuse a copy
 *  that happens after an await unless the clipboard write starts inside
 *  the tap itself, so the fetch is handed to ClipboardItem as a promise. */
async function copyWhenReady(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(t => new Blob([t], { type: 'text/plain' })) })]);
      return;
    } catch {
      // fall through to the plain copy
    }
  }
  await navigator.clipboard.writeText(await text);
}

export function CurrentAddressCopy({ vault }: { vault: Vault }) {
  const [got, setGot] = useState<Got | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState(false);

  const fetchCurrent = () => api.vaults.newReceiveAddress(vault.id).then(r => {
    const g = { index: r.index, address: r.address, reused: !!r.reused, first: !!(r as { first?: boolean }).first };
    setGot(g);
    return g;
  });

  async function copyIt() {
    setBusy(true); setErr(null); setCopied(false);
    try {
      await copyWhenReady(fetchCurrent().then(g => g.address));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not copy');
    } finally {
      setBusy(false);
    }
  }

  async function showQr() {
    if (qr) { setQr(false); return; }
    setBusy(true); setErr(null);
    try {
      if (!got) await fetchCurrent();
      setQr(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not get the address');
    } finally {
      setBusy(false);
    }
  }

  const which = got
    ? got.first ? "the vault's first address, never paid yet"
      : got.reused ? 'given out before and not paid yet'
      : 'never used before'
    : '';

  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 16, minHeight: 44 }} disabled={busy} onClick={() => void copyIt()}>
          {busy ? 'Getting the address...' : copied ? 'Copied!' : 'Copy receive address'}
        </Button>
        <Button variant="ghost" size="sm" style={{ fontSize: 16, minHeight: 44 }} disabled={busy} onClick={() => void showQr()}>
          {qr ? 'Hide deposit QR' : 'Show deposit QR'}
        </Button>
      </div>
      {err && <div style={{ fontSize: 15, color: colors.red, lineHeight: 1.5 }}>{err}</div>}
      {got && (copied || qr) && (
        <div style={{ fontSize: 16, color: colors.sub, lineHeight: 1.5 }}>
          {copied ? 'Copied ' : 'Showing '}address number {got.index}, {which}. Check that the wallet you send from shows an
          address ending in <span style={{ fontFamily: fonts.mono, color: colors.text }}>{got.address.slice(-8)}</span>.
          It stays the one to give out until money arrives on it.
        </div>
      )}
      {qr && got && <QrImage data={got.address} size={220} />}
    </div>
  );
}
