// Username accounts: no email (operator, 2026-11-13: "user name password
// with Face ID right after, or email for future proof of getting locked
// out"). Supabase needs an address, so a username maps to a never-mailed
// one at USERNAME_DOMAIN; the account is made confirmed by the server
// (username-signup.js) and signs in with Supabase's own password check.
// Same rules on the server, in netlify/functions/username-signup.js.

export const USERNAME_DOMAIN = 'users.dynastytrust.family';
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,29}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Why this cannot be a username, or null. */
export function usernameProblem(raw: string): string | null {
  const u = normalizeUsername(raw);
  if (u.includes('@')) return 'A username has no @ in it. To use an email address, choose "With email".';
  if (!USERNAME.test(u)) return 'A username is 3 to 30 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.';
  return null;
}

/** What to hand Supabase for a password sign-in: an email as typed, or a
 *  username's address. */
export function signInAddress(typed: string): string {
  const t = typed.trim();
  return t.includes('@') ? t : `${normalizeUsername(t)}@${USERNAME_DOMAIN}`;
}

export function isUsernameAddress(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith('@' + USERNAME_DOMAIN);
}
