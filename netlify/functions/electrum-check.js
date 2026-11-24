/**
 * POST /api/electrum-check  { network, host, port }   (signed in)
 *
 * First contact with a person's own Electrum server
 * (docs/chain-lookups-build-note.md): can this server reach it, is it on the
 * right chain, and what certificate does it show? The device shows that
 * fingerprint, the person confirms it, and only then is the server used --
 * from then on any other certificate is refused. Nothing about the person
 * or the server is stored here.
 */

import { json, requireUser } from "./_auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { overLimit, TOO_MANY } from "./_rate-limit.js";
import { checkUserServer } from "./_electrum.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  if (await overLimit(getSupabaseAdmin(), { name: "electrum-check", event, max: 30, windowSeconds: 3600 })) {
    return json(429, { error: TOO_MANY });
  }
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON" }); }
  if (!["bitcoin", "testnet", "signet"].includes(body.network)) return json(400, { error: "Unknown network" });
  try {
    const r = await checkUserServer({ host: body.host, port: body.port }, body.network);
    if (!r.on_network) {
      return json(400, { error: `That server answered, but it is not on ${body.network}. Pick a server for the network your vault is on.` });
    }
    if (!r.fingerprint) return json(502, { error: "That server did not show a certificate, so it cannot be pinned." });
    return json(200, { ok: true, ...r });
  } catch (e) {
    return json(400, { error: e.message });
  }
}
