import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Vault } from '../lib/api';
import { listKeys, revealMnemonic, type LocalKey } from '../lib/keystore';
import { legacyOnChainDerivationPath } from '../lib/legacy-recovery';
import { vaultBackupText, downloadLegacyOnChainRecoveryNote } from '../lib/descriptor-backup';
import { buildAndSignPublishTx, p2wpkhAddressForPubkey, type BuiltPublishTx } from '../lib/onchain-publish';
import {
  legacyOnChainLookupAddress,
  sealOnChainPayload,
  fetchLegacyOnChainCandidates,
  toPublishNetwork,
  vaultNetworkToKeystoreNetwork,
  type OnChainCandidate,
} from '../lib/legacy-onchain-recovery';
import { explorerTxUrl, broadcastTxUrl, EXPLORER } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

// Long-horizon descriptor recovery ("Legacy Recovery" -- see
// apps/web/src/lib/legacy-recovery.ts's header for the full mechanism):
// no shares, no combining, no database at all. Each keyholder publishes
// an encrypted copy of this vault's descriptor to their own on-chain
// address -- computable only from their real seed, never from this
// vault's xpubs, descriptor, or anything DynastyTrust stores -- and
// years from now recovers it alone by signing the random nonce found
// published right alongside the encrypted data, nothing memorized.

interface RoleSlot {
  role: string;      // e.g. "founder_1"
  label: string;      // e.g. "Founder 1"
}

function rolesForVault(vault: Vault): RoleSlot[] {
  const slots: RoleSlot[] = [];
  if (Array.isArray(vault.leaves) && vault.leaves.length > 0) {
    // Generic leaf-list ("custom builder") vault -- has no founder_keys/
    // heir_keys/backup_keys/second_heir_keys at all (those columns sit at
    // their bare DB defaults for this shape, same gap documented in
    // VaultDetail.tsx's computePhase). One role slot per key in every
    // leaf, keyed off the leaf's own id/label instead of the fixed
    // founder/heir shape -- a key reused across leaves gets one slot per
    // leaf it actually appears in, same pattern vault-membership grants
    // already use for this vault shape (circle-membership-delivery.ts).
    vault.leaves.forEach(leaf => {
      leaf.keys.forEach((_, i) => {
        slots.push({
          role: `${leaf.id}_${i + 1}`,
          label: leaf.keys.length > 1 ? `${leaf.label} ${i + 1}` : leaf.label,
        });
      });
    });
    return slots;
  }
  vault.founder_keys.forEach((_, i) => slots.push({ role: `founder_${i + 1}`, label: `Founder ${i + 1}` }));
  (vault.backup_keys ?? []).forEach((_, i) => slots.push({ role: `backup_${i + 1}`, label: `Backup ${i + 1}` }));
  vault.heir_keys.forEach((_, i) => slots.push({ role: `heir_${i + 1}`, label: `Heir ${i + 1}` }));
  (vault.second_heir_keys ?? []).forEach((_, i) => slots.push({ role: `second_heir_${i + 1}`, label: `Second heir ${i + 1}` }));
  return slots;
}

