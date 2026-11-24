import { useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import {
  clearElectrumServer, getElectrumServer, setElectrumServer, type ElectrumNetwork,
} from '../lib/electrumPrefs';
import { colors, radii, fonts } from '../theme';
import { Button, Input } from './ui';

/**
 * "Where your coins are looked up" -- under the coins card
 * (docs/chain-lookups-build-note.md). Collapsed by default. Lets a person
 * point this device's coin lookups for one network at their own Electrum
 * server: type host and port, check it, read the certificate fingerprint,
 * confirm. Saved on this device only (lib/electrumPrefs.ts).
 */
export function ElectrumServerSettings({
  network,
  source,
  onChanged,
}: {
  network: ElectrumNetwork;
  /** Who answered the last lookup, as the server reported it. */
  source?: string;
  onChanged: () => void;
}) {
  const saved = getElectrumServer(network);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(saved?.host ?? '');
  const [port, setPort] = useState(saved ? String(saved.port) : '50002');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [found, setFound] = useState<{ host: string; port: number; fingerprint: string; software: string | null; tip: number | null } | null>(null);

  async function check() {
    setErr(null);
    setFound(null);
    const p = Number(port);
    if (!host.trim() || !Number.isInteger(p)) { setErr('Enter the server name and its port.'); return; }
    setBusy(true);
    try {
      const r = await api.electrumCheck({ network, host: host.trim(), port: p });
      setFound(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reach that server.');
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    if (!found) return;
    setElectrumServer(network, { host: found.host, port: found.port, pin: found.fingerprint });
    setFound(null);
    onChanged();
  }

  function stopUsing() {
    clearElectrumServer(network);
    setHost('');
    setFound(null);
    onChanged();
  }

  const note: CSSProperties = { fontSize: 15, color: colors.muted, margin: '0 0 8px', lineHeight: 1.5 };

  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{ background: 'none', border: 'none', padding: '10px 0', minHeight: 44, fontSize: 15, color: colors.muted, cursor: 'pointer', textDecoration: 'underline', textAlign: 'left' }}
      >
        {open ? 'Hide' : `Coins looked up by: ${saved ? `your server (${saved.host})` : source ?? 'the default'}`}
      </button>
      {open && (
        <div style={{ marginTop: 4, padding: '10px 12px', background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: radii.md }}>
          <p style={note}>
            Every coin lookup for this vault asks a server which coins sit on its addresses. That server learns
            which addresses belong together. If you run your own Electrum server (Umbrel, Start9, a node at home),
            put it here and only it will be asked for {network} vaults on this device. It is saved on this
            device only.
          </p>
          <p style={note}>
            It has to be reachable from the internet over TLS: our server makes the connection, so a node only
            reachable inside your home network, or only over Tor, will not work from here. Our server still
            sees which addresses it asks about.
          </p>
          {saved && !found && (
            <p style={{ ...note, color: colors.text }}>
              In use: {saved.host}:{saved.port}, certificate {saved.pin.slice(0, 23)}...
            </p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Input mono value={host} onChange={e => setHost(e.target.value)} placeholder="node.example.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ flex: 3, fontSize: 16 }} />
            <Input mono value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="50002" style={{ flex: 1, fontSize: 16 }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Button size="sm" style={{ fontSize: 15, minHeight: 44 }} onClick={check} disabled={busy}>
              {busy ? 'Checking...' : 'Check server'}
            </Button>
            {saved && (
              <Button variant="ghost" size="sm" style={{ fontSize: 15, minHeight: 44 }} onClick={stopUsing}>
                Stop using my server
              </Button>
            )}
          </div>
          {found && (
            <div style={{ marginTop: 10 }}>
              <p style={{ ...note, color: colors.text }}>
                {found.host}:{found.port} answered{found.software ? ` (${found.software})` : ''}, on {network}
                {found.tip != null ? ` at block ${found.tip.toLocaleString()}` : ''}. Its certificate fingerprint is:
              </p>
              <p style={{ fontFamily: fonts.mono, fontSize: 14, wordBreak: 'break-all', margin: '0 0 8px', color: colors.text }}>
                {found.fingerprint}
              </p>
              <p style={note}>
                If this is your node, its own settings show the same fingerprint. Once you confirm it, any other
                certificate is refused, so nobody can pose as your node later and show a wrong balance.
              </p>
              <Button size="sm" style={{ fontSize: 15, minHeight: 44 }} onClick={confirm}>
                This is my server -- use it
              </Button>
            </div>
          )}
          {err && <p style={{ fontSize: 15, color: colors.red, marginTop: 8 }}>{err}</p>}
        </div>
      )}
    </div>
  );
}
