// What to call the signed-in person. An account made from a key has a
// never-mailed placeholder address (keys.dynastytrust.family) that must
// never be shown as if it were theirs; it carries the name they chose.

export const PLACEHOLDER_DOMAIN = 'keys.dynastytrust.family';

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith('@' + PLACEHOLDER_DOMAIN);
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
  return accountName(user) ?? 'your key';
}
