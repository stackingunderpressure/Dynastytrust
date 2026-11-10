/**
 * mfa.ts -- two-step sign-in (TOTP authenticator app) on top of
 * Supabase Auth's MFA.
 *
 * Why: a stolen password alone used to open the account, and an account
 * shows vault structure, balances, addresses, member names and pending
 * requests -- coercion material even though it can move no coins. Once
 * a person turns this on, a password is not enough: the session must be
 * stepped up to "aal2" with a 6-digit code. The server enforces the
 * same rule on every API call (netlify/functions/_auth.js), so the
 * browser check here is the front door, not the wall.
 *
 * The pure rules live in ./mfa-rules.ts (proven by scripts/test-mfa.mjs);
 * this file is the thin wrapper over supabase.auth.mfa.
 */
import { supabase } from './supabase';

import { mfaDecision, normalizeTotpCode, type AalLevel, type MfaDecision } from './mfa-rules';

export { mfaDecision, normalizeTotpCode, type AalLevel, type MfaDecision };

export interface MfaState {
  decision: MfaDecision;
  /** The verified authenticator to challenge, when one exists. */
  factorId: string | null;
  enrolled: boolean;
}

export async function getMfaState(): Promise<MfaState> {
  const [{ data: aal, error: aalErr }, { data: factors, error: facErr }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);
  if (aalErr) throw aalErr;
  if (facErr) throw facErr;
  const verified = (factors?.totp ?? []).find(f => f.status === 'verified') ?? null;
  return {
    decision: mfaDecision(aal?.currentLevel as AalLevel, aal?.nextLevel as AalLevel),
    factorId: verified?.id ?? null,
    enrolled: verified != null,
  };
}

export interface Enrollment {
  factorId: string;
  /** otpauth:// URI -- rendered as a QR for the authenticator app. */
  uri: string;
  /** The same secret as text, for typing it in by hand. */
  secret: string;
}

/** Start setting up an authenticator. Any half-finished earlier attempt
 *  is removed first so a person is never stuck behind a stale one. */
export async function startEnrollment(): Promise<Enrollment> {
  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const f of existing?.all ?? []) {
    if (f.factor_type === 'totp' && f.status !== 'verified') {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
  });
  if (error) throw error;
  return { factorId: data.id, uri: data.totp.uri, secret: data.totp.secret };
}

/** Prove a code from the authenticator. Used both to finish setup and
 *  to step a signed-in session up to aal2. */
export async function verifyCode(factorId: string, rawCode: string): Promise<void> {
  const code = normalizeTotpCode(rawCode);
  if (!code) throw new Error('Enter the 6-digit code from your authenticator app.');
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw new Error(error.message || 'That code did not match. Try the current one.');
}

/** Turn two-step sign-in off. Supabase requires the session to be at
 *  aal2 for this, so it cannot be done with a password alone. */
export async function removeAuthenticator(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
}
