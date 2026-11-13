import { colors, fonts } from '../../theme';
import { Input, Label } from '../ui';
import { passwordHint, passwordProblem } from '../../lib/password-rules';

type AnyNetwork = 'mainnet' | 'bitcoin' | 'signet' | 'testnet';

// The one password-protection control block for key generation, shared
// by KeyManager's standalone "New key" flow and VaultWizard's inline
// per-role key creation -- previously two separate hand-typed copies that
// had already drifted (VaultWizard's version had no confirm-password
// field at all). One implementation now, so there is exactly one place
// this can be wrong.

export interface PasswordProtectState {
  enabled: boolean;
  password: string;
  confirm: string;
}

// Defaults unchecked everywhere this control appears. A checked-by-default
// password field is how a key ends up encrypted with a password nobody
// remembers choosing -- the real root cause behind an earlier live bug
// (VaultWizard's own checkbox defaulted true). Real-funds guidance is
// still the label text; the default itself no longer assumes it.
export const DEFAULT_PASSWORD_PROTECT_STATE: PasswordProtectState = {
  enabled: false,
  password: '',
  confirm: '',
};

/** null = valid. Enforces the same min-length + match rule everywhere this control appears. */
export function validatePasswordProtection(state: PasswordProtectState, network: AnyNetwork = 'testnet'): string | null {
  if (!state.enabled) return null;
  // The real rule lives in lib/password-rules.ts (and is enforced again
  // in keystore.ts); a real-bitcoin key asks for more than a test key.
  const weak = passwordProblem(state.password, network);
  if (weak) return weak;
  if (state.password !== state.confirm) return 'Passwords do not match';
  return null;
}

export function PasswordProtectFields({
  state,
  onChange,
  label = 'Password-protect this key (recommended for real funds)',
  network = 'testnet',
}: {
  state: PasswordProtectState;
  onChange: (next: PasswordProtectState) => void;
  label?: string;
  /** Which coins the key is for: a real-bitcoin key needs a stronger password. */
  network?: AnyNetwork;
}) {
  const hint = passwordHint(state.password, network);
  const hintColor = hint.level === 'weak' ? colors.orange : hint.level === 'strong' ? colors.green : colors.sub;
  return (
    <>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 17, color: colors.sub, fontFamily: fonts.sans }}>
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={e => onChange({ ...state, enabled: e.target.checked })}
        />
        {label}
      </label>
      {state.enabled && (
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
