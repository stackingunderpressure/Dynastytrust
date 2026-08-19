import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { listAllKeys, revealMnemonic, type LocalKey } from '../lib/keystore';
import {
  legacyIdentityPubkeyFromXpub,
  detectXpubNetwork,
  legacyUnlockMessage,
  signLegacyUnlockMessage,
  verifyLegacyUnlockSignature,
  deriveLegacyLockBytesFromSignature,
  recoverViaFastPath,
  unsealBundle,
  unb64,
  parseUnlockSignature,
} from '../lib/legacy-recovery';
import { p2wpkhAddressForPubkey } from '../lib/onchain-publish';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

// The hardware-wallet-compatible sibling of LegacyRecoverySetup.tsx (see
// legacy-recovery.ts's header on signature-locked shares). That page
// requires knowing which vault a key belongs to and walks the OWNER
// through sealing; this page answers a colder-start question a
// SURVIVING KEYHOLDER might actually face decades from now: "I have
// this key's xpub -- is there anything hidden for it, anywhere?" -- and
// unlocks it by proving key ownership with a SIGNATURE, never a raw
// private key or mnemonic. Any device that can sign an arbitrary message
// with the identity child key (a real hardware wallet, eventually) can
// complete this flow; a local software key is used below only because
// it is the only signer this browser can currently produce on demand --
// the unlock logic itself never looks at the mnemonic, only at the
// signature bytes it produces.

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

interface LookupResult {
  vaultId: string;
  vaultName: string | null;
  keyRole: string;
  lockedFastShareSigB64: string;
  onchainShareB64: string | null;
  sealedBundle: { nonce_b64: string; ciphertext_b64: string };
  identityPubkey: Uint8Array;
  identityAddress: string;
}

