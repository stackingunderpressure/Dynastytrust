import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { supabase, type Session } from '../lib/supabase';
import { accountLabel } from '../lib/account-name';
import { generateSoftwareKey, generateTestKey, listKeys, type LocalKey } from '../lib/keystore';
import { keyNetworkMatches } from '../lib/network';
import { durationWords } from '../lib/timelock-words';
import type { SpendingPathSummary } from '../lib/vault-spending-paths';
import { APP_NAME } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card, Input, Label } from '../components/ui';
import { BackupFlow } from '../components/vault-builder';
import { KeySafety } from '../components/KeySafety';
import { HardwareKeyImport } from '../components/HardwareKeyImport';
import { passwordHint, passwordProblem } from '../lib/password-rules';
import Auth from './Auth';

// Joining a vault with a key made on your own device (journey gap J3).
//
// The older invite page (InviteClaim.tsx) asked a newcomer to go and
// make a key on another page, told them browser keys were "for testing
// only", and let them join with no key at all. This page is for a path
// invite: one named person, one key slot on one path. It walks them
// through the three things that matter, in order -- sign in as the
// invited address, make the key HERE and write its words down, then
// read the fingerprint to the person who invited them. The server
// re-checks all of it (netlify/functions/_invite-rules.js).

export interface PathInviteInfo {
  id: string;
  invited_label: string | null;
  leaf_id?: string;
  /** The slot is one of the path's must-sign keys: every spend on the
   *  path needs this person's key (invites-lookup.js). */
  must_sign?: boolean;
  email_hint?: string | null;
}
export interface PathInviteVault {
  id: string;
  name: string;
  network: 'testnet' | 'signet' | 'bitcoin';
  /** mustSignCount: how many keys must always sign on this path besides
   *  the group the invited person joins (invites-lookup.js). */
  paths: (SpendingPathSummary & { mustSignCount?: number })[];
}

function whenWords(p: SpendingPathSummary): string {
  if (p.unlockType === 'immediate') return 'It can be used right away.';
  if (p.unlockType === 'after') return `It opens ${durationWords(p.unlockBlocks)} after the vault is finalized, on a date that is then fixed for good.`;
  return `It opens only if the vault sits untouched for ${durationWords(p.unlockBlocks)}.`;
}

