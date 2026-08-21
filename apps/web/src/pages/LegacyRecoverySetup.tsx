import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Vault } from '../lib/api';
import { listKeys, revealMnemonic, type LocalKey } from '../lib/keystore';
import { sealVaultLegacyRecovery, vaultNetworkToKeystoreNetwork } from '../lib/legacy-seal';
import { unb64, descriptorFingerprint } from '../lib/legacy-recovery';
import { vaultBackupText, downloadLegacyRecoveryPackage } from '../lib/descriptor-backup';
import { p2wpkhAddressForPubkey, buildAndSignPublishTx, type BuiltPublishTx } from '../lib/onchain-publish';
import {
  legacyOnChainLookupAddress,
  sealAndBuildOnChainPublishTx,
  fetchLegacyOnChainCandidates,
  toPublishNetwork,
  type OnChainCandidate,
} from '../lib/legacy-onchain-recovery';
import { explorerTxUrl, broadcastTxUrl, EXPLORER } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card } from '../components/ui';
import { useToast } from '../components/toast';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Long-horizon descriptor recovery ("Legacy Recovery" -- see
// apps/web/src/lib/legacy-recovery.ts's header for the full mechanism).
// This page is the deliberate, explicit ceremony: the owner assigns one
// LOCAL key to each of the vault's real roles, confirms each key's
// mnemonic (prompting for a password on secure-mode keys), and seals.
// Nothing here is automatic or silent -- every key used is a choice the
// owner makes and can see, matching "no naked footgun is ever a
// one-click choice, consequences shown before commitment."

interface RoleSlot {
  role: string;      // e.g. "founder_1"
  label: string;      // e.g. "Founder 1"
}

type LegacyShare = Awaited<ReturnType<typeof api.legacy.get>>['shares'][number];

function rolesForVault(vault: Vault): RoleSlot[] {
  const slots: RoleSlot[] = [];
  vault.founder_keys.forEach((_, i) => slots.push({ role: `founder_${i + 1}`, label: `Founder ${i + 1}` }));
  (vault.backup_keys ?? []).forEach((_, i) => slots.push({ role: `backup_${i + 1}`, label: `Backup ${i + 1}` }));
  vault.heir_keys.forEach((_, i) => slots.push({ role: `heir_${i + 1}`, label: `Heir ${i + 1}` }));
  (vault.second_heir_keys ?? []).forEach((_, i) => slots.push({ role: `second_heir_${i + 1}`, label: `Second heir ${i + 1}` }));
  return slots;
}

// Legacy Recovery v2: no separate share, no combining, no database at all --
// this key alone, once its own piece is on-chain, recovers the WHOLE bundle.
// Each role gets its own card because each keyholder derives their own
// address (a fully hardened path -- see legacy-recovery.ts's
// legacyOnChainDerivationPath -- so it can only ever be computed from that
// person's real seed, never from this vault's xpubs or descriptor, and
// nobody can link one keyholder's address to another's or to this vault).
// State here is deliberately local to the card, not lifted to the page --
// the password is kept only long enough to derive what's needed and is
// never cached across cards, matching the mnemonic-never-persisted
// convention the v1 publish flow above already follows.
function LegacyOnChainV2Card({ vault, role, defaultVaultIndex, localKeys, toast }: {
  vault: Vault;
  role: RoleSlot;
  defaultVaultIndex: number;
  localKeys: LocalKey[];
  toast: ReturnType<typeof useToast>;
}) {
  const [keyId, setKeyId] = useState('');
  const [password, setPassword] = useState('');
  const [vaultIndex, setVaultIndex] = useState(String(defaultVaultIndex));
  const [checking, setChecking] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<OnChainCandidate | null>(null);
  const [fetchingUtxos, setFetchingUtxos] = useState(false);
  const [fetchedUtxos, setFetchedUtxos] = useState<Array<{ txid: string; vout: number; value: number }> | null>(null);
  const [utxoTxid, setUtxoTxid] = useState('');
  const [utxoVout, setUtxoVout] = useState('0');
  const [utxoValue, setUtxoValue] = useState('');
  const [feeRate, setFeeRate] = useState('2');
  const [building, setBuilding] = useState(false);
  const [builtTx, setBuiltTx] = useState<BuiltPublishTx | null>(null);
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastTxid, setBroadcastTxid] = useState<string | null>(null);

  const key = localKeys.find(k => k.keyId === keyId) ?? null;
  const needsPassword = !!key && !key.testMnemonic && !!key.encryptedMnemonic;
  const parsedIndex = parseInt(vaultIndex, 10);
  const indexValid = Number.isInteger(parsedIndex) && parsedIndex >= 0;

  async function handleCheckAddress() {
    if (!key || !indexValid) return;
    setChecking(true);
    setCandidate(null);
    try {
      const network = vaultNetworkToKeystoreNetwork(vault.network);
      const mnemonic = await revealMnemonic(key.keyId, needsPassword ? password : undefined);
      const addr = legacyOnChainLookupAddress(mnemonic, network, parsedIndex);
      setAddress(addr);
      setFetchedUtxos(null);
      setBuiltTx(null);
      setBroadcastTxid(null);
      const candidates = await fetchLegacyOnChainCandidates(addr, toPublishNetwork(network));
      setCandidate(candidates.length > 0 ? candidates[candidates.length - 1] : null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not derive or check that address');
    } finally {
      setChecking(false);
    }
  }

  async function fetchUtxosForAddress() {
    if (!address) return;
    setFetchingUtxos(true);
    setFetchedUtxos(null);
    try {
      const res = await fetch(`${EXPLORER[vault.network].api}/address/${address}/utxo`);
      if (!res.ok) throw new Error('mempool.space lookup failed');
      const utxos = (await res.json()) as Array<{ txid: string; vout: number; value: number }>;
      setFetchedUtxos(utxos);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Lookup failed');
    } finally {
      setFetchingUtxos(false);
    }
  }

  function selectFetchedUtxo(u: { txid: string; vout: number; value: number }) {
    setUtxoTxid(u.txid);
    setUtxoVout(String(u.vout));
    setUtxoValue(String(u.value));
    setBuiltTx(null);
  }

  async function handleBuildPublishTx() {
    if (!key || !indexValid) return;
    const valueSats = parseInt(utxoValue, 10);
    const vout = parseInt(utxoVout, 10);
    const rate = parseFloat(feeRate);
    if (!/^[0-9a-fA-F]{64}$/.test(utxoTxid.trim())) { toast.error('UTXO txid should be 64 hex characters.'); return; }
    if (!Number.isFinite(vout) || vout < 0) { toast.error('Invalid vout.'); return; }
    if (!Number.isFinite(valueSats) || valueSats <= 0) { toast.error('Invalid UTXO value (sats).'); return; }
    if (!Number.isFinite(rate) || rate <= 0) { toast.error('Invalid fee rate.'); return; }
    setBuilding(true);
    try {
      const network = vaultNetworkToKeystoreNetwork(vault.network);
      const mnemonic = await revealMnemonic(key.keyId, needsPassword ? password : undefined);
      const { built } = await sealAndBuildOnChainPublishTx({
        bundleText: vaultBackupText(vault),
        mnemonic,
        network,
        vaultIndex: parsedIndex,
        utxo: { txid: utxoTxid.trim(), vout, valueSats },
        feeRateSatsPerVb: rate,
      });
      setBuiltTx(built);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build transaction');
    } finally {
      setBuilding(false);
    }
  }

  async function handleBroadcastPublishTx() {
    if (!builtTx) return;
    setBroadcasting(true);
    try {
      const res = await fetch(broadcastTxUrl(vault.network), {
        method: 'POST',
        body: builtTx.hex,
        headers: { 'Content-Type': 'text/plain' },
      });
      const txid = (await res.text()).trim();
      if (!res.ok || txid.length !== 64) throw new Error('Broadcast failed: ' + txid.slice(0, 200));
      setBroadcastTxid(txid);
      toast.success('Published. This key alone can now recover the full descriptor, decades from now.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Broadcast failed');
    } finally {
      setBroadcasting(false);
    }
  }

  return (
    <Card>
      <div style={{ fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: 8 }}>{role.label}</div>
      <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>Local key</label>
      <select
        value={keyId}
        onChange={e => { setKeyId(e.target.value); setAddress(null); setCandidate(null); setBuiltTx(null); setBroadcastTxid(null); }}
        style={{
          width: '100%', padding: '10px 12px', background: colors.input,
          border: `1px solid ${colors.border}`, borderRadius: radii.md,
          color: colors.text, fontSize: 16, fontFamily: fonts.sans, marginBottom: 10,
        }}
      >
        <option value="">Choose a local key...</option>
        {localKeys.map(k => <option key={k.keyId} value={k.keyId}>{k.label}</option>)}
      </select>

      {key && (
        <>
          <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
            Vault index -- a small number unique to this person if they hold a key in more than one
            DynastyTrust vault (0 for their first, 1 for their second, and so on). Nothing to write
            down for this alone -- recovery just tries 0, 1, 2... until it finds the right address.
          </label>
          <input
            value={vaultIndex}
            onChange={e => { setVaultIndex(e.target.value.replace(/[^0-9]/g, '')); setAddress(null); setCandidate(null); }}
            style={{
              width: 100, padding: '10px 12px', background: colors.input,
              border: `1px solid ${colors.border}`, borderRadius: radii.md,
              color: colors.text, fontSize: 14, fontFamily: fonts.mono, marginBottom: 10,
            }}
          />

          {needsPassword && (
            <input
              type="password"
              placeholder="Password for this key"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={{
                width: '100%', padding: '10px 12px', background: colors.input,
                border: `1px solid ${colors.border}`, borderRadius: radii.md,
                color: colors.text, fontSize: 16, fontFamily: fonts.sans,
                boxSizing: 'border-box', marginBottom: 10,
              }}
            />
          )}

          <Button
            variant="ghost" size="sm" onClick={handleCheckAddress}
            disabled={checking || !indexValid || (needsPassword && !password)}
            style={{ marginBottom: 10 }}
          >
            {checking ? 'Deriving...' : 'Derive address and check the chain'}
          </Button>

          {address && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                This key's on-chain lookup address for index {parsedIndex}:
              </div>
              <div style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.text, wordBreak: 'break-all', marginBottom: 10 }}>
                {address}
              </div>

              {candidate ? (
                <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6, marginBottom: 4 }}>
                  <span style={{ color: colors.gold, fontWeight: 600 }}>Already published.</span>{' '}
                  This key can recover the full descriptor on its own, no other key or share needed.{' '}
                  <a
                    href={explorerTxUrl(vault.network, candidate.txid)}
                    target="_blank" rel="noopener noreferrer"
                    style={{ color: colors.gold, fontFamily: fonts.mono, fontSize: 13 }}
                  >
                    View transaction
                  </a>
                </div>
              ) : broadcastTxid ? (
                <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6 }}>
                  <span style={{ color: colors.gold, fontWeight: 600 }}>Published.</span> This key can now
                  recover the full descriptor on its own, decades from now, with nothing else needed.{' '}
                  <a
                    href={explorerTxUrl(vault.network, broadcastTxid)}
                    target="_blank" rel="noopener noreferrer"
                    style={{ color: colors.gold, fontFamily: fonts.mono, fontSize: 13 }}
                  >
                    View transaction
                  </a>
                </div>
              ) : (
                <div style={{ marginTop: 6, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
                  <p style={{ fontSize: 13, color: colors.sub, lineHeight: 1.6, marginBottom: 10 }}>
                    Nothing published yet at this address. Fund it with a small amount from any wallet
                    (unrelated to this vault's own funds), then build, sign, and broadcast the
                    publish transaction below -- entirely from this browser, this key never leaves it.
                  </p>
                  <Button variant="ghost" size="sm" onClick={fetchUtxosForAddress} disabled={fetchingUtxos} style={{ marginBottom: 10 }}>
                    {fetchingUtxos ? 'Checking...' : 'Fetch UTXOs for this address'}
                  </Button>

                  {fetchedUtxos && fetchedUtxos.length === 0 && (
                    <div style={{ fontSize: 13, color: colors.sub, marginBottom: 12 }}>
                      Nothing found yet. Send it a small amount, wait for a confirmation, then fetch again.
                    </div>
                  )}
                  {fetchedUtxos && fetchedUtxos.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                      {fetchedUtxos.map(u => (
                        <button
                          key={`${u.txid}:${u.vout}`}
                          type="button"
                          onClick={() => selectFetchedUtxo(u)}
                          style={{
                            textAlign: 'left', padding: '8px 10px',
                            background: utxoTxid === u.txid && utxoVout === String(u.vout) ? `${colors.gold}22` : colors.input,
                            border: `1px solid ${utxoTxid === u.txid && utxoVout === String(u.vout) ? colors.gold : colors.border}`,
                            borderRadius: radii.md,
                            color: colors.text, fontSize: 12, fontFamily: fonts.mono, cursor: 'pointer',
                          }}
                        >
                          {u.value} sats -- {u.txid.slice(0, 16)}...:{u.vout}
                        </button>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, marginBottom: 8 }}>
                    <input
                      placeholder="UTXO txid"
                      value={utxoTxid}
                      onChange={e => { setUtxoTxid(e.target.value); setBuiltTx(null); }}
                      style={{
                        padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 13, fontFamily: fonts.mono,
                      }}
                    />
                    <input
                      placeholder="vout"
                      value={utxoVout}
                      onChange={e => { setUtxoVout(e.target.value); setBuiltTx(null); }}
                      style={{
                        padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 13, fontFamily: fonts.mono,
                      }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                    <input
                      placeholder="UTXO value (sats)"
                      value={utxoValue}
                      onChange={e => { setUtxoValue(e.target.value); setBuiltTx(null); }}
                      style={{
                        padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 13, fontFamily: fonts.mono,
                      }}
                    />
                    <input
                      placeholder="Fee rate (sat/vB)"
                      value={feeRate}
                      onChange={e => { setFeeRate(e.target.value); setBuiltTx(null); }}
                      style={{
                        padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 13, fontFamily: fonts.mono,
                      }}
                    />
                  </div>

                  {!builtTx ? (
                    <Button onClick={handleBuildPublishTx} disabled={building || !utxoTxid.trim() || !utxoValue}>
                      {building ? 'Building...' : 'Build and sign'}
                    </Button>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ fontSize: 13, color: colors.sub }}>
                        Signed and ready. Fee: {builtTx.feeSats} sats. Change back to the same address: {builtTx.changeSats} sats.
                      </div>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <Button onClick={handleBroadcastPublishTx} disabled={broadcasting}>
                          {broadcasting ? 'Broadcasting...' : 'Broadcast transaction'}
                        </Button>
                        <Button variant="ghost" onClick={() => setBuiltTx(null)}>Rebuild</Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default function LegacyRecoverySetup() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [vault, setVault] = useState<Vault | null>(null);
  const [loading, setLoading] = useState(true);
  const [sealing, setSealing] = useState(false);
  const [existingShareRoles, setExistingShareRoles] = useState<Set<string>>(new Set());
  // Full per-role share content + the sealed bundle -- kept around (not
  // just the role-name Set above) so "Download recovery package" can
  // build a self-contained takeaway file without a second round trip.
  const [shares, setShares] = useState<LegacyShare[]>([]);
  const [bundle, setBundle] = useState<{ nonce_b64: string; ciphertext_b64: string } | null>(null);
  // Sealed-at label + the descriptor fingerprint this bundle was sealed
  // against (2026-08-20) -- null hash means either no seal yet, or a
  // seal predating this field. Compared against the vault's CURRENT
  // descriptor fingerprint below to warn on a stale seal after a
  // recompile; also stamped into the downloadable recovery package.
  const [bundleSealedAt, setBundleSealedAt] = useState<string | null>(null);
  const [sealedDescriptorHash, setSealedDescriptorHash] = useState<string | null>(null);
  const [onchainShareB64, setOnchainShareB64] = useState<string | null>(null);
  const [onchainTxid, setOnchainTxid] = useState<string | null>(null);
  const [txidInput, setTxidInput] = useState('');
  const [recordingTxid, setRecordingTxid] = useState(false);

  const [assignment, setAssignment] = useState<Record<string, string>>({}); // role -> keyId
  const [passwords, setPasswords] = useState<Record<string, string>>({}); // role -> password

  // In-app on-chain publication: fund one local key's own address (any
  // wallet, any amount), paste the resulting UTXO back, and this builds +
  // signs + broadcasts the OP_RETURN publish tx without leaving the app.
  // Still an explicit, separate transaction from unrelated coins -- same
  // privacy property as the manual/Sparrow path above, just automated.
  const [publishKeyId, setPublishKeyId] = useState('');
  const [publishPassword, setPublishPassword] = useState('');
  const [utxoTxid, setUtxoTxid] = useState('');
  const [utxoVout, setUtxoVout] = useState('0');
  const [utxoValue, setUtxoValue] = useState('');
  const [feeRate, setFeeRate] = useState('2');
  const [fetchingUtxos, setFetchingUtxos] = useState(false);
  const [fetchedUtxos, setFetchedUtxos] = useState<Array<{ txid: string; vout: number; value: number }> | null>(null);
  const [building, setBuilding] = useState(false);
  const [builtTx, setBuiltTx] = useState<BuiltPublishTx | null>(null);
  const [broadcasting, setBroadcasting] = useState(false);

  const localKeys = useMemo(
    () => listKeys().filter((k): k is LocalKey => k.origin === 'software' && k.status === 'active'),
    [],
  );

  // The vault's CURRENT descriptor fingerprint, recomputed on every load
  // -- compared against sealedDescriptorHash below to catch a recompile
  // that left a prior seal stale. Hook must run unconditionally (before
  // the loading/not-found early returns), hence the null-safe guard.
  const currentDescriptorHash = useMemo(
    () => (vault?.descriptor ? descriptorFingerprint(vault.descriptor) : null),
    [vault?.descriptor],
  );
  const legacyStale =
    !!bundle && !!sealedDescriptorHash && !!currentDescriptorHash && sealedDescriptorHash !== currentDescriptorHash;

  const publishKey = localKeys.find(k => k.keyId === publishKeyId) ?? null;
  const publishNeedsPassword = !!publishKey && !publishKey.testMnemonic && !!publishKey.encryptedMnemonic;
  const publishAddress = publishKey ? p2wpkhAddressForPubkey(publishKey.pubkey, vault?.network ?? 'testnet') : null;

  async function fetchUtxosForPublishAddress() {
    if (!publishAddress || !vault) return;
    setFetchingUtxos(true);
    setFetchedUtxos(null);
    try {
      const res = await fetch(`${EXPLORER[vault.network].api}/address/${publishAddress}/utxo`);
      if (!res.ok) throw new Error('mempool.space lookup failed');
      const utxos = (await res.json()) as Array<{ txid: string; vout: number; value: number }>;
      setFetchedUtxos(utxos);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Lookup failed');
    } finally {
      setFetchingUtxos(false);
    }
  }

  function selectFetchedUtxo(u: { txid: string; vout: number; value: number }) {
    setUtxoTxid(u.txid);
    setUtxoVout(String(u.vout));
    setUtxoValue(String(u.value));
    setBuiltTx(null);
  }

  async function handleBuildPublishTx() {
    if (!vault || !publishKey || !onchainShareB64) return;
    const valueSats = parseInt(utxoValue, 10);
    const vout = parseInt(utxoVout, 10);
    const rate = parseFloat(feeRate);
    if (!/^[0-9a-fA-F]{64}$/.test(utxoTxid.trim())) {
      toast.error('UTXO txid should be 64 hex characters.');
      return;
    }
    if (!Number.isFinite(vout) || vout < 0) { toast.error('Invalid vout.'); return; }
    if (!Number.isFinite(valueSats) || valueSats <= 0) { toast.error('Invalid UTXO value (sats).'); return; }
    if (!Number.isFinite(rate) || rate <= 0) { toast.error('Invalid fee rate.'); return; }
    setBuilding(true);
    try {
      const mnemonic = await revealMnemonic(publishKey.keyId, publishNeedsPassword ? publishPassword : undefined);
      const built = buildAndSignPublishTx({
        mnemonic,
        derivationPath: publishKey.derivationPath,
        network: vault.network,
        utxo: { txid: utxoTxid.trim(), vout, valueSats },
        opReturnDataHex: toHex(unb64(onchainShareB64)),
        feeRateSatsPerVb: rate,
      });
      setBuiltTx(built);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build transaction');
    } finally {
      setBuilding(false);
    }
  }

  async function handleBroadcastPublishTx() {
    if (!vault || !builtTx) return;
    setBroadcasting(true);
    try {
      const res = await fetch(broadcastTxUrl(vault.network), {
        method: 'POST',
        body: builtTx.hex,
        headers: { 'Content-Type': 'text/plain' },
      });
      const txid = (await res.text()).trim();
      if (!res.ok || txid.length !== 64) throw new Error('Broadcast failed: ' + txid.slice(0, 200));
      await api.legacy.recordOnchainPublication(vault.id, txid);
      setOnchainTxid(txid);
      toast.success('Published and recorded.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Broadcast failed');
    } finally {
      setBroadcasting(false);
    }
  }

  async function refreshLegacyState(vaultId: string) {
    try {
      const existing = await api.legacy.get(vaultId);
      setExistingShareRoles(new Set(existing.shares.map(s => s.key_role)));
      setShares(existing.shares);
      setBundle(existing.bundle ? { nonce_b64: existing.bundle.nonce_b64, ciphertext_b64: existing.bundle.ciphertext_b64 } : null);
      setBundleSealedAt(existing.bundle?.updated_at ?? null);
      setSealedDescriptorHash(existing.bundle?.sealed_descriptor_hash ?? null);
      setOnchainShareB64(existing.onchain?.onchain_share_b64 ?? null);
      setOnchainTxid(existing.onchain?.txid ?? null);
    } catch {
      // No prior seal yet -- fine, this is the first time.
    }
  }

  useEffect(() => {
    (async () => {
      if (!id) return;
      const { vaults } = await api.vaults.list(true);
      const found = vaults.find(v => v.id === id) ?? null;
      setVault(found);
      if (found) await refreshLegacyState(found.id);
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <p style={{ color: colors.muted }}>Loading...</p>;
  if (!vault) return <p style={{ color: colors.red }}>Vault not found.</p>;
  if (!vault.descriptor) {
    return (
      <Card>
        <p style={{ color: colors.text }}>
          This vault hasn't been compiled yet. Compile it first -- Legacy Recovery seals the actual
          descriptor, so there has to be one.
        </p>
      </Card>
    );
  }

  const roles = rolesForVault(vault);

  async function handleSeal() {
    if (!vault || !vault.descriptor) return;
    const missing = roles.filter(r => !assignment[r.role]);
    if (missing.length > 0) {
      toast.error(`Assign a key for: ${missing.map(r => r.label).join(', ')}`);
      return;
    }
    setSealing(true);
    try {
      const network = vaultNetworkToKeystoreNetwork(vault.network);
      const roleKeys = [];
      for (const r of roles) {
        const keyId = assignment[r.role];
        const mnemonic = await revealMnemonic(keyId, passwords[r.role]);
        const derivationPath = localKeys.find(k => k.keyId === keyId)?.derivationPath || undefined;
        roleKeys.push({ keyRole: r.role, mnemonic, derivationPath });
      }
      const bundleText = vaultBackupText(vault);
      await sealVaultLegacyRecovery({ vaultId: vault.id, network, bundleText, descriptor: vault.descriptor, roleKeys });
      toast.success('Legacy recovery sealed for every assigned key.');
      // Every seal mints a brand new secret/shares, so pull the fresh copy
      // back down rather than hand-patching state -- this is also what
      // populates `shares`/`bundle` for the "Download recovery package"
      // buttons below, and clears any stale txid from a prior seal (the
      // backend clears its own copy too), so the "publish" step re-opens
      // instead of silently pointing at stale content.
      await refreshLegacyState(vault.id);
      setBuiltTx(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sealing failed');
    } finally {
      setSealing(false);
    }
  }

  async function handleRecordTxid() {
    if (!vault) return;
    const txid = txidInput.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      toast.error('That doesn\'t look like a txid -- expected 64 hex characters.');
      return;
    }
    setRecordingTxid(true);
    try {
      await api.legacy.recordOnchainPublication(vault.id, txid);
      setOnchainTxid(txid);
      toast.success('Recorded. The on-chain share is now linked to this transaction.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to record txid');
    } finally {
      setRecordingTxid(false);
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
        Each key below gets its own sealed copy of this vault's descriptor -- locked so only that
        exact key can ever open it, decades from now. Pick which of your local keys plays each
        role, confirm the password on any secure key, and seal. Once a key is sealed, download its
        own recovery package below and hand it to whoever holds that key -- it's a small text
        file with everything needed to recover this vault's descriptor later, on their own, with
        no DynastyTrust account and no vault ID to remember. It's safe to store anywhere: without
        that key's own seed phrase, the file alone opens nothing.
      </p>

      {legacyStale && (
        <div style={{
          border: `1px solid ${colors.red}`, borderRadius: radii.md,
          background: `${colors.red}15`, padding: '14px 16px',
        }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: colors.red, margin: 0 }}>
            This vault&apos;s descriptor has changed since Legacy Recovery was last sealed.
          </p>
          <p style={{ fontSize: 13, color: colors.text, marginTop: 6, lineHeight: 1.6 }}>
            The sealed data below (and any on-chain pad already published) still correctly recovers
            the OLD descriptor -- it never hands back a wrong one -- but it no longer matches this
            vault&apos;s current keys. Reseal now so every downloaded package and the on-chain pad
            reflect the current version. If a pad was already published for the old version, it
            stays permanently on-chain and simply becomes historical -- publishing a fresh one after
            reseal is the only way to keep the fast recovery path current.
          </p>
        </div>
      )}

      {bundle && (
        <p style={{ fontSize: 12, color: colors.sub, fontFamily: fonts.mono }}>
          Sealed descriptor version: {sealedDescriptorHash ?? '(unknown -- sealed before this label existed)'}
          {bundleSealedAt ? ` -- sealed ${new Date(bundleSealedAt).toLocaleDateString()}` : ''}
          {currentDescriptorHash && !legacyStale ? ' -- matches this vault\'s current descriptor' : ''}
        </p>
      )}

      {roles.length === 0 && (
        <Card><p style={{ color: colors.muted }}>This vault has no named roles to seal yet.</p></Card>
      )}

      {roles.map(r => {
        const key = localKeys.find(k => k.keyId === assignment[r.role]);
        // A key can only be one mode or the other (generateTestKey never
        // sets encryptedMnemonic; generateSoftwareKey always does;
        // secureTestKey explicitly clears testMnemonic when it sets
        // encryptedMnemonic) -- but check testMnemonic's presence first
        // and treat it as definitive "no password needed", rather than
        // trusting encryptedMnemonic's mere presence alone, as a defensive
        // belt-and-suspenders guard against exactly this failure mode.
        const needsPassword = !key?.testMnemonic && !!key?.encryptedMnemonic;
        const alreadySealed = existingShareRoles.has(r.role);
        const roleShare = shares.find(s => s.key_role === r.role);
        return (
          <Card key={r.role}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>{r.label}</div>
                {alreadySealed && (
                  <div style={{ fontSize: 12, color: colors.gold, fontWeight: 600 }}>Sealed</div>
                )}
              </div>
              {alreadySealed && roleShare && bundle && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => downloadLegacyRecoveryPackage({
                      vaultId: vault.id,
                      vaultName: vault.name,
                      network: vault.network,
                      keyRole: r.role,
                      roleLabel: r.label,
                      lockedFastShareB64: roleShare.locked_fast_share_b64,
                      lockedFallbackShareB64: roleShare.locked_fallback_share_b64,
                      identityPubkeyHex: roleShare.identity_pubkey_hex,
                      lockedFastShareSigB64: roleShare.locked_fast_share_sig_b64,
                      bundle: { nonceB64: bundle.nonce_b64, ciphertextB64: bundle.ciphertext_b64 },
                      onchain: onchainShareB64 ? { onchainShareB64, txid: onchainTxid } : null,
                      descriptorFingerprint: sealedDescriptorHash,
                      sealedAt: bundleSealedAt,
                    })}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    Download recovery package for {r.label}
                  </Button>
                  <div style={{ fontSize: 12, color: colors.sub }}>
                    Hand this file to whoever holds the {r.label.toLowerCase()} key -- it has
                    everything they need to recover this vault's descriptor themselves, with no
                    DynastyTrust account and nothing to remember, other than their own seed phrase.
                    {!onchainShareB64 && ' Redownload once the on-chain share below is published, for the fastest recovery path.'}
                  </div>
                </div>
              )}
              <select
                value={assignment[r.role] ?? ''}
                onChange={e => setAssignment(a => ({ ...a, [r.role]: e.target.value }))}
                style={{
                  width: '100%', padding: '10px 12px', background: colors.input,
                  border: `1px solid ${colors.border}`, borderRadius: radii.md,
                  color: colors.text, fontSize: 16, fontFamily: fonts.sans,
                }}
              >
                <option value="">Choose a local key...</option>
                {localKeys.map(k => (
                  <option key={k.keyId} value={k.keyId}>{k.label}</option>
                ))}
              </select>
              {needsPassword && (
                <input
                  type="password"
                  placeholder="Password for this key"
                  value={passwords[r.role] ?? ''}
                  onChange={e => setPasswords(p => ({ ...p, [r.role]: e.target.value }))}
                  style={{
                    width: '100%', padding: '10px 12px', background: colors.input,
                    border: `1px solid ${colors.border}`, borderRadius: radii.md,
                    color: colors.text, fontSize: 16, fontFamily: fonts.sans,
                    boxSizing: 'border-box',
                  }}
                />
              )}
            </div>
          </Card>
        );
      })}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button onClick={handleSeal} disabled={sealing || roles.length === 0}>
          {sealing ? 'Sealing...' : 'Seal legacy recovery'}
        </Button>
        <button
          type="button"
          onClick={() => navigate(`/vaults/${vault.id}`)}
          style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 13, padding: 0, fontFamily: fonts.sans }}
        >
          Back to vault
        </button>
      </div>

      <div
        style={{
          background: colors.input, border: `1px solid ${colors.gold}33`, borderRadius: radii.md,
          padding: '14px 18px', fontSize: 14, color: colors.sub, lineHeight: 1.6,
        }}
      >
        Sealing doesn't move any funds and doesn't change the vault's spending policy -- it only
        locks a recovery copy of the descriptor to each key above. You can reseal any time the
        descriptor changes; a reseal replaces every prior share, so keep everyone's keys current.
      </div>

      {onchainShareB64 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
            Optional: publish the on-chain share
          </div>
          <p style={{ fontSize: 14, color: colors.sub, lineHeight: 1.6, marginBottom: 12 }}>
            Sealing above is already enough for recovery, as long as two of the keys you assigned
            still exist decades from now. This extra step makes recovery possible with just ONE
            surviving key plus this piece, published where nothing can take it down. There's no
            deadline -- come back to it whenever. This piece needs no key to read, so it's safe to
            publish anywhere: putting it on the Bitcoin blockchain gives it the same permanence as
            the vault itself, independent of DynastyTrust staying online. DynastyTrust doesn't
            hold or move your funds, so publishing always happens from a wallet of your own, using
            coins that have no connection to this vault, in their own separate transaction --
            that's what keeps this vault's own funding transaction looking completely ordinary.
            Two ways to do that: paste the hex into any wallet's OP_RETURN field yourself (Sparrow:
            New Transaction &gt; add an output &gt; OP_RETURN), or use the guided steps below.
          </p>

          <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
            OP_RETURN payload (hex)
          </label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              readOnly
              value={toHex(unb64(onchainShareB64))}
              onFocus={e => e.currentTarget.select()}
              style={{
                flex: 1, padding: '10px 12px', background: colors.input,
                border: `1px solid ${colors.border}`, borderRadius: radii.md,
                color: colors.text, fontSize: 13, fontFamily: fonts.mono,
              }}
            />
            <Button variant="ghost" size="sm" onClick={() => copyText(toHex(unb64(onchainShareB64)), 'Hex payload')}>
              Copy
            </Button>
          </div>

          {onchainTxid ? (
            <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6 }}>
              <div style={{ color: colors.gold, fontWeight: 600, marginBottom: 4 }}>Published.</div>
              Nothing more to do here -- this piece is now permanent and needs no further action,
              unless you reseal this vault later (a reseal mints a new share and you'd publish
              again).{' '}
              <a
                href={explorerTxUrl(vault.network, onchainTxid)}
                target="_blank" rel="noopener noreferrer"
                style={{ color: colors.gold, fontFamily: fonts.mono, fontSize: 13 }}
              >
                View transaction
              </a>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                placeholder="Paste the txid here once you've broadcast it"
                value={txidInput}
                onChange={e => setTxidInput(e.target.value)}
                style={{
                  flex: 1, minWidth: 240, padding: '10px 12px', background: colors.input,
                  border: `1px solid ${colors.border}`, borderRadius: radii.md,
                  color: colors.text, fontSize: 14, fontFamily: fonts.mono,
                }}
              />
              <Button variant="ghost" size="sm" onClick={handleRecordTxid} disabled={recordingTxid || !txidInput.trim()}>
                {recordingTxid ? 'Recording...' : 'Record'}
              </Button>
            </div>
          )}

          {!onchainTxid && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
                Or publish it from here -- four short steps
              </div>
              <p style={{ fontSize: 13, color: colors.sub, lineHeight: 1.6, marginBottom: 12 }}>
                This app builds, signs, and broadcasts the OP_RETURN transaction for you, using a
                key you choose and a small amount of unrelated funds you provide -- it never
                touches this vault's own keys or funds. Follow the four steps below in order; each
                one unlocks the next.
              </p>

              <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                Step 1 -- choose a local key to publish with
              </label>
              <select
                value={publishKeyId}
                onChange={e => { setPublishKeyId(e.target.value); setFetchedUtxos(null); setBuiltTx(null); }}
                style={{
                  width: '100%', padding: '10px 12px', background: colors.input,
                  border: `1px solid ${colors.border}`, borderRadius: radii.md,
                  color: colors.text, fontSize: 16, fontFamily: fonts.sans, marginBottom: 10,
                }}
              >
                <option value="">Choose a local key...</option>
                {localKeys.map(k => (
                  <option key={k.keyId} value={k.keyId}>{k.label}</option>
                ))}
              </select>

              {publishKey && publishAddress && (
                <>
                  {publishNeedsPassword && (
                    <input
                      type="password"
                      placeholder="Password for this key"
                      value={publishPassword}
                      onChange={e => setPublishPassword(e.target.value)}
                      style={{
                        width: '100%', padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 16, fontFamily: fonts.sans,
                        boxSizing: 'border-box', marginBottom: 10,
                      }}
                    />
                  )}

                  <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                    Step 2 -- send a small amount to this address from any wallet, then come back
                  </label>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <input
                      readOnly
                      value={publishAddress}
                      onFocus={e => e.currentTarget.select()}
                      style={{
                        flex: 1, padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 13, fontFamily: fonts.mono,
                      }}
                    />
                    <Button variant="ghost" size="sm" onClick={() => copyText(publishAddress, 'Address')}>
                      Copy
                    </Button>
                  </div>

                  <Button variant="ghost" size="sm" onClick={fetchUtxosForPublishAddress} disabled={fetchingUtxos} style={{ marginBottom: 10 }}>
                    {fetchingUtxos ? 'Checking...' : 'Fetch UTXOs for this address'}
                  </Button>

                  {fetchedUtxos && fetchedUtxos.length === 0 && (
                    <div style={{ fontSize: 13, color: colors.sub, marginBottom: 12 }}>
                      Nothing found yet at that address. Send it a small amount from any wallet,
                      wait for at least one confirmation, then tap "Fetch UTXOs" again.
                    </div>
                  )}
                  {fetchedUtxos && fetchedUtxos.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                      <div style={{ fontSize: 12, color: colors.sub }}>
                        Found {fetchedUtxos.length} confirmed UTXO{fetchedUtxos.length === 1 ? '' : 's'} -- pick one:
                      </div>
                      {fetchedUtxos.map(u => (
                        <button
                          key={`${u.txid}:${u.vout}`}
                          type="button"
                          onClick={() => selectFetchedUtxo(u)}
                          style={{
                            textAlign: 'left', padding: '8px 10px',
                            background: utxoTxid === u.txid && utxoVout === String(u.vout) ? `${colors.gold}22` : colors.input,
                            border: `1px solid ${utxoTxid === u.txid && utxoVout === String(u.vout) ? colors.gold : colors.border}`,
                            borderRadius: radii.md,
                            color: colors.text, fontSize: 12, fontFamily: fonts.mono, cursor: 'pointer',
                          }}
                        >
                          {u.value} sats -- {u.txid.slice(0, 16)}...:{u.vout}
                        </button>
                      ))}
                    </div>
                  )}

                  <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                    Step 3 -- confirm the UTXO details, then build and sign
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, marginBottom: 8 }}>
                    <input
                      placeholder="UTXO txid"
                      value={utxoTxid}
                      onChange={e => { setUtxoTxid(e.target.value); setBuiltTx(null); }}
                      style={{
                        padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 13, fontFamily: fonts.mono,
                      }}
                    />
                    <input
                      placeholder="vout"
                      value={utxoVout}
                      onChange={e => { setUtxoVout(e.target.value); setBuiltTx(null); }}
                      style={{
                        padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 13, fontFamily: fonts.mono,
                      }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                    <input
                      placeholder="UTXO value (sats)"
                      value={utxoValue}
                      onChange={e => { setUtxoValue(e.target.value); setBuiltTx(null); }}
                      style={{
                        padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 13, fontFamily: fonts.mono,
                      }}
                    />
                    <input
                      placeholder="Fee rate (sat/vB)"
                      value={feeRate}
                      onChange={e => { setFeeRate(e.target.value); setBuiltTx(null); }}
                      style={{
                        padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 13, fontFamily: fonts.mono,
                      }}
                    />
                  </div>

                  {!builtTx ? (
                    <Button
                      onClick={handleBuildPublishTx}
                      disabled={building || !utxoTxid.trim() || !utxoValue || (publishNeedsPassword && !publishPassword)}
                    >
                      {building ? 'Building...' : 'Build and sign'}
                    </Button>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <label style={{ display: 'block', fontSize: 12, color: colors.muted }}>
                        Step 4 -- review and broadcast
                      </label>
                      <div style={{ fontSize: 13, color: colors.sub }}>
                        Signed and ready. Fee: {builtTx.feeSats} sats. Change back to the same address: {builtTx.changeSats} sats.
                        Transaction id (once broadcast): <span style={{ fontFamily: fonts.mono, color: colors.text }}>{builtTx.txid}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <Button onClick={handleBroadcastPublishTx} disabled={broadcasting}>
                          {broadcasting ? 'Broadcasting...' : 'Broadcast transaction'}
                        </Button>
                        <Button variant="ghost" onClick={() => setBuiltTx(null)}>
                          Rebuild
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </Card>
      )}

      {roles.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[3], marginTop: space[3] }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
              New: recover with just this key -- nothing else to protect
            </div>
            <p style={{ fontSize: 14, color: colors.sub, lineHeight: 1.6 }}>
              This is a second, independent way in, simpler than sealing above: each key below gets
              its own on-chain address that only that person's real seed can ever compute -- not
              from this vault's xpubs, not from its descriptor, not from anything DynastyTrust
              stores. Publish once, from that key, and years from now recovery is nothing more than
              signing a message with that same key (a hardware wallet's own "Sign Message" feature
              works fine -- no seed phrase ever has to be typed into a recovery tool) to unlock the
              full descriptor, alone, with no second key or share required. No separate file to keep
              track of, and nothing here is stored in DynastyTrust's database at all -- the chain
              itself is the only place this ever lives.
            </p>
          </div>
          {roles.map((r, i) => (
            <LegacyOnChainV2Card key={r.role} vault={vault} role={r} defaultVaultIndex={i} localKeys={localKeys} toast={toast} />
          ))}
        </div>
      )}

      <div style={{ fontSize: 13, color: colors.muted }}>
        Recovery itself doesn't need DynastyTrust running -- it needs a key and{' '}
        <a href="/dynastytrust-legacy-recovery-tool.html" target="_blank" rel="noopener noreferrer" style={{ color: colors.gold }}>
          this standalone recovery tool
        </a>{' '}
        (opens offline, in any browser, with nothing else installed). Keep a copy of it alongside
        every backup.
      </div>
    </div>
  );
}
