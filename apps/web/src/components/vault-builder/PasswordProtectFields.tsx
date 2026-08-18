import { colors, fonts } from '../../theme';
import { Input, Label } from '../ui';

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
export function validatePasswordProtection(state: PasswordProtectState): string | null {
  if (!state.enabled) return null;
  if (state.password.length < 8) return 'Password must be at least 8 characters';
  if (state.password !== state.confirm) return 'Passwords do not match';
  return null;
}

export function PasswordProtectFields({
  state,
  onChange,
  label = 'Password-protect this key (recommended for real funds)',
}: {
  state: PasswordProtectState;
  onChange: (next: PasswordProtectState) => void;
  label?: string;
}) {
  return (
    <>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: colors.sub, fontFamily: fonts.sans }}>
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
              placeholder="Min 8 characters"
            />
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