export default function DescriptorRetrieval() {
  const toast = useToast();
  const localKeys = useMemo(() => listAllKeys(), []);

  const [xpubInput, setXpubInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [signatureHex, setSignatureHex] = useState('');
  const [signingLocally, setSigningLocally] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [recoveredBundle, setRecoveredBundle] = useState<string | null>(null);

  // Only useful as a convenience for testing this mechanism today --
  // real recovery decades from now won't have this browser's
  // localStorage. See the module header.
  const matchingLocalKey: LocalKey | undefined = localKeys.find(
    k => k.xpub && k.xpub === xpubInput.trim(),
  );

  async function handleCheck() {
    const xpub = xpubInput.trim();
    if (!xpub) return;
    setChecking(true);
    setResult(null);
    setNotFound(false);
    setRecoveredBundle(null);
    setSignatureHex('');
    try {
      const identityPubkey = legacyIdentityPubkeyFromXpub(xpub);
      const network = detectXpubNetwork(xpub);
      const identityAddress = p2wpkhAddressForPubkey(toHex(identityPubkey), network === 'mainnet' ? 'bitcoin' : 'testnet');
      const res = await api.legacy.lookup(toHex(identityPubkey));
      setResult({
        vaultId: res.vault_id,
        vaultName: res.vault_name,
        keyRole: res.key_role,
        lockedFastShareSigB64: res.locked_fast_share_sig_b64,
        onchainShareB64: res.onchain_share_b64,
        sealedBundle: res.sealed_bundle,
        identityPubkey,
        identityAddress,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Lookup failed';
      if (msg.includes('404') || msg.toLowerCase().includes('no sealed')) {
        setNotFound(true);
      } else {
        toast.error(msg);
      }
    } finally {
      setChecking(false);
    }
  }

  async function handleSignLocally() {
    if (!result || !matchingLocalKey) return;
    setSigningLocally(true);
    try {
      const mnemonic = await revealMnemonic(matchingLocalKey.keyId);
      const signature = signLegacyUnlockMessage(
        mnemonic, matchingLocalKey.network, matchingLocalKey.derivationPath, result.vaultId, result.keyRole,
      );
      setSignatureHex(toHex(signature));
      toast.success('Signed. Review the signature below, then unlock.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Signing failed -- this key may need a password (use a hardware wallet or paste a signature instead).');
    } finally {
      setSigningLocally(false);
    }
  }

  async function handleUnlock() {
    if (!result) return;
    if (!result.onchainShareB64) {
      toast.error("This vault's on-chain share hasn't been published yet -- ask the vault owner to publish it, or recover through a second keyholder's key instead.");
      return;
    }
    setUnlocking(true);
    try {
      const signature = parseUnlockSignature(signatureHex);
      if (!verifyLegacyUnlockSignature(signature, result.identityPubkey, result.vaultId, result.keyRole)) {
        toast.error("That signature doesn't match this key. Make sure it signed the EXACT message above, at path .../1/0 under this same xpub's account, using the classic ECDSA message-signing method (not BIP-322 / Taproot signing).");
        return;
      }
      const lockBytes = deriveLegacyLockBytesFromSignature(signature, result.vaultId, result.keyRole);
      const secret = recoverViaFastPath(
        unb64(result.lockedFastShareSigB64), lockBytes, unb64(result.onchainShareB64),
      );
      const text = await unsealBundle(
        { version: 1, nonceB64: result.sealedBundle.nonce_b64, ciphertextB64: result.sealedBundle.ciphertext_b64 },
        secret,
      );
      setRecoveredBundle(text);
      toast.success('Unlocked. This is why the mechanism works with no shared secret except the key itself.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Unlock failed -- wrong signature, or this share was sealed under a different key.');
    } finally {
      setUnlocking(false);
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied.`);
    } catch {
      toast.error('Copy failed -- select and copy manually.');
    }
  }

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: space[3] }}>
      <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, lineHeight: 1.6 }}>
        Found a key years later and don't remember which vault it belongs to? Paste its xpub
        (the public key, never the mnemonic) below. If a vault ever sealed a recovery share for
        that exact key, this finds it -- and unlocks it with a signature, not the key itself, so
        it works the same way with a hardware wallet as with a key stored here.
      </p>

      <Card>
        <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
          Account xpub
        </label>
        <Textarea
          mono
          value={xpubInput}
          onChange={e => { setXpubInput(e.target.value); setResult(null); setNotFound(false); }}
          placeholder="xpub6... or tpub..."
          rows={2}
          style={{ marginBottom: 10 }}
        />
        <Button onClick={handleCheck} disabled={checking || !xpubInput.trim()}>
          {checking ? 'Checking...' : 'Check for a hidden share'}
        </Button>

        {notFound && (
          <div style={{ marginTop: 12, fontSize: 14, color: colors.sub }}>
            Nothing found for that key. Either no vault sealed a signature-based share for it, or
            the xpub doesn't match exactly -- double check it was copied in full.
          </div>
        )}
      </Card>

      {result && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.gold, marginBottom: 4 }}>
            Found it.
          </div>
          <p style={{ fontSize: 14, color: colors.sub, lineHeight: 1.6, marginBottom: 14 }}>
            This key is the <strong style={{ color: colors.text }}>{result.keyRole}</strong> on{' '}
            {result.vaultName ? <>the vault "<strong style={{ color: colors.text }}>{result.vaultName}</strong>"</> : 'a DynastyTrust vault'}.
            Prove you hold this key by signing the exact message below.
          </p>

          <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
            Message to sign
          </label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <Textarea mono readOnly value={legacyUnlockMessage(result.vaultId, result.keyRole)} rows={3} style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={() => copyText(legacyUnlockMessage(result.vaultId, result.keyRole), 'Message')}>
              Copy
            </Button>
          </div>

          <div
            style={{
              background: colors.input, border: `1px solid ${colors.border}`, borderRadius: radii.md,
              padding: '12px 14px', marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
              With a hardware wallet
            </div>
            <p style={{ fontSize: 13, color: colors.sub, lineHeight: 1.6, marginBottom: 10 }}>
              Use its "Sign Message" feature (Coldcard, Sparrow, Electrum, and most others support
              this) against derivation path{' '}
              <code style={{ fontFamily: fonts.mono, color: colors.text }}>&lt;this account&gt;/1/0</code>,
              which is the same account this xpub came from. Some wallets let you type that path
              directly (Sparrow's Tools &gt; Sign/Verify Message); others need the address instead:
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <Textarea mono readOnly value={result.identityAddress} rows={1} style={{ flex: 1 }} />
              <Button variant="ghost" size="sm" onClick={() => copyText(result.identityAddress, 'Address')}>
                Copy
              </Button>
            </div>
            <p style={{ fontSize: 13, color: colors.red, lineHeight: 1.6 }}>
              Important: use the CLASSIC message-signing method (plain ECDSA), not BIP-322 or a
              Taproot-address signature -- those use a different signature scheme that won't match
              what this was sealed with, even from the exact right key. If your wallet offers both,
              pick the older/classic one.
            </p>
          </div>

          {matchingLocalKey && (
            <div style={{ marginBottom: 14 }}>
              <Button variant="ghost" onClick={handleSignLocally} disabled={signingLocally}>
                {signingLocally ? 'Signing...' : `Sign now with "${matchingLocalKey.label}" (this browser)`}
              </Button>
            </div>
          )}

          <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
            Signature
          </label>
          <Textarea
            mono
            value={signatureHex}
            onChange={e => setSignatureHex(e.target.value)}
            placeholder="Paste the signature your wallet produced (base64 or hex), or sign locally above"
            rows={2}
            style={{ marginBottom: 12 }}
          />

          <Button onClick={handleUnlock} disabled={unlocking || !signatureHex.trim()}>
            {unlocking ? 'Unlocking...' : 'Unlock'}
          </Button>

          {!result.onchainShareB64 && (
            <div style={{ marginTop: 12, fontSize: 13, color: colors.sub }}>
              Heads up: this vault's on-chain share hasn't been published yet, so unlocking will
              fail even with a correct signature -- that piece is still needed to reconstruct the
              secret.
            </div>
          )}
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
        DynastyTrust is doing the lookup and the XOR/decrypt math here as a convenience -- nothing
        above needs this app specifically. A signature over a fixed message, an xpub, and a bit of
        published math is all this mechanism actually is; anyone with the sealed share and the
        on-chain pad could do the same recovery by hand.
      </div>
    </div>
  );
}
