// What to call the signed-in person. An account made from a key has a
// never-mailed placeholder address (keys.dynastytrust.family) that must
// never be shown as if it were theirs; it carries the name they chose.

export const PLACEHOLDER_DOMAIN = 'keys.dynastytrust.family';
const USERNAME_DOMAIN = 'users.dynastytrust.family';

/** A never-mailed address: a Tapit-made account, or a username account. */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  const e = (email ?? '').toLowerCase();
  return !!e && (e.endsWith('@' + PLACEHOLDER_DOMAIN) || e.endsWith('@' + USERNAME_DOMAIN));
}

type UserLike = { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined;

/** A short friendly name: the chosen name, else the email's first part. */
export function accountName(user: UserLike): string | null {
  const chosen = user?.user_metadata?.display_name;
  if (typeof chosen === 'string' && chosen.trim()) return chosen.trim();
  const email = user?.email;
  if (!email || isPlaceholderEmail(email)) return null;
  return email.split('@')[0] || null;
}

/** How to describe the account in a sentence: the real email, or the name. */
export function accountLabel(user: UserLike): string {
  const email = user?.email;
  if (email && !isPlaceholderEmail(email)) return email;
  const username = user?.user_metadata?.username;
  if (typeof username === 'string' && username) return `username ${username}`;
  return accountName(user) ?? 'your Tapit wallet';
}
