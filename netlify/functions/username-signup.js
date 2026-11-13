/**
 * username-signup.js -- an account with a username and password, no email
 * (operator, 2026-11-13: "user name password with Face ID right after, or
 * email for future proof of getting locked out"; chips: email, username
 * and Tapit doors).
 *
 * POST /api/username-signup   (no auth -- this CREATES an account)
 *   Body: { username, password, display_name? }
 *
 * The account is made confirmed at <username>@users.dynastytrust.family,
 * an address with no mailbox that nothing ever writes to (proven live
 * 2026-11-13: Supabase makes such an account without sending anything).
 * The browser then signs in with Supabase's own password check. There is
 * no reset: the sign-up screen says so before this is ever called, and the
 * browser holds the password to the strict real-bitcoin rule
 * (lib/password-rules.ts); this function enforces the floor of it.
 */
import { getSupabaseAdmin } from "./_supabase.js";
import { json } from "./_auth.js";
import { cleanDisplayName } from "./_key-account.js";

export const USERNAME_DOMAIN = "users.dynastytrust.family";
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,29}$/;
const FIRST_GUESSES = ["password", "passwort", "bitcoin", "satoshi", "dynastytrust", "dynasty", "qwerty", "letmein", "iloveyou", "welcome", "admin", "123456", "abc123"];

export function usernameProblem(raw) {
  const u = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!USERNAME.test(u)) return "A username is 3 to 30 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.";
  return null;
}

export function passwordFloorProblem(pw, username) {
  if (typeof pw !== "string" || pw.length < 12) return "With no email there is no reset, so the password must be at least 12 characters.";
  if (pw.length > 200) return "That password is too long.";
  const lower = pw.toLowerCase();
  if (new Set(lower).size < 6) return "That password repeats itself too much to be hard to guess.";
  if (FIRST_GUESSES.some(g => lower.includes(g)) || (username && lower.includes(username))) return "That password contains a word or name that is tried first. Choose something else.";
  return null;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON body" }); }
  const uProblem = usernameProblem(body.username);
  if (uProblem) return json(400, { error: uProblem });
  const username = body.username.trim().toLowerCase();
  const pProblem = passwordFloorProblem(body.password, username);
  if (pProblem) return json(400, { error: pProblem });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.admin.createUser({
    email: `${username}@${USERNAME_DOMAIN}`,
    password: body.password,
    email_confirm: true,
    user_metadata: { display_name: cleanDisplayName(body.display_name) ?? username, username, signin: "username" },
  });
  if (error || !data?.user?.id) {
    const taken = /already|registered|exists/i.test(error?.message ?? "");
    return json(taken ? 409 : 500, { error: taken ? "That username is taken. Choose another." : "Could not create the account" });
  }
  return json(200, { ok: true, username });
}
