/**
 * _rate-limit.js -- threat model item H. Coarse per-IP limits on the
 * signed-out endpoints, counted in the database (rate_hit, migration
 * 20261113050000) so every function instance shares one count.
 *
 * Fails OPEN on a database error: a limiter outage must not lock every
 * family out of signing in; it only stops slowing down a flood.
 */

/** The caller's address as Netlify reports it. */
export function clientIp(event) {
  const h = event?.headers ?? {};
  return String(h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || "unknown").trim();
}

/**
 * Count one request; true when this caller is over `max` in the window.
 * Now and then also clears old windows and expired challenges.
 */
export async function overLimit(supabase, { name, event, max, windowSeconds }) {
  try {
    const { data, error } = await supabase.rpc("rate_hit", { p_bucket: `${name}:${clientIp(event)}`, p_window_seconds: windowSeconds });
    if (error) { console.error("[rate-limit] count failed, not limiting:", error.message); return false; }
    if (Math.random() < 0.02) await supabase.rpc("rate_housekeeping");
    return Number(data) > max;
  } catch (e) {
    console.error("[rate-limit] count failed, not limiting:", e?.message || e);
    return false;
  }
}

export const TOO_MANY = "Too many attempts from this connection. Wait a few minutes and try again.";
