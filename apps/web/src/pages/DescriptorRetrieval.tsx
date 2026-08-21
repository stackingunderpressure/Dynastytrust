import { useMemo, useState } from 'react';
import { listAllKeys, revealMnemonic } from '../lib/keystore';
import {
  legacyOnChainUnlockMessage,
  signLegacyOnChainUnlock,
  recoverViaOnChainPath,
  parseUnlockSignature,
} from '../lib/legacy-recovery';
import { fetchLegacyOnChainCandidates, legacyOnChainLookupAddress, type OnChainCandidate } from '../lib/legacy-onchain-recovery';
import { type PublishNetwork } from '../lib/onchain-publish';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Legacy Recovery, "sign to recover" (see legacy-onchain-recovery.ts's
// header for the full mechanism): no vault ID, no DynastyTrust database
// lookup at all -- the Bitcoin blockchain is the only place this ever
// lived. A keyholder needs the address this key published to (from
// their own recovery note, or re-derived here from a local key) plus a
// signature over one fixed message, and that's the whole recovery -- no
// second key, no share to combine with anyone else.

export default function DescriptorRetrieval() {
  const toast = useToast();
  const localKeys = useMemo(() => listAllKeys(), []);

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied.`);
    } catch {
      toast.error('Copy failed -- select and copy manually.');
    }
  }

  const [network, setNetwork] = useState<PublishNetwork>('testnet');
  const [vaultIndex, setVaultIndex] = useState('0');
  const [address, setAddress] = useState('');
  const [checking, setChecking] = useState(false);
  const [candidate, setCandidate] = useState<OnChainCandidate | null>(null);
  const [checked, setChecked] = useState(false);

  const [localKeyId, setLocalKeyId] = useState('');
  const [localPassword, setLocalPassword] = useState('');
  const [deriving, setDeriving] = useState(false);

  const [signatureInput, setSignatureInput] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [recoveredBundle, setRecoveredBundle] = useState<string | null>(null);

  const localKey = localKeys.find(k => k.keyId === localKeyId) ?? null;
  const localNeedsPassword = !!localKey && !localKey.testMnemonic && !!localKey.encryptedMnemonic;
  const parsedIndex = parseInt(vaultIndex, 10);
  const indexValid = Number.isInteger(parsedIndex) && parsedIndex >= 0;

  async function handleDeriveLocally() {
    if (!localKey || !indexValid) return;
    setDeriving(true);
    try {
      const keyNetwork = localKey.network;
      const mnemonic = await revealMnemonic(localKey.keyId, localNeedsPassword ? localPassword : undefined);
      const addr = legacyOnChainLookupAddress(mnemonic, keyNetwork, parsedIndex);
      const signature = signLegacyOnChainUnlock(mnemonic, keyNetwork, parsedIndex);
      setAddress(addr);
      setSignatureInput(toHex(signature));
      setNetwork(keyNetwork === 'mainnet' ? 'bitcoin' : keyNetwork);
      setCandidate(null);
      setChecked(false);
      toast.success('Address and signature derived from this key. Check the chain next.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not derive from that key.');
    } finally {
      setDeriving(false);
    }
  }

  async function handleCheck() {
    if (!address.trim() || !indexValid) return;
    setChecking(true);
    setCandidate(null);
    setChecked(false);
    setRecoveredBundle(null);
    try {
      const candidates = await fetchLegacyOnChainCandidates(address.trim(), network);
      setCandidate(candidates.length > 0 ? candidates[candidates.length - 1] : null);
      setChecked(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Chain lookup failed');
    } finally {
      setChecking(false);
    }
  }

  async function handleUnlock() {
    if (!candidate || !indexValid) return;
    setUnlocking(true);
    try {
      const signature = parseUnlockSignature(signatureInput);
      const text = await recoverViaOnChainPath(signature, parsedIndex, candidate.sealed);
      setRecoveredBundle(text);
      toast.success('Unlocked. This one key, alone, was everything this recovery needed.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Unlock failed -- wrong signature, wrong vault index, or this address published for a different key.');
    } finally {
      setUnlocking(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: space[3] }}>
      <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, lineHeight: 1.6 }}>
        No vault ID, no DynastyTrust account, no database lookup -- this key's own on-chain address
        IS the lookup. If you have the address from your recovery note (or this key is in this
        browser), enter it below with the vault index, check the chain, then sign the message shown
        to unlock. One key, alone, recovers the full descriptor -- nothing to combine with anyone
        else.
      </p>

      <Card>
        <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
          Network
        </label>
        <select
          value={network}
          onChange={e => { setNetwork(e.target.value as PublishNetwork); setCandidate(null); setChecked(false); }}
          style={{
            width: '100%', padding: '10px 12px', background: colors.input,
            border: `1px solid ${colors.border}`, borderRadius: radii.md,
            color: colors.text, fontSize: 16, fontFamily: fonts.sans, marginBottom: 10,
          }}
        >
          <option value="bitcoin">Mainnet</option>
          <option value="testnet">Testnet</option>
          <option value="signet">Signet</option>
        </select>

        <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
          Vault index (from your recovery note)
        </label>
        <input
          value={vaultIndex}
          onChange={e => { setVaultIndex(e.target.value.replace(/[^0-9]/g, '')); setCandidate(null); setChecked(false); }}
          style={{
            width: 100, padding: '10px 12px', background: colors.input,
            border: `1px solid ${colors.border}`, borderRadius: radii.md,
            color: colors.text, fontSize: 14, fontFamily: fonts.mono, marginBottom: 10,
          }}
        />

        <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
          Address (from your recovery note)
        </label>
        <Textarea
          mono
          value={address}
          onChange={e => { setAddress(e.target.value); setCandidate(null); setChecked(false); }}
          placeholder="bc1... / tb1..."
          rows={1}
          style={{ marginBottom: 10 }}
        />

        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 6 }}>
          Don't have the note, but this key is in this browser?
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            value={localKeyId}
            onChange={e => setLocalKeyId(e.target.value)}
            style={{
              flex: 1, minWidth: 180, padding: '10px 12px', background: colors.input,
              border: `1px solid ${colors.border}`, borderRadius: radii.md,
              color: colors.text, fontSize: 16, fontFamily: fonts.sans,
            }}
          >
            <option value="">Choose a local key...</option>
            {localKeys.map(k => <option key={k.keyId} value={k.keyId}>{k.label}</option>)}
          </select>
          {localNeedsPassword && (
            <input
              type="password"
              placeholder="Password"
              value={localPassword}
              onChange={e => setLocalPassword(e.target.value)}
              style={{
                padding: '10px 12px', background: colors.input,
                border: `1px solid ${colors.border}`, borderRadius: radii.md,
                color: colors.text, fontSize: 16, fontFamily: fonts.sans, width: 160,
              }}
            />
          )}
          <Button
            variant="ghost" size="sm" onClick={handleDeriveLocally}
            disabled={!localKey || !indexValid || deriving || (localNeedsPassword && !localPassword)}
          >
            {deriving ? 'Deriving...' : 'Derive address & sign'}
          </Button>
        </div>

        <Button onClick={handleCheck} disabled={checking || !address.trim() || !indexValid}>
          {checking ? 'Checking...' : 'Check the chain'}
        </Button>

        {checked && !candidate && (
          <div style={{ marginTop: 12, fontSize: 14, color: colors.sub }}>
            Nothing published at that address for this vault index yet. Double-check the address
            and index came from the same recovery note, and that you picked the right network.
          </div>
        )}
      </Card>

      {candidate && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.gold, marginBottom: 4 }}>
            Found it.
          </div>
          <p style={{ fontSize: 14, color: colors.sub, lineHeight: 1.6, marginBottom: 14 }}>
            Prove you hold this key by signing the exact message below, at derivation path{' '}
            <code style={{ fontFamily: fonts.mono, color: colors.text }}>
              m/9999&apos;/{network === 'bitcoin' ? '0' : '1'}&apos;/{parsedIndex}&apos;/1&apos;
            </code>.
          </p>

          <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
            Message to sign
          </label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <Textarea mono readOnly value={legacyOnChainUnlockMessage(parsedIndex)} rows={2} style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={() => copyText(legacyOnChainUnlockMessage(parsedIndex), 'Message')}>
              Copy
            </Button>
          </div>

          <p style={{ fontSize: 13, color: colors.red, lineHeight: 1.6, marginBottom: 14 }}>
            Use the CLASSIC message-signing method (plain ECDSA), not BIP-322 or a Taproot-address
            signature -- most hardware wallets' "Sign Message" feature against a custom
            derivation path does this natively.
          </p>

          <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
            Signature
          </label>
          <Textarea
            mono
            value={signatureInput}
            onChange={e => setSignatureInput(e.target.value)}
            placeholder="Paste the signature your wallet produced (base64 or hex), or derive locally above"
            rows={2}
            style={{ marginBottom: 12 }}
          />

          <Button onClick={handleUnlock} disabled={unlocking || !signatureInput.trim()}>
            {unlocking ? 'Unlocking...' : 'Unlock'}
          </Button>
        </Card>
      )}

      {recoveredBundle && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.gold, marginBottom: 8 }}>
            Recovered descriptor bundle
          </div>
          <Textarea mono readOnly value={recoveredBundle} rows={14} style={{ marginBottom: 10 }} />
          <Button variant="ghost" size="sm" onClick={() => copyText(recoveredBundle, 'Bundle')}>
            Copy
          </Button>
        </Card>
      )}

      <div
        style={{
          background: colors.input, border: `1px solid ${colors.gold}33`, borderRadius: radii.md,
          padding: '14px 18px', fontSize: 13, color: colors.sub, lineHeight: 1.6,
        }}
      >
        DynastyTrust is doing the chain lookup and the decrypt here as a convenience -- nothing on
        this page needs this app specifically. A signature over a fixed message plus the data
        already sitting on the Bitcoin blockchain is all this mechanism actually is; anyone with
        the address and the signature could do the same recovery by hand.
      </div>
    </div>
  );
}
