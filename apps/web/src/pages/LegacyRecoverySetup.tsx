import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Vault } from '../lib/api';
import { listKeys, revealMnemonic, type LocalKey } from '../lib/keystore';
import { legacyOnChainDerivationPath, legacyOnChainUnlockMessage } from '../lib/legacy-recovery';
import { vaultBackupText, downloadLegacyOnChainRecoveryNote } from '../lib/descriptor-backup';
import { type BuiltPublishTx } from '../lib/onchain-publish';
import {
  legacyOnChainLookupAddress,
  sealAndBuildOnChainPublishTx,
  fetchLegacyOnChainCandidates,
  toPublishNetwork,
  vaultNetworkToKeystoreNetwork,
  type OnChainCandidate,
} from '../lib/legacy-onchain-recovery';
import { explorerTxUrl, broadcastTxUrl, EXPLORER } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card } from '../components/ui';
import { useToast } from '../components/toast';

// Long-horizon descriptor recovery ("Legacy Recovery" -- see
// apps/web/src/lib/legacy-recovery.ts's header for the full mechanism):
// no shares, no combining, no database at all. Each keyholder publishes
// an encrypted copy of this vault's descriptor to their own fully
// hardened on-chain address -- computable only from their real seed,
// never from this vault's xpubs, descriptor, or anything DynastyTrust
// stores -- and years from now recovers it alone with nothing but a
// signature over one fixed message.

interface RoleSlot {
  role: string;      // e.g. "founder_1"
  label: string;      // e.g. "Founder 1"
}

function rolesForVault(vault: Vault): RoleSlot[] {
  const slots: RoleSlot[] = [];
  vault.founder_keys.forEach((_, i) => slots.push({ role: `founder_${i + 1}`, label: `Founder ${i + 1}` }));
  (vault.backup_keys ?? []).forEach((_, i) => slots.push({ role: `backup_${i + 1}`, label: `Backup ${i + 1}` }));
  vault.heir_keys.forEach((_, i) => slots.push({ role: `heir_${i + 1}`, label: `Heir ${i + 1}` }));
  (vault.second_heir_keys ?? []).forEach((_, i) => slots.push({ role: `second_heir_${i + 1}`, label: `Second heir ${i + 1}` }));
  return slots;
}

// Each role gets its own card because each keyholder derives their own
// address (a fully hardened path -- see legacy-recovery.ts's
// legacyOnChainDerivationPath -- so it can only ever be computed from
// that person's real seed, never from this vault's xpubs or descriptor,
// and nobody can link one keyholder's address to another's or to this
// vault). State here is deliberately local to the card, not lifted to
// the page -- the password is kept only long enough to derive what's
// needed and is never cached.
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
              <Button
                variant="ghost" size="sm" style={{ marginBottom: 10 }}
                onClick={() => downloadLegacyOnChainRecoveryNote({
                  vaultName: vault.name,
                  network: vault.network,
                  roleLabel: role.label,
                  vaultIndex: parsedIndex,
                  address,
                  derivationPath: legacyOnChainDerivationPath(vaultNetworkToKeystoreNetwork(vault.network), parsedIndex),
                  unlockMessage: legacyOnChainUnlockMessage(parsedIndex),
                  txid: candidate?.txid ?? broadcastTxid,
                })}
              >
                Download recovery note (nothing secret in it -- safe to keep anywhere)
              </Button>

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

  const localKeys = useMemo(
    () => listKeys().filter((k): k is LocalKey => k.origin === 'software' && k.status === 'active'),
    [],
  );

  useEffect(() => {
    (async () => {
      if (!id) return;
      const { vaults } = await api.vaults.list(true);
      const found = vaults.find(v => v.id === id) ?? null;
      setVault(found);
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

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: space[3] }}>
      <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, lineHeight: 1.6 }}>
        All you need is your key. Each keyholder below publishes an encrypted copy of this vault's
        descriptor to their own on-chain address -- computable only from their real seed, never
        from this vault's xpubs, its descriptor, or anything DynastyTrust stores. Publish once, and
        years from now recovery is nothing more than signing one fixed message with that same key
        (a hardware wallet's own "Sign Message" feature works fine -- no seed phrase ever has to be
        typed into a recovery tool) to unlock the full descriptor, alone, with no second key or
        share required. No database, no separate file to protect -- the chain itself is the only
        place this ever lives.
      </p>

      {roles.length === 0 ? (
        <Card><p style={{ color: colors.muted }}>This vault has no named roles to publish for yet.</p></Card>
      ) : (
        roles.map((r, i) => (
          <LegacyOnChainV2Card key={r.role} vault={vault} role={r} defaultVaultIndex={i} localKeys={localKeys} toast={toast} />
        ))
      )}

      <button
        type="button"
        onClick={() => navigate(`/vaults/${vault.id}`)}
        style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 13, padding: 0, fontFamily: fonts.sans, alignSelf: 'flex-start' }}
      >
        Back to vault
      </button>

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