export default function InviteClaimPath({
  token, invite, vault, session,
}: {
  token: string;
  invite: PathInviteInfo;
  vault: PathInviteVault;
  session: Session | null;
}) {
  const navigate = useNavigate();
  const path = vault.paths[0] ?? null;
  const real = vault.network === 'bitcoin';
  const keystoreNetwork: 'mainnet' | 'signet' | 'testnet' = vault.network === 'bitcoin' ? 'mainnet' : vault.network;

  const [choice, setChoice] = useState<'new' | 'existing'>('new');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [made, setMade] = useState<{ key: LocalKey; mnemonic: string } | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  // The backup opens as soon as a key is made; closing it returns here
  // with "Join" still locked until the words are written down.
  const [backupOpen, setBackupOpen] = useState(true);
  const [existingId, setExistingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [needsTwoStep, setNeedsTwoStep] = useState(false);
  const [joined, setJoined] = useState<LocalKey | null>(null);
  const [localKeys, setLocalKeys] = useState<LocalKey[]>([]);

  const [keysVersion, setKeysVersion] = useState(0);
  useEffect(() => {
    setLocalKeys(listKeys().filter(k => k.status === 'active' && k.origin !== 'tapit' && k.pubkey?.length === 66 && keyNetworkMatches(k.network, vault.network)));
  }, [vault.network, made, keysVersion]);

  const existing = useMemo(() => localKeys.find(k => k.keyId === existingId) ?? null, [localKeys, existingId]);
  // A phone key must have its words written down before it goes into a
  // vault; a hardware wallet's public key has no words in this browser.
  const existingReady = !!existing && (existing.origin !== 'software' || existing.backedUp);
  const keyToUse = choice === 'new' ? (made && backedUp ? made.key : null) : existingReady ? existing : null;

  const page: React.CSSProperties = { minHeight: '100vh', fontFamily: fonts.sans, padding: space[4], display: 'flex', justifyContent: 'center' };
  const col: React.CSSProperties = { width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: space[3] };
  const p: React.CSSProperties = { fontSize: 17, color: colors.text, lineHeight: 1.6, margin: 0 };
  const sub: React.CSSProperties = { fontSize: 17, color: colors.sub, lineHeight: 1.6, margin: 0 };
  const h: React.CSSProperties = { fontFamily: fonts.display, fontSize: 20, color: colors.gold, marginBottom: space[2] };

  const intro = (
    <Card>
      <div style={{ fontFamily: fonts.display, fontSize: 17, letterSpacing: '0.12em', color: colors.gold, marginBottom: space[2] }}>{APP_NAME}</div>
      <p style={p}>
        {invite.invited_label ? `${invite.invited_label}, you` : 'You'} have been invited to hold a key for{' '}
        <strong>{path ? `"${path.label}"` : 'a path'}</strong> in the Bitcoin vault <strong>{vault.name}</strong>
        {real ? '' : ' (test coins, not real bitcoin)'}.
      </p>
      {path && !invite.must_sign && (
        <p style={{ ...sub, marginTop: space[2] }}>
          {path.quorum} of the {path.keyCount} keys on that path must sign together to move the coins
          {(path.mustSignCount ?? 0) > 0
            ? `, and every spend also needs ${path.mustSignCount === 1 ? 'one more key' : `${path.mustSignCount} more keys`}, which must always sign`
            : ''}. {whenWords(path)}
        </p>
      )}
      {path && invite.must_sign && (
        <>
          <p style={{ ...sub, marginTop: space[2] }}>
            Your key will be one that <strong style={{ color: colors.text }}>must sign every spend</strong> on that path,
            on top of {path.quorum} of the {path.keyCount} other {path.keyCount === 1 ? 'key' : 'keys'} on it. {whenWords(path)}
          </p>
          <div style={{ marginTop: space[3], padding: space[3], borderRadius: radii.md, background: colors.inset, border: `1px solid ${colors.orange}` }}>
            <p style={{ ...p, color: colors.orange, fontWeight: 600 }}>Nothing on this path can move without you.</p>
            <p style={{ ...sub, marginTop: space[1] }}>
              If you lose this key, or will not sign, this path can never be used. Keep its words written down
              somewhere safe, and keep the key itself somewhere a thief cannot reach.
            </p>
            <p style={{ ...sub, marginTop: space[1] }}>
              A hardware wallet belongs in this slot. To use one, add it on the{' '}
              <Link to="/keys" style={{ color: colors.gold }}>Keys page</Link> (Import xpub), then open this link again
              and choose it below. A key kept in this browser protects this path only as well as this phone is protected.
            </p>
          </div>
        </>
      )}
      <p style={{ ...sub, marginTop: space[2] }}>
        Your key is made on this device and stays on it. Nobody else ever sees it -- not the person who invited
        you, not {APP_NAME}.
      </p>
    </Card>
  );

  if (!session) {
    return (
      <div style={{ minHeight: '100vh', fontFamily: fonts.sans, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: space[4], display: 'flex', justifyContent: 'center' }}>
          <div style={{ ...col }}>
            {intro}
            <p style={sub}>
              {invite.email_hint
                ? `First, sign in or create an account with the email address this was sent to (${invite.email_hint}). The link only works for that address.`
                : 'First, sign in or create an account -- with an email, or with no email using your key. The owner will confirm your key with you before it goes in the vault.'}
            </p>
          </div>
        </div>
        <Auth />
      </div>
    );
  }

  if (joined) {
    return (
      <div style={page}>
        <div style={col}>
          <Card style={{ borderColor: colors.green, background: colors.successBg }}>
            <div style={{ ...h, color: colors.green }}>You have joined</div>
            <p style={p}>One thing left, and it is the important one. Tell the person who invited you this fingerprint:</p>
            <div style={{ fontFamily: fonts.mono, fontSize: 28, letterSpacing: '0.12em', color: colors.gold, textAlign: 'center', margin: `${space[4]}px 0` }}>
              {joined.masterFingerprint ?? joined.fingerprint}
            </div>
            <p style={sub}>
              Read it to them out loud, by phone or in person. They will see the same eight characters on their
              screen and confirm it. That is how they know the key in the vault is really yours. You can find it
              again any time on your Keys page.
            </p>
            <p style={{ ...sub, marginTop: space[2] }}>
              The vault appears on your home screen now, and becomes active once they finish setting it up.
            </p>
          </Card>
          <Button style={{ minHeight: 44 }} onClick={() => navigate('/vaults')}>Go to my vaults</Button>
        </div>
      </div>
    );
  }

  async function makeKey(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const label = `${vault.name} -- my key`;
    if (real || password) {
      const weak = passwordProblem(password, vault.network);
      if (weak) { setErr(weak); return; }
      if (password !== confirm) { setErr('Passwords do not match'); return; }
    }
    setBusy(true);
    try {
      const res = real || password
        ? await generateSoftwareKey({ label, network: keystoreNetwork, password, persona: label })
        : generateTestKey({ label, network: keystoreNetwork, persona: label });
      setMade(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not make the key');
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!keyToUse) return;
    setBusy(true);
    setErr(null);
    setNeedsTwoStep(false);
    try {
      await api.invites.claim({
        token,
        pubkey: keyToUse.pubkey,
        xpub: keyToUse.xpub,
        fingerprint: keyToUse.masterFingerprint ?? keyToUse.fingerprint,
        derivation_path: keyToUse.derivationPath,
        key_label: keyToUse.label,
      });
      setJoined(keyToUse);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not join';
      setErr(message);
      if (/two-step/i.test(message)) setNeedsTwoStep(true);
    } finally {
      setBusy(false);
    }
  }

  // Writing the words down is not optional here: only finishing the
  // backup unlocks "Join". Closing it early comes back to this page with
  // Join still locked and a way to reopen it.
  if (made && !backedUp && backupOpen) {
    return <BackupFlow keyData={made.key} mnemonic={made.mnemonic} onDone={() => setBackedUp(true)} onCancel={() => setBackupOpen(false)} />;
  }

  return (
    <div style={page}>
      <div style={col}>
        {intro}
        <p style={sub}>
          Signed in as {accountLabel(session.user)}.{' '}
          <button
            type="button"
            style={{ background: 'none', border: 'none', color: colors.gold, cursor: 'pointer', font: 'inherit', padding: 0, textDecoration: 'underline' }}
            onClick={() => void supabase.auth.signOut()}
          >
            Not you? Sign out
          </button>
        </p>

        <Card>
          <div style={h}>Your key</div>
          {!made && (
            <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap', marginBottom: space[3] }}>
              <Button variant={choice === 'new' ? 'primary' : 'ghost'} style={{ minHeight: 44 }} onClick={() => setChoice('new')}>
                Make a new key here
              </Button>
              <Button variant={choice === 'existing' ? 'primary' : 'ghost'} style={{ minHeight: 44 }} onClick={() => setChoice('existing')}>
                Use a key I already have
              </Button>
            </div>
          )}

          {choice === 'new' && !made && (
            <form onSubmit={makeKey} style={{ display: 'flex', flexDirection: 'column', gap: space[3] }}>
              <p style={sub}>
                You will be shown 24 words to write on paper. They are the only way to get this key back if you
                lose or change your phone, so do it now, before you join.
              </p>
              <div>
                <Label>{real ? 'Password to lock the key on this device' : 'Password (optional for test coins)'}</Label>
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} required={real} placeholder="Four unrelated words is ideal" />
                {(real || password) && (
                  <p style={{ ...sub, fontSize: 15, marginTop: 6, color: passwordHint(password, vault.network).level === 'weak' ? colors.orange : colors.sub }}>
                    {passwordHint(password, vault.network).text}
                  </p>
                )}
              </div>
              {(real || password) && (
                <div>
                  <Label>Confirm password</Label>
                  <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
                </div>
              )}
              <p style={{ ...sub, fontSize: 17 }}>
                The password cannot be recovered. If you forget it, the 24 words still bring the key back.
              </p>
              <KeySafety />
              <Button type="submit" style={{ minHeight: 44 }} disabled={busy}>{busy ? 'Making your key...' : 'Make my key'}</Button>
            </form>
          )}

          {choice === 'new' && made && !backedUp && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
              <p style={{ ...p, color: colors.orange }}>
                Your key is made, but its words are not written down yet. You cannot join until they are.
              </p>
              <Button style={{ minHeight: 44 }} onClick={() => setBackupOpen(true)}>Write down my words</Button>
            </div>
          )}

          {choice === 'new' && made && backedUp && (
            <p style={{ ...p, color: colors.green }}>
              Your key is made and its words are written down. Fingerprint{' '}
              <span style={{ fontFamily: fonts.mono, color: colors.gold }}>{made.key.masterFingerprint ?? made.key.fingerprint}</span>.
            </p>
          )}

          {choice === 'existing' && !made && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
              <HardwareKeyImport
                network={vault.network}
                onAdded={key => { setKeysVersion(v => v + 1); setExistingId(key.keyId); }}
              />
              {localKeys.length === 0 ? (
                <p style={sub}>
                  There is no other {real ? 'real-bitcoin' : 'test-coin'} key on this device yet. Bring in a hardware
                  wallet's key above, or make a new one.
                </p>
              ) : (
                <>
                  <select
                    value={existingId}
                    onChange={e => setExistingId(e.target.value)}
                    style={{ width: '100%', padding: '11px 13px', background: colors.input, border: `1px solid ${colors.border}`, borderRadius: radii.md, color: colors.text, fontSize: 18, fontFamily: fonts.sans, boxSizing: 'border-box' }}
                  >
                    <option value="">Pick a key on this device...</option>
                    {localKeys.map(k => (
                      <option key={k.keyId} value={k.keyId}>
                        {k.label} ({k.masterFingerprint ?? k.fingerprint}){k.origin === 'imported_xpub' ? ' -- hardware wallet' : ''}
                      </option>
                    ))}
                  </select>
                  {existing && !existingReady && (
                    <p style={{ ...sub, color: colors.orange }}>
                      This key's 24 words have not been written down and checked yet. Do that on the{' '}
                      <Link to="/keys" style={{ color: colors.gold }}>Keys page</Link> (Backup), then open this link again.
                    </p>
                  )}
                  {existing?.origin === 'imported_xpub' && !existing.masterFingerprint && (
                    <p style={{ ...sub, color: colors.orange }}>
                      This hardware key was added without its master fingerprint, so the wallet may not recognise
                      its own key when it is time to sign. Re-add it by scanning or pasting the wallet's full export.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </Card>

        {err && (
          <Card style={{ borderColor: colors.borderDanger, background: colors.dangerBg }}>
            <p style={{ ...p, color: colors.red }}>{err}</p>
            {needsTwoStep && (
              <p style={{ ...sub, marginTop: space[2] }}>
                Sign out and sign back in with your key (No email? Your key is your account), or open the{' '}
                <Link to="/keys" style={{ color: colors.gold }}>Keys page</Link>, turn on two-step sign-in, and sign back in with
                your code. Then open this link again. Your key stays on this device meanwhile.
              </p>
            )}
          </Card>
        )}

        <Button style={{ minHeight: 48 }} disabled={busy || !keyToUse} onClick={() => void join()}>
          {busy ? 'Joining...' : keyToUse ? `Join ${vault.name} with this key` : 'Make or pick a key to join'}
        </Button>
      </div>
    </div>
  );
}
