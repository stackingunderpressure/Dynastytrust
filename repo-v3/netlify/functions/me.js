import { requireUser, json } from "./_auth.js";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  return json(200, { ok: true, user_id: u.userId });
}
