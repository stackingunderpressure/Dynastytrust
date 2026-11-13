import { useState } from 'react';
import { passkeyLockPlan, protectAllKeysWithPasskey } from '../lib/keystore';
import { passkeysAvailable } from '../lib/passkey';
import { colors, radii, space } from '../theme';
import { Button } from './ui';
import { useToast } from './toast';
import { useConfirm, usePrompt } from './dialog';

/**
 * "Lock all my keys with Face ID" -- top of the Keys page.
 *
 * Operator, 2026-11-13: "Make browser keys Face ID for everything
 * important." Before this, each key had to be switched one at a time
 * from inside its own detail screen, and each made its own passkey.
 * keystore.protectAllKeysWithPasskey unlocks every password key with the
 * one password typed, locks them all under this device's one passkey
 * (two Face ID prompts for the whole batch, a third the very first time),
 * and leaves any key that password does not open exactly as it was.
 *
 * Shown only when there is something to lock and the browser can do it.
 * Keys whose written backup is not yet checked are named, not locked:
 * once the password goes, those words are the only way back.
 */
export function FaceIdLockAll({ keysVersion, onChanged }: { keysVersion: number; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);
  void keysVersion; // re-render when the key list changes
  if (!passkeysAvailable()) return null;
  const { ready, notBackedUp } = passkeyLockPlan();
  if (ready.length === 0 && notBackedUp.length === 0) return null;

  const sub: React.CSSProperties = { fontSize: 17, color: colors.sub, lineHeight: 1.6, margin: 0 };

  async function lockAll() {
    const ok = await confirm({
      title: 'Lock keys with Face ID',
      message:
        `${ready.length === 1 ? 'This key' : `These ${ready.length} keys`} will open with Face ID (or your fingerprint) instead of a password. ` +
        'Your phone asks two or three times to prove it works. After that the password is gone; the ways back are Face ID and each key\'s written recovery phrase. ' +
        'You can switch any key back to a password on its own screen.',
      confirmLabel: 'Continue',
    });
    if (!ok) return;
    const pw = await prompt({
      title: 'Unlock your keys',
      message: 'Enter the password your keys use. Any key with a different password is left as it is.',
      password: true,
      confirmLabel: 'Unlock',
    });
    if (pw == null) return;
    setBusy(true);
    try {
      const { locked, wrongPassword } = await protectAllKeysWithPasskey(pw);
      if (locked.length) toast.success(`${locked.length} ${locked.length === 1 ? 'key is' : 'keys are'} now locked with Face ID.`);
      if (wrongPassword.length) {
        toast.error(`That password did not open: ${wrongPassword.map(k => k.label).join(', ')}. ${wrongPassword.length === 1 ? 'It keeps' : 'They keep'} its password; try again with ${wrongPassword.length === 1 ? 'its' : 'their'} own.`);
      }
      onChanged();
    } catch (e) {
      toast.error((e instanceof Error ? e.message : 'Face ID could not lock the keys') + ' Every key keeps its password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 16, padding: space[3], background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: radii.md, display: 'flex', flexDirection: 'column', gap: space[2] }}>
      <p style={{ ...sub, color: colors.text, fontWeight: 600 }}>Face ID for your keys</p>
      {ready.length > 0 ? (
        <>
          <p style={sub}>
            {ready.length === 1 ? '1 key still opens' : `${ready.length} keys still open`} with a typed password.
            Lock {ready.length === 1 ? 'it' : 'them'} with Face ID so signing needs your face, not something that can be read as you type.
          </p>
          <Button style={{ minHeight: 44 }} disabled={busy} onClick={() => void lockAll()}>
            {busy ? 'Waiting for Face ID...' : ready.length === 1 ? 'Lock it with Face ID' : `Lock all ${ready.length} with Face ID`}
          </Button>
        </>
      ) : null}
      {notBackedUp.length > 0 && (
        <p style={{ ...sub, fontSize: 16 }}>
          Not yet: {notBackedUp.map(k => k.label).join(', ')}. Verify {notBackedUp.length === 1 ? 'its' : 'each one\'s'} written
          recovery phrase first (open the key, then Verify backup), because after Face ID that phrase is the only way back.
        </p>
      )}
    </div>
  );
}