// Each role gets its own card because each keyholder derives their own
// address (an account-level-hardened path -- see legacy-recovery.ts's
// legacyOnChainDerivationPath -- so it can only ever be computed from
// that person's real seed, never from this vault's xpubs or descriptor,
// and nobody can link one keyholder's address to another's or to this
// vault). State here is deliberately local to the card, not lifted to
// the page -- the password is kept only long enough to derive what's
// needed and is never cached.
function LegacyOnChainV2Card({ vault, role, localKeys, toast }: {
  vault: Vault;
  role: RoleSlot;
  localKeys: LocalKey[];
  toast: ReturnType<typeof useToast>;
}) {
  const [keyId, setKeyId] = useState('');
  const [password, setPassword] = useState('');
  const [checking, setChecking] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<OnChainCandidate | null>(null);
  const [sealing, setSealing] = useState(false);
  const [payloadHex, setPayloadHex] = useState<string | null>(null);
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

  // The key that PAYS for and signs the publish transaction -- deliberately
  // separate from the identity key above. It never needs to sign anything
  // for the recovery mechanism itself; it just funds one ordinary
  // transaction that happens to carry the OP_RETURN payload and a small,
  // permanent payment to the identity address as one of its outputs. That
  // address only ever needs to appear as an OUTPUT of some transaction --
  // never an input -- so there's no "fund it, wait, then spend from it"
  // dance: one key, one transaction, one signature.
  const [billboardKeyId, setBillboardKeyId] = useState('');
  const [billboardPassword, setBillboardPassword] = useState('');
  const [billboardAmount, setBillboardAmount] = useState('1000');

  const key = localKeys.find(k => k.keyId === keyId) ?? null;
  const needsPassword = !!key && !key.testMnemonic && !!key.encryptedMnemonic;

  const billboardKey = localKeys.find(k => k.keyId === billboardKeyId) ?? null;
  const billboardNeedsPassword = !!billboardKey && !billboardKey.testMnemonic && !!billboardKey.encryptedMnemonic;
  const billboardAddress = billboardKey ? p2wpkhAddressForPubkey(billboardKey.pubkey, vault.network) : null;

  async function handleCheckAddress() {
    if (!key) return;
    setChecking(true);
    setCandidate(null);
    try {
      const network = vaultNetworkToKeystoreNetwork(vault.network);
      const mnemonic = await revealMnemonic(key.keyId, needsPassword ? password : undefined);
      const addr = legacyOnChainLookupAddress(mnemonic, network);
      setAddress(addr);
      setPayloadHex(null);
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

  // Sealing (compute the OP_RETURN payload) and publishing (get it into a
  // real, broadcast transaction) are genuinely separate steps -- sealing
  // never touches the network at all. This function does ONLY the seal:
  // it derives the same nonce-sign-then-encrypt payload handleBuildPublishTx
  // below would otherwise compute inline, but stops there and shows it, so
  // the resulting hex can be taken to ANY wallet that supports a custom
  // OP_RETURN output -- Sparrow, Electrum, anything -- funded from anywhere,
  // built whenever convenient, with zero further coordination with this
  // app. The only two requirements for that outside transaction: carry
  // this exact payload hex as an OP_RETURN output, and send at least a
  // dust-limit amount to the address above as another output (that's what
  // makes the transaction show up when this key's address is looked up
  // later) -- once it confirms, nothing else has to be done.
  async function handleSeal() {
    if (!key) return;
    setSealing(true);
    try {
      const network = vaultNetworkToKeystoreNetwork(vault.network);
      const mnemonic = await revealMnemonic(key.keyId, needsPassword ? password : undefined);
      const { payloadHex: sealed } = await sealOnChainPayload({
        bundleText: vaultBackupText(vault),
        mnemonic,
        network,
      });
      setPayloadHex(sealed);
      setBuiltTx(null);
      toast.success('Sealed. Copy the payload below, or use DynastyTrust\'s own builder below to publish it.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not seal the payload with that key.');
    } finally {
      setSealing(false);
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

  async function fetchUtxosForAddress() {
    if (!billboardAddress) return;
    setFetchingUtxos(true);
    setFetchedUtxos(null);
    try {
      const res = await fetch(`${EXPLORER[vault.network].api}/address/${billboardAddress}/utxo`);
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
    if (!billboardKey || !address || !payloadHex) return;
    const valueSats = parseInt(utxoValue, 10);
    const vout = parseInt(utxoVout, 10);
    const rate = parseFloat(feeRate);
    const billboardSats = parseInt(billboardAmount, 10);
    if (!/^[0-9a-fA-F]{64}$/.test(utxoTxid.trim())) { toast.error('UTXO txid should be 64 hex characters.'); return; }
    if (!Number.isFinite(vout) || vout < 0) { toast.error('Invalid vout.'); return; }
    if (!Number.isFinite(valueSats) || valueSats <= 0) { toast.error('Invalid UTXO value (sats).'); return; }
    if (!Number.isFinite(rate) || rate <= 0) { toast.error('Invalid fee rate.'); return; }
    if (!Number.isInteger(billboardSats) || billboardSats < 294) { toast.error('Payment amount must be at least 294 sats (below that, Bitcoin nodes treat an output as dust).'); return; }
    setBuilding(true);
    try {
      const payerMnemonic = await revealMnemonic(billboardKey.keyId, billboardNeedsPassword ? billboardPassword : undefined);
      const built = buildAndSignPublishTx({
        mnemonic: payerMnemonic,
        derivationPath: billboardKey.derivationPath,
        network: vault.network,
        utxo: { txid: utxoTxid.trim(), vout, valueSats },
        opReturnDataHex: payloadHex,
        feeRateSatsPerVb: rate,
        payTo: { address, amountSats: billboardSats },
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
        onChange={e => { setKeyId(e.target.value); setAddress(null); setCandidate(null); setPayloadHex(null); setBuiltTx(null); setBroadcastTxid(null); }}
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
            disabled={checking || (needsPassword && !password)}
            style={{ marginBottom: 10 }}
          >
            {checking ? 'Deriving...' : 'Derive address and check the chain'}
          </Button>

          {address && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                This key's on-chain lookup address:
              </div>
              <div style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.text, wordBreak: 'break-all', marginBottom: 10 }}>
                {address}
              </div>
              <Button
                variant="ghost" size="sm" style={{ marginBottom: 10 }}
                onClick={() => void downloadLegacyOnChainRecoveryNote({
                  vaultName: vault.name,
                  network: vault.network,
                  roleLabel: role.label,
                  address,
                  derivationPath: legacyOnChainDerivationPath(vaultNetworkToKeystoreNetwork(vault.network)),
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
                    Nothing published yet. First seal the payload with this key -- that never touches
                    the network, it just produces the exact bytes to publish. Then either copy that
                    hex into ANY wallet that supports a custom OP_RETURN output (Sparrow, Electrum,
                    anything) and send it a small payment to the address above from wherever you
                    already have funds, or use DynastyTrust's own builder below with any of your
                    OTHER local keys. Either way, once that transaction confirms, this key alone can
                    recover the descriptor -- nothing else has to be done.
                  </p>

                  <Button
                    variant="ghost" size="sm" onClick={handleSeal}
                    disabled={sealing || (needsPassword && !password)}
                    style={{ marginBottom: 10 }}
                  >
                    {sealing ? 'Sealing...' : payloadHex ? 'Re-seal (generates a new payload)' : 'Seal payload'}
                  </Button>

                  {payloadHex && (
                    <div style={{ marginBottom: 14 }}>
                      <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                        OP_RETURN payload (hex) -- paste this exactly, as a custom OP_RETURN output, in
                        any wallet. Re-sealing produces a DIFFERENT payload, so build from whichever
                        copy you actually use -- don't mix an old copy with a freshly re-sealed one.
                      </label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Textarea mono readOnly value={payloadHex} rows={3} style={{ flex: 1 }} />
                        <Button variant="ghost" size="sm" onClick={() => copyText(payloadHex, 'Payload')}>
                          Copy
                        </Button>
                      </div>
                    </div>
                  )}

                  {payloadHex && (
                  <>
                  <p style={{ fontSize: 13, color: colors.sub, lineHeight: 1.6, marginBottom: 10 }}>
                    Or, publish directly from DynastyTrust: pick any of your OTHER funded local keys
                    below -- it pays a small, permanent amount to the address above and carries the
                    sealed payload above, both as outputs of the SAME transaction. This key above
                    never has to sign a transaction itself, only ever a message, later, at recovery
                    time.
                  </p>

                  <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                    Paying key (any local key with spendable funds)
                  </label>
                  <select
                    value={billboardKeyId}
                    onChange={e => { setBillboardKeyId(e.target.value); setFetchedUtxos(null); setBuiltTx(null); }}
                    style={{
                      width: '100%', padding: '10px 12px', background: colors.input,
                      border: `1px solid ${colors.border}`, borderRadius: radii.md,
                      color: colors.text, fontSize: 16, fontFamily: fonts.sans, marginBottom: 10,
                    }}
                  >
                    <option value="">Choose a local key...</option>
                    {localKeys.map(k => <option key={k.keyId} value={k.keyId}>{k.label}</option>)}
                  </select>
                  {billboardNeedsPassword && (
                    <input
                      type="password"
                      placeholder="Password for this key"
                      value={billboardPassword}
                      onChange={e => setBillboardPassword(e.target.value)}
                      style={{
                        width: '100%', padding: '10px 12px', background: colors.input,
                        border: `1px solid ${colors.border}`, borderRadius: radii.md,
                        color: colors.text, fontSize: 16, fontFamily: fonts.sans,
                        boxSizing: 'border-box', marginBottom: 10,
                      }}
                    />
                  )}
                  {billboardAddress && (
                    <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
                      Fund this key's own address from any wallet, then fetch its UTXOs below:{' '}
                      <span style={{ fontFamily: fonts.mono, color: colors.sub, wordBreak: 'break-all' }}>{billboardAddress}</span>
                    </div>
                  )}

                  <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                    Amount to send to the address above (sats -- never meant to move again)
                  </label>
                  <input
                    value={billboardAmount}
                    onChange={e => { setBillboardAmount(e.target.value.replace(/[^0-9]/g, '')); setBuiltTx(null); }}
                    style={{
                      width: 140, padding: '10px 12px', background: colors.input,
                      border: `1px solid ${colors.border}`, borderRadius: radii.md,
                      color: colors.text, fontSize: 14, fontFamily: fonts.mono, marginBottom: 10,
                    }}
                  />

                  <Button variant="ghost" size="sm" onClick={fetchUtxosForAddress} disabled={fetchingUtxos || !billboardKey} style={{ marginBottom: 10 }}>
                    {fetchingUtxos ? 'Checking...' : "Fetch UTXOs for the paying key's address"}
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
                    <Button onClick={handleBuildPublishTx} disabled={building || !billboardKey || !utxoTxid.trim() || !utxoValue}>
                      {building ? 'Building...' : 'Build and sign'}
                    </Button>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ fontSize: 13, color: colors.sub }}>
                        Signed and ready. Payment to the recovery address: {builtTx.payToSats ?? 0} sats. Fee: {builtTx.feeSats} sats.
                        Change back to the paying key's own address: {builtTx.changeSats} sats.
                      </div>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <Button onClick={handleBroadcastPublishTx} disabled={broadcasting}>
                          {broadcasting ? 'Broadcasting...' : 'Broadcast transaction'}
                        </Button>
                        <Button variant="ghost" onClick={() => setBuiltTx(null)}>Rebuild</Button>
                      </div>
                    </div>
                  )}
                  </>
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
        All you need is your key. Each keyholder below seals an encrypted copy of this vault's
        descriptor for their own on-chain address -- computable only from their real seed, never
        from this vault's xpubs, its descriptor, or anything DynastyTrust stores -- then publishes
        it either through DynastyTrust's own builder or, since sealing never touches the network,
        by copying the payload into any other wallet that supports a custom OP_RETURN output.
        Publish once, and years from now recovery is nothing more than signing the exact bytes
        found published there (a hardware wallet's own "Sign Message" feature works fine -- no
        seed phrase ever has to be typed into a recovery tool, nothing memorized ahead of time) to
        unlock the full descriptor, alone, with no second key or share required. No database, no
        separate file to protect -- the chain itself is the only place this ever lives.
      </p>

      {roles.length === 0 ? (
        <Card><p style={{ color: colors.muted }}>This vault has no named roles to publish for yet.</p></Card>
      ) : (
        roles.map(r => (
          <LegacyOnChainV2Card key={r.role} vault={vault} role={r} localKeys={localKeys} toast={toast} />
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
