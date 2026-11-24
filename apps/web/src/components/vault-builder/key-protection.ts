// How a new key is locked on this device (PasswordProtectFields.tsx is the
// control). Operator, 2026-11-24: Face ID by default; a password only where
// the device has no Face ID; no lock for test coins only.
import { passwordProblem } from '../../lib/password-rules';
import { passkeysAvailable } from '../../lib/passkey';

type AnyNetwork = 'mainnet' | 'bitcoin' | 'signet' | 'testnet';

export type KeyProtection = 'faceid' | 'password' | 'none';

export interface PasswordProtectState {
  method: KeyProtection;
  password: string;
  confirm: string;
}

/** Face ID where the device has it; otherwise no lock (test coins) until
 *  the person picks a password. Never a checked password box nobody chose. */
export function defaultProtection(): PasswordProtectState {
  return { method: passkeysAvailable() ? 'faceid' : 'none', password: '', confirm: '' };
}

/** Kept for callers that start from a constant; prefer defaultProtection(). */
export const DEFAULT_PASSWORD_PROTECT_STATE: PasswordProtectState = { method: 'none', password: '', confirm: '' };

/** null = valid. The password rule applies only when a password is chosen. */
export function validatePasswordProtection(state: PasswordProtectState, network: AnyNetwork = 'testnet'): string | null {
  if (state.method === 'none' && (network === 'mainnet' || network === 'bitcoin')) {
    return 'A real-bitcoin key must be locked: choose Face ID or a password.';
  }
  if (state.method !== 'password') return null;
  // The real rule lives in lib/password-rules.ts (and is enforced again
  // in keystore.ts); a real-bitcoin key asks for more than a test key.
  const weak = passwordProblem(state.password, network);
  if (weak) return weak;
  if (state.password !== state.confirm) return 'Passwords do not match';
  return null;
}

