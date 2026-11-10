/**
 * mfa-rules.ts -- the pure rules of two-step sign-in. No imports, so
 * scripts/test-mfa.mjs can run them under plain Node. See ./mfa.ts.
 */

export type AalLevel = 'aal1' | 'aal2' | null | undefined;

export type MfaDecision = 'ok' | 'challenge';

/** Does this session still owe a second step? Only when the account has
 *  one set up (nextLevel aal2) and this session has not done it yet. */
export function mfaDecision(currentLevel: AalLevel, nextLevel: AalLevel): MfaDecision {
  return nextLevel === 'aal2' && currentLevel !== 'aal2' ? 'challenge' : 'ok';
}

/** Six digits, nothing else -- spaces a person types are forgiven. */
export function normalizeTotpCode(raw: string): string | null {
  const digits = raw.replace(/\s+/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}
