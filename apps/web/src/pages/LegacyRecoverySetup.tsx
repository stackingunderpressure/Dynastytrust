import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Vault } from '../lib/api';
import { listKeys, revealMnemonic, type LocalKey } from '../lib/keystore';
import { sealVaultLegacyRecovery, vaultNetworkToKeystoreNetwork } from '../lib/legacy-seal';
import { unb64 } from '../lib/legacy-recovery';
import { vaultBackupText } from '../lib/descriptor-backup';
import { p2wpkhAddressForPubkey, buildAndSignPublishTx, type BuiltPublishTx } from '../lib/onchain-publish';
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

function rolesForVault(vault: Vault): RoleSlot[] {
  const slots: RoleSlot[] = [];
  vault.founder_keys.forEach((_, i) => slots.push({ role: `founder_${i + 1}`, label: `Founder ${i + 1}` }));
  (vault.backup_keys ?? []).forEach((_, i) => slots.push({ role: `backup_${i + 1}`, label: `Backup ${i + 1}` }));
  vault.heir_keys.forEach((_, i) => slots.push({ role: `heir_${i + 1}`, label: `Heir ${i + 1}` }));
  (vault.protector_keys ?? []).forEach((_, i) => slots.push({ role: `protector_${i + 1}`, label: `Protector ${i + 1}` }));
  (vault.second_heir_keys ?? []).forEach((_, i) => slots.push({ role: `second_heir_${i + 1}`, label: `Second heir ${i + 1}` }));
  return slots;
}

export default function LegacyRecoverySetup() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [vault, setVault] = useState<Vault | null>(null);
  const [loading, setLoading] = useState(true);
  const [sealing, setSealing] = useState(false);
  const [existingShareRoles, setExistingShareRoles] = useState<Set<string>>(new Set());
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

  useEffect(() => {
    (async () => {
      if (!id) return;
      const { vaults } = await api.vaults.list(true);
      const found = vaults.find(v => v.id === id) ?? null;
      setVault(found);
      if (found) {
        try {
          const existing = await api.legacy.get(found.id);
          setExistingShareRoles(new Set(existing.shares.map(s => s.key_role)));
          setOnchainShareB64(existing.onchain?.onchain_share_b64 ?? null);
          setOnchainTxid(existing.onchain?.txid ?? null);
        } catch {
          // No prior seal yet -- fine, this is the first time.
        }
      }
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
    if (!vault) return;
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
      const { onchainShareB64: freshOnchainShareB64 } =
        await sealVaultLegacyRecovery({ vaultId: vault.id, network, bundleText, roleKeys });
      toast.success('Legacy recovery sealed for every assigned key.');
      setExistingShareRoles(new Set(roles.map(r => r.role)));
      // Every seal mints a brand new on-chain share, so any txid recorded
      // against a PRIOR seal no longer matches what's shown below -- clear
      // it here (the backend clears its own copy too) so the "publish"
      // step re-opens instead of silently pointing at stale content.
      setOnchainShareB64(freshOnchainShareB64);
      setOnchainTxid(null);
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
        exact key can ever open it, decades from now, with nothing extra to back up. Pick which of
        your local keys plays each role, confirm the password on any secure key, and seal.
      </p>

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
        return (
          <Card key={r.role}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>{r.label}</div>
                {alreadySealed && (
                  <div style={{ fontSize: 12, color: colors.gold, fontWeight: 600 }}>Sealed</div>
                )}
              </div>
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
