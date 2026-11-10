import { useState } from 'react';
import { keyNeedsPassword, protectKeyWithPasskey, passkeyToPassword, type LocalKey } from '../lib/keystore';
import { passkeysAvailable } from '../lib/passkey';
import { Button } from './ui';
import { useToast } from './toast';
import { useConfirm, usePrompt } from './dialog';

/**
 * The two buttons that move a key between a typed password and a
 * passkey. Lives in the key's detail actions on the Keys page.
 *
 * A passkey REPLACES the password: after this the only ways to this
 * key's seed are the passkey and the written recovery phrase, so the
 * confirm text says so in plain words and keystore.ts refuses unless
 * the phrase backup was verified first.
 */
export function PasskeyProtect({ k, onChanged }: { k: LocalKey; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);

  if (k.origin !== 'software') return null;

  async function toPasskey() {
    const ok = await confirm({
      title: 'Protect this key with a passkey',
      message:
        'Your device will ask for Face ID, fingerprint or your security key three times in a row: once to create the passkey and twice to prove it works. ' +
        'After that the password is gone. The only ways to this key will be this passkey and the recovery phrase you wrote down. ' +
        'If you lose the passkey and the written phrase, this key is lost.',
      confirmLabel: 'Continue',
    });
    if (!ok) return;
    let password: string | undefined;
    if (keyNeedsPassword(k)) {
      const pw = await prompt({
        title: 'Unlock key',
        message: `Enter the current password for "${k.label}".`,
        password: true,
        confirmLabel: 'Unlock',
      });
      if (pw == null) return;
      password = pw;
    }
    setBusy(true);
    try {
      await protectKeyWithPasskey(k.keyId, { password });
      toast.success('This key is now protected by your passkey.');
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not set up the passkey');
    } finally {
      setBusy(false);
    }
  }

  async function toPassword() {
    const pw = await prompt({
      title: 'Use a password instead',
      message: `Choose a new password for "${k.label}". Your passkey will be asked once to unlock it.`,
      password: true,
      confirmLabel: 'Set password',
    });
    if (!pw) return;
    setBusy(true);
    try {
      await passkeyToPassword(k.keyId, pw);
      toast.success('This key is protected by a password again.');
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not switch to a password');
    } finally {
      setBusy(false);
    }
  }

  if (k.passkeyMnemonic) {
    return (
      <Button variant="ghost" style={{ fontSize: 13 }} disabled={busy} onClick={() => void toPassword()}>
        {busy ? 'Working...' : 'Use a password instead'}
      </Button>
    );
  }
  if (!passkeysAvailable()) return null;
  return (
    <Button variant="ghost" style={{ fontSize: 13 }} disabled={busy} onClick={() => void toPasskey()}>
      {busy ? 'Waiting for your device...' : 'Use a passkey instead'}
    </Button>
  );
}
