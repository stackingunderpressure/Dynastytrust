/**
 * _placeholder-guard.js -- threat model item J (docs/threat-model-2026-11-13.md).
 *
 * Username and Tapit accounts live at never-mailed addresses
 * (<name>@users.dynastytrust.family, k-...@keys.dynastytrust.family). Only
 * this app's own functions may make them, and they mark each one in
 * app_metadata, which Supabase's public sign-up cannot set. Anyone else can
 * still call that public sign-up with such an address -- to squat a
 * username, or, while the project auto-confirms email sign-ups, to hold a
 * working login on it. So:
 *   - an account at those addresses without the mark is refused by every
 *     function (requireUser), and
 *   - username-signup.js removes an unmarked squatter on the name and makes
 *     the real account.
 * Kept free of heavy imports: requireUser loads it on every request.
 */

export const KEY_DOMAIN = "keys.dynastytrust.family";
export const USERNAME_DOMAIN = "users.dynastytrust.family";
export const MADE_BY = "dt_made_by";

/** A never-mailed address: a Tapit-made account or a username account. */
export function isPlaceholderEmail(email) {
  if (typeof email !== "string") return false;
  const e = email.trim().toLowerCase();
  return e.endsWith("@" + KEY_DOMAIN) || e.endsWith("@" + USERNAME_DOMAIN);
}

/** app_metadata for an account this app makes at a placeholder address. */
export const madeByUs = which => ({ [MADE_BY]: which });

const marked = appMeta => !!appMeta && typeof appMeta === "object" && typeof appMeta[MADE_BY] === "string" && appMeta[MADE_BY].length > 0;

/**
 * May this token act? true for any ordinary email account and for a
 * placeholder account this app made; false for a placeholder account it
 * did not make; null when that could not be checked (fail closed).
 * `lookupAppMeta(userId)` returns the account's CURRENT app_metadata, used
 * only when the token itself carries no mark (a token minted before the
 * mark was added).
 */
export async function placeholderAccountAllowed(claims, lookupAppMeta) {
  if (!isPlaceholderEmail(claims?.email)) return true;
  if (marked(claims?.app_metadata)) return true;
  try {
    return marked(await lookupAppMeta(claims.sub));
  } catch {
    return null;
  }
}

/** The default lookup: the account as Supabase holds it now. */
export async function currentAppMeta(userId) {
  const { getSupabaseAdmin } = await import("./_supabase.js");
  const { data, error } = await getSupabaseAdmin().auth.admin.getUserById(userId);
  if (error) throw error;
  return data?.user?.app_metadata ?? null;
}
