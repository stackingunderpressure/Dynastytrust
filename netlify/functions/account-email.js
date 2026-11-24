/**
 * account-email.js -- take the email address off an account (zero-knowledge
 * storage Z4; operator's chip 2026-11-24: "offer to remove it").
 *
 * DELETE /api/account-email   (signed in)
 *
 * The account keeps working through the sign-in keys it already holds -- a
 * Face ID key (lib/passkey-account.ts) or a Tapit wallet -- so this is
 * refused until it has at least one: removing the email from an account with
 * no key would lock its owner out. The real address is replaced by a
 * never-mailed placeholder (the same kind key accounts are made with) and the
 * account is marked as made-by-us so the placeholder guard lets it act.
 * Supabase's admin update sends no email to either address.
 *
 * After this there is no reset by email: Face ID or Tapit is the way in.
 */
import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { placeholderEmail, isPlaceholderEmail } from "./_key-account.js";
import { madeByUs } from "./_placeholder-guard.js";

export async function handler(event) {
  if (event.httpMethod !== "DELETE") return json(405, { error: "Method not allowed" });
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  const supabase = getSupabaseAdmin();

  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(u.userId);
  const user = userData?.user;
  if (userErr || !user) return json(500, { error: "Could not load the account" });
  if (!user.email || isPlaceholderEmail(user.email)) return json(400, { error: "This account has no email to remove." });

  const { count, error: keyErr } = await supabase
    .from("wallet_identities")
    .select("pubkey", { count: "exact", head: true })
    .eq("user_id", u.userId);
  if (keyErr) return json(500, { error: keyErr.message });
  if (!count) {
    return json(409, { error: "Add Face ID sign-in (or link Tapit) first. Without one, removing your email would lock you out." });
  }

  const { error: upErr } = await supabase.auth.admin.updateUserById(u.userId, {
    email: placeholderEmail(),
    email_confirm: true,
    app_metadata: { ...(user.app_metadata ?? {}), ...madeByUs("email-removed") },
  });
  if (upErr) return json(500, { error: "Could not remove the email" });
  return json(200, { ok: true });
}
