import { useState } from 'react';
import { importXpub, listKeys, parseXpubText, type LocalKey } from '../lib/keystore';
import { colors, fonts, space } from '../theme';
import { Button, Input, Label, Textarea } from './ui';
import { XpubQrScanner } from './XpubQrScanner';
import { networkProblem, type VaultNetwork } from '../lib/key-network';

// Bring a hardware wallet's key in right where it is needed, by scanning
// its QR or pasting its export (operator, 2026-11-13, on the join page:
// "Need better way to bring in your own key. The qr flow and such").
// Before this, joining with a hardware wallet meant leaving for the Keys
// page, importing there, and opening the invite link again.
//
// Only the PUBLIC half ever reaches this browser. The key is saved the
// same way the Keys page's Import xpub saves it (keystore.importXpub), so
// it is listed with the person's other keys afterwards.
//
// No guessing: a scan or paste that carries the fingerprint and path (a
// SeedSigner static key QR does: [fingerprint/path]tpub...) fills both;
// a bare key leaves them for the person to type from their device,
// because a wrong path is how a hardware wallet ends up unable to sign.

export function HardwareKeyImport({
  network,
  onAdded,
}: {
  network: VaultNetwork;
  /** The key, saved on this device and ready to use. */
  onAdded: (key: LocalKey) => void;
}) {
  const [mode, setMode] = useState<'closed' | 'scan' | 'form'>('closed');
  const [raw, setRaw] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [path, setPath] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const keystoreNetwork = network === 'bitcoin' ? 'mainnet' : network;
  const examplePath = network === 'bitcoin' ? "m/48'/0'/0'/2'" : "m/48'/1'/0'/2'";
  const sub: React.CSSProperties = { fontSize: 15, color: colors.sub, lineHeight: 1.6, margin: 0 };

  // Fill the form from a scan or a paste, taking only what is really there.
  function fill(text: string) {
    setErr(null);
    const parsed = parseXpubText(text);
    if (!parsed) {
      setRaw(text);
      return;
    }
    setRaw(parsed.xpub);
    if (parsed.fingerprint) setFingerprint(parsed.fingerprint);
    if (parsed.path) setPath(parsed.path);
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const parsed = parseXpubText(raw);
    const xpub = parsed?.xpub ?? raw.trim();
    const fp = (fingerprint.trim() || parsed?.fingerprint || '').toLowerCase();
    const derivationPath = (path.trim() || parsed?.path || '').trim();
    if (!/^[a-zA-Z]pub[1-9A-HJ-NP-Za-km-z]{100,115}$/.test(xpub)) {
      setErr('That is not a readable public key. Scan the wallet\'s key QR again, or paste its full export.');
      return;
    }
    const wrongNet = networkProblem(xpub, network);
    if (wrongNet) { setErr(wrongNet); return; }
    if (!/^[0-9a-f]{8}$/.test(fp)) {
      setErr('Type the wallet\'s fingerprint: 8 characters, 0-9 and a-f. The wallet shows it on its key export screen.');
      return;
    }
    if (!/^m(\/\d{1,10}'?){1,10}$/.test(derivationPath)) {
      setErr(`Type the derivation path the wallet shows for this key, for example ${examplePath}.`);
      return;
    }
    try {
      // The same key brought in twice is the same key: reuse it.
      const already = listKeys().find(k => k.status === 'active' && k.origin === 'imported_xpub'
        && (k.masterFingerprint ?? '') === fp && k.derivationPath === derivationPath && k.network === keystoreNetwork);
      const key = already ?? importXpub({
        label: `Hardware wallet ${fp}`,
        persona: `Hardware wallet ${fp}`,
        network: keystoreNetwork,
        xpub,
        derivationPath,
        masterFingerprint: fp,
      });
      if (!key.pubkey || key.pubkey.length !== 66) {
        setErr('This key could not be read. Export it from the wallet again.');
        return;
      }
      setMode('closed');
      setRaw(''); setFingerprint(''); setPath('');
      onAdded(key);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add this key');
    }
  }

  if (mode === 'scan') {
    return (
      <XpubQrScanner
        onResult={(xpub, scannedPath, scannedFingerprint) => {
          setRaw(xpub);
          if (scannedFingerprint) setFingerprint(scannedFingerprint);
          if (scannedPath) setPath(scannedPath);
          setMode('form');
        }}
        onCancel={() => setMode('closed')}
      />
    );
  }

  if (mode === 'closed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
        <p style={sub}>Using a hardware wallet such as a SeedSigner? Bring in its key here.</p>
        <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
          <Button style={{ minHeight: 44 }} onClick={() => { setErr(null); setMode('scan'); }}>Scan its key QR</Button>
          <Button variant="ghost" style={{ minHeight: 44 }} onClick={() => { setErr(null); setMode('form'); }}>Paste it</Button>
        </div>
        <p style={{ ...sub, fontSize: 14 }}>
          On a SeedSigner: open the seed, tap Export xpub, then Multisig and Native Segwit. Either QR format
          works, Animated (default) or Static; hold the phone steady until the animated one finishes.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
      <div>
        <Label>The wallet's key</Label>
        <Textarea
          mono
          rows={4}
          value={raw}
          onChange={e => fill(e.target.value)}
          placeholder={`[fingerprint${examplePath.slice(1)}]${network === 'bitcoin' ? 'xpub' : 'tpub'}...`}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          style={{ fontFamily: fonts.mono, wordBreak: 'break-all' }}
        />
      </div>
      <div>
        <Label>Fingerprint</Label>
        <Input mono value={fingerprint} onChange={e => setFingerprint(e.target.value)} placeholder="8 characters, e.g. 73c5da0a" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </div>
      <div>
        <Label>Derivation path</Label>
        <Input mono value={path} onChange={e => setPath(e.target.value)} placeholder={examplePath} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </div>
      <p style={{ ...sub, fontSize: 14 }}>
        Read the fingerprint and path from the wallet's own screen. A scan of its key QR fills both in.
      </p>
      {err && <p style={{ ...sub, color: colors.red }}>{err}</p>}
      <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
        <Button type="button" variant="ghost" style={{ minHeight: 44 }} onClick={() => { setErr(null); setMode('closed'); }}>Cancel</Button>
        <Button type="button" variant="ghost" style={{ minHeight: 44 }} onClick={() => { setErr(null); setMode('scan'); }}>Scan instead</Button>
        <Button type="submit" style={{ minHeight: 44, flex: 1 }}>Use this key</Button>
      </div>
    </form>
  );
}
