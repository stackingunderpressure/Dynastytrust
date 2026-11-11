/**
 * Supabase's sign-in errors in the person's words. Shared by the full
 * sign-in screen (pages/Auth.tsx) and the home page's sign-in card
 * (pages/Landing.tsx), which used to show the raw error text.
 */
export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid credentials'))
    return 'Email or password is incorrect.';
  if (m.includes('already registered') || m.includes('already exists'))
    return 'An account with this email already exists. Try signing in instead.';
  if (m.includes('email not confirmed'))
    return 'Confirm your email first -- check your inbox for the 6-digit code.';
  if (m.includes('token has expired') || m.includes('otp_expired'))
    return 'That code has expired. Request a new one.';
  if (m.includes('invalid') && (m.includes('token') || m.includes('otp')))
    return 'That code is incorrect. Check it and try again.';
  if (m.includes('rate') || m.includes('too many'))
    return 'Too many attempts. Wait a minute and try again.';
  return message;
}
