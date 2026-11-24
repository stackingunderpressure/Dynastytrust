import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';
import { isPlaceholderEmail } from '../lib/account-name';
import { addFaceIdToThisAccount, faceIdAccountsPossible } from '../lib/passkey-account';
import { colors, radii, space } from '../theme';
import { Button } from './ui';
import { useToast } from './toast';
import { useConfirm } from './dialog';

const box: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: space[2], padding: space[3], marginBottom: space[4], background: colors.surface, border: `1px solid ${colors.gold}55`, borderRadius: radii.md };
const sub: React.CSSProperties = { fontSize: 17, color: colors.sub, lineHeight: 1.6, margin: 0 };

function masked(email: string): string {
  const [local, domain] = email.split('@');
  return local && domain ? `${local.slice(0, 1)}***@${domain}` : email;
}

/**
 * Z4 (zero-knowledge storage, operator's chips 2026-11-24): an existing
 * account adds Face ID sign-in (lib/passkey-account.ts), and then may take
 * its email off DynastyTrust (account-email.js). The second step is offered
 * only once a key exists, because without one the person would be locked out.
 */
export function AccountPrivacyCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const [faceKeys, setFaceKeys] = useState(0);
  const [tapit, setTapit] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data } = await supabase.auth.getUser();
    setEmail(data.user?.email ?? null);
    try {
      const link = await api.walletLink.get();
      setFaceKeys(link.device_keys ?? 0);
      setTapit(!!link.pubkey);
    } catch {
      /* shown as no keys; the server still refuses if that is wrong */
    }
  }
  useEffect(() => { void load(); }, []);

  if (email === undefined) return null;
  const hasEmail = !!email && !isPlaceholderEmail(email);
  const hasKey = faceKeys > 0 || tapit;
  if (!hasEmail && faceKeys > 0) return null; // nothing left to do here

  async function addFaceId() {
    setBusy(true);
    try {
      await addFaceIdToThisAccount();
      toast.success('Face ID sign-in is on for this account.');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Face ID did not work');
    } finally {
      setBusy(false);
    }
  }

  async function removeEmail() {
    const ok = await confirm({
      title: 'Remove your email?',
      message:
        `DynastyTrust will forget ${masked(email!)}. After this there is no reset by email: you sign in with ` +
        `${faceKeys > 0 ? 'Face ID' : 'Tapit'}${faceKeys > 0 && tapit ? ' or Tapit' : ''}. Lose that and the account is gone ` +
        '(money in a vault stays safe with its own keys, and you would be invited back).',
      confirmLabel: 'Remove my email',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.account.removeEmail();
      await supabase.auth.refreshSession();
      toast.success('Your email is gone from DynastyTrust.');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove the email');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={box}>
      <p style={{ ...sub, color: colors.text, fontWeight: 600 }}>Sign in without an email</p>
      {faceKeys === 0 && faceIdAccountsPossible() && (
        <>
          <p style={sub}>
            Add Face ID sign-in to this account. Your phone keeps the key and your Apple or Google account carries it to
            a new phone. No password to type.
          </p>
          <Button style={{ minHeight: 44 }} disabled={busy} onClick={() => void addFaceId()}>
            {busy ? 'Waiting for Face ID...' : 'Add Face ID sign-in'}
          </Button>
        </>
      )}
      {faceKeys > 0 && <p style={sub}>Face ID sign-in is on for this account.</p>}
      {hasEmail && (
        <>
          <p style={sub}>
            {hasKey
              ? `Your email (${masked(email!)}) is the one thing here that says who you are. You can remove it now.`
              : `Your email (${masked(email!)}) is on file. Add Face ID sign-in first, then you can remove it.`}
          </p>
          <Button variant="ghost" style={{ minHeight: 44 }} disabled={busy || !hasKey} onClick={() => void removeEmail()}>
            Remove my email
          </Button>
        </>
      )}
    </div>
  );
}
