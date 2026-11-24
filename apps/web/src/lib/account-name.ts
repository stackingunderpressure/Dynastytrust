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

type UserLike = { id?: string; email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined;

// Z4 (operator's chip, 2026-11-24): the name a person goes by stays on
// their phone. Accounts made before keep the name the server had.
const LOCAL_NAME = 'dt:accountName:v1';

/** Keep the chosen name on this phone, for this account. */
export function rememberAccountName(userId: string, name: string | null | undefined): void {
  const n = (name ?? '').trim().slice(0, 40);
  if (!n) return;
  try {
    const all = JSON.parse(localStorage.getItem(LOCAL_NAME) ?? '{}') as Record<string, string>;
    localStorage.setItem(LOCAL_NAME, JSON.stringify({ ...all, [userId]: n }));
  } catch { /* storage blocked: no greeting name */ }
}

function localName(userId: string | undefined): string | null {
  if (!userId) return null;
  try {
    const n = (JSON.parse(localStorage.getItem(LOCAL_NAME) ?? '{}') as Record<string, string>)[userId];
    return typeof n === 'string' && n.trim() ? n.trim() : null;
  } catch {
    return null;
  }
}

/** A short friendly name: the name kept on this phone, else the one an
 *  older account has on the server, else the email's first part. */
export function accountName(user: UserLike): string | null {
  const here = localName(user?.id);
  if (here) return here;
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
