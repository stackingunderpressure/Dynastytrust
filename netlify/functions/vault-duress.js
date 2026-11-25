/**
 * /api/vault-duress -- a wellness checker's duress stops the whole circle
 * (docs/wellness-group-build-note.md, slice 2; operator, 2026-11-25:
 * "Straight to the server", "Owner + circle quorum").
 *
 * POST { notice: { kind: 'raise'|'clear', descriptor, signed_at, pubkey, sig } }
 *   From a member's Tapit, no account: accepted ONLY if the signature
 *   verifies (_duress.js noticeProblem) and the key accepted membership in
 *   the vault with that descriptor. 'raise' puts the vault on hold at once
 *   (vaults.duress -- every DynastyTrust signing path already refuses on it)
 *   and records it in the vault's history. 'clear' counts toward lifting.
 * POST { vault_id, action: 'owner_clear' }  (signed in, the vault's owner)
 *   The owner's half of lifting a circle hold.
 * GET ?descriptor=...  -> where the hold stands, for Tapit before it signs.
 * GET ?vault_id=...    (signed in, owner or member) -> the same, for the page.
 *
 * A hold lifts only when, after the latest raise, the owner has asked AND
 * the circle's quorum of members has each signed a clear -- because the
 * owner may be the one under pressure. The owner's own halt switch cannot
 * lift a circle hold (vaults.js).
 *
 * Cross-site: answers Tapit's site only (TAPIT_ORIGIN, default
 * https://tapit-wallet.netlify.app).
 */

import { json, requireUser } from "./_auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { overLimit, TOO_MANY } from "./_rate-limit.js";
import { recordEvent } from "./_ledger.js";
import { noticeProblem, holdState, clearQuorum, acceptedMembers, noticesOf } from "./_duress.js";

const ORIGIN = process.env.TAPIT_ORIGIN || "https://tapit-wallet.netlify.app";

function withCors(event, res) {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (origin !== ORIGIN) return res;
  return { ...res, headers: { ...res.headers, "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "Origin" } };
}

async function vaultBy(supabase, column, value) {
  const { data, error } = await supabase.from("vaults").select("id, user_id, status, descriptor, duress, leaves").eq(column, value).neq("status", "draft").limit(2);
  if (error) throw new Error(error.message);
  return data?.length === 1 ? data[0] : null;
}

async function standing(supabase, vault) {
  const [notices, members] = await Promise.all([noticesOf(supabase, vault.id), acceptedMembers(supabase, vault.id)]);
  const s = holdState(notices, members, clearQuorum(vault));
  return { held: !!vault.duress, circle_hold: s.open, clears: s.clears, needed: s.needed, owner_cleared: s.ownerCleared, raised_at: s.raisedAt ?? null };
}

async function liftIfDone(supabase, vault) {
  const s = await standing(supabase, vault);
  if (!s.circle_hold && vault.duress && s.raised_at) {
    await supabase.from("vaults").update({ duress: false }).eq("id", vault.id);
    await recordEvent(supabase, { vault_id: vault.id, user_id: vault.user_id, event_type: "duress_cleared", metadata: { by: "owner and circle", clears: s.clears } });
    return { ...s, held: false };
  }
  return s;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return withCors(event, { statusCode: 204, headers: {}, body: "" });
  const supabase = getSupabaseAdmin();
  try {
    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      if (q.descriptor) {
        const vault = await vaultBy(supabase, "descriptor", q.descriptor);
        if (!vault) return withCors(event, json(404, { error: "Vault not found" }));
        return withCors(event, json(200, { ok: true, ...(await standing(supabase, vault)) }));
      }
      const u = await requireUser(event);
      if (u.error) return json(401, { error: u.error });
      const vault = await vaultBy(supabase, "id", q.vault_id);
      if (!vault) return json(404, { error: "Vault not found" });
      if (vault.user_id !== u.userId) {
        const { data: m } = await supabase.from("vault_members").select("id").eq("vault_id", vault.id).eq("user_id", u.userId).eq("status", "active").maybeSingle();
        if (!m) return json(404, { error: "Vault not found" });
      }
      return json(200, { ok: true, ...(await standing(supabase, vault)) });
    }
    if (event.httpMethod !== "POST") return withCors(event, json(405, { error: "Method not allowed" }));
    if (await overLimit(supabase, { name: "vault-duress", event, max: 30, windowSeconds: 3600 })) return withCors(event, json(429, { error: TOO_MANY }));
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return withCors(event, json(400, { error: "Invalid JSON" })); }

    if (body.action === "owner_clear") {
      const u = await requireUser(event);
      if (u.error) return json(401, { error: u.error });
      const vault = await vaultBy(supabase, "id", body.vault_id);
      if (!vault || vault.user_id !== u.userId) return json(404, { error: "Vault not found" });
      if (!(await standing(supabase, vault)).circle_hold) return json(409, { error: "There is no circle hold on this vault." });
      const { error } = await supabase.from("vault_duress_notices").insert({ vault_id: vault.id, kind: "owner_clear" });
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true, ...(await liftIfDone(supabase, vault)) });
    }

    const n = body.notice;
    const problem = noticeProblem(n);
    if (problem) return withCors(event, json(400, { error: `Notice refused: ${problem}.` }));
    const vault = await vaultBy(supabase, "descriptor", n.descriptor);
    if (!vault) return withCors(event, json(404, { error: "Vault not found" }));
    const members = await acceptedMembers(supabase, vault.id);
    if (!members.includes(n.pubkey.toLowerCase())) return withCors(event, json(403, { error: "That key is not an accepted member of this vault." }));
    const { error } = await supabase.from("vault_duress_notices").insert({
      vault_id: vault.id, kind: n.kind, signer_pubkey: n.pubkey.toLowerCase(), sig: n.sig.toLowerCase(), signed_at: n.signed_at,
    });
    if (error) return withCors(event, json(/duplicate|unique/i.test(error.message) ? 409 : 500, { error: /duplicate|unique/i.test(error.message) ? "That notice was already used." : error.message }));
    if (n.kind === "raise") {
      if (!vault.duress) await supabase.from("vaults").update({ duress: true }).eq("id", vault.id);
      await recordEvent(supabase, { vault_id: vault.id, user_id: vault.user_id, event_type: "duress_raised", metadata: { by: "circle", signer: n.pubkey.slice(0, 12) } });
      return withCors(event, json(200, { ok: true, ...(await standing(supabase, { ...vault, duress: true })) }));
    }
    return withCors(event, json(200, { ok: true, ...(await liftIfDone(supabase, vault)) }));
  } catch (e) {
    return withCors(event, json(500, { error: e instanceof Error ? e.message : "Failed" }));
  }
}
