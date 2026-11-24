import { colors, fonts } from '../../theme';
import { Input, Label } from '../ui';
import { passwordHint } from '../../lib/password-rules';
import { passkeysAvailable } from '../../lib/passkey';
import type { KeyProtection, PasswordProtectState } from './key-protection';

type AnyNetwork = 'mainnet' | 'bitcoin' | 'signet' | 'testnet';

// The one key-protection control for making a key, shared by KeyManager's
// "New key" and "Restore" and VaultWizard's per-role key creation -- one
// implementation, so there is exactly one place this can be wrong.
//
// Operator, 2026-11-24: "We don't need a password creating a key if Face ID
// signs ... Password is just weight on user." So Face ID is the default
// wherever the device has it (keystore.generatePasskeyKey); a password is
// the fallback for a device without it; no lock at all is for test coins
// only (keystore refuses it for real bitcoin).

const CHOICE: Record<KeyProtection, { title: string; detail: string }> = {
  faceid: { title: 'Face ID (recommended)', detail: 'Your face or fingerprint unlocks it. Nothing to type or forget.' },
  password: { title: 'A password', detail: 'For a device without Face ID. Four or more unrelated words.' },
  none: { title: 'No lock (test coins only)', detail: 'The words sit in plain text in this browser. Never for real bitcoin.' },
};

export function PasswordProtectFields({
  state,
  onChange,
  network = 'testnet',
  allowNone = true,
}: {
  state: PasswordProtectState;
  onChange: (next: PasswordProtectState) => void;
  /** Which coins the key is for: a real-bitcoin key needs a stronger password and a lock. */
  network?: AnyNetwork;
  /** Offer "no lock" (test coins). */
  allowNone?: boolean;
  /** Ignored; kept so older call sites still compile. */
  label?: string;
}) {
  const real = network === 'mainnet' || network === 'bitcoin';
  const options: KeyProtection[] = [
    ...(passkeysAvailable() ? (['faceid'] as const) : []),
    'password',
    ...(allowNone && !real ? (['none'] as const) : []),
  ];
  const hint = passwordHint(state.password, network);
  const hintColor = hint.level === 'weak' ? colors.orange : hint.level === 'strong' ? colors.green : colors.sub;
  return (
    <>
      <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <legend style={{ fontSize: 17, color: colors.text, fontFamily: fonts.sans, marginBottom: 6 }}>Lock this key with</legend>
        {options.map(m => (
          <label key={m} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minHeight: 44, fontFamily: fonts.sans, cursor: 'pointer' }}>
            <input type="radio" name="key-protection" checked={state.method === m} onChange={() => onChange({ ...state, method: m })} style={{ marginTop: 5 }} />
            <span>
              <span style={{ fontSize: 17, color: colors.text }}>{CHOICE[m].title}</span>
              <span style={{ display: 'block', fontSize: 15, color: colors.sub, lineHeight: 1.5 }}>{CHOICE[m].detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {state.method === 'password' && (
        <>
          <div>
            <Label>Encryption password</Label>
            <Input
              type="password"
              value={state.password}
              onChange={e => onChange({ ...state, password: e.target.value })}
              required
              minLength={8}
              placeholder="Four unrelated words is ideal"
            />
            <div style={{ fontSize: 15, color: hintColor, marginTop: 6, lineHeight: 1.5, fontFamily: fonts.sans }}>{hint.text}</div>
          </div>
          <div>
            <Label>Confirm password</Label>
            <Input
              type="password"
              value={state.confirm}
              onChange={e => onChange({ ...state, confirm: e.target.value })}
              required
            />
          </div>
        </>
      )}
    </>
  );
}
