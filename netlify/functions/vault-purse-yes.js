/**
 * vault-purse-yes.js -- a family member's signed yes to a Lightning payout.
 *
 * GET  /api/vault-purse-yes?vault_id=<uuid>
 *        Every yes on the vault's requests (owner and active members).
 * POST /api/vault-purse-yes
 *        Body: { request_id, signature, pubkey }.
 *
 * A yes counts only when ALL of these hold, checked here, never trusted
 * from the browser:
 *  - the request is a pending Lightning purse request that has not lapsed;
 *  - the caller is an active member with a registered vault key, and the
 *    signing key IS that key (x-only);
 *  - the caller may vote (the purse's voters, or everyone) and is not the
 *    person being paid;
 *  - the Schnorr signature verifies as a DT-ATT-v1 'purse_payout_yes' over
 *    THIS request's vault, id, amount, road and invoice fingerprint,
 *    recomputed here from the stored row;
 *  - the member has not already said yes (one yes per member per request).
 * When the yeses reach the purse's number, the request becomes 'approved'
 * and that is sealed into the vault ledger and anchored at once.
 * Paying it is the treasurer's step (next slice).
 */

import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { recordEvent } from "./_ledger.js";
import { verifyAttestationSignature } from "./_attest.js";
import { PURSE_DEFAULTS, YES_TYPE, canVote, payoutTargetText } from "./_purse.js";

const HEX = (s, n) => typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`, "i").test(s);
const xOnly = (k) => {
  const s = String(k ?? "").toLowerCase();
  return /^0[23][0-9a-f]{64}$/.test(s) ? s.slice(2) : s;
};

async function isMember(supabase, vaultId, userId) {
  const { data: vault } = await supabase.from("vaults").select("id, user_id").eq("id", vaultId).maybeSingle();
  if (!vault) return false;
  if (vault.user_id === userId) return true;
  const { data } = await supabase.from("vault_members").select("id").eq("vault_id", vaultId).eq("user_id", userId).eq("status", "active").maybeSingle();
  return Boolean(data);
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    if (!(await isMember(supabase, vaultId, u.userId))) return json(403, { error: "Not a member of this vault" });
    const { data, error } = await supabase
      .from("purse_yeses")
      .select("id, request_id, member_id, user_id, pubkey, sig, target_hash, created_at")
      .eq("vault_id", vaultId);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, yeses: data ?? [] });
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const { request_id, signature, pubkey } = body;
  if (!request_id) return json(400, { error: "Missing: request_id" });
  if (!HEX(signature, 128) || !HEX(pubkey, 64)) return json(400, { error: "A yes needs a 64-byte signature and a 32-byte key" });

  const { data: request } = await supabase
    .from("vault_requests")
    .select("id, vault_id, requested_by, amount_sats, road, invoice_sha256, status, expires_at")
    .eq("id", request_id)
    .maybeSingle();
  if (!request) return json(404, { error: "Request not found" });
  if (request.road !== "lightning") return json(400, { error: "Only a Lightning purse payout takes a family yes here; on-chain payouts are signed in the vault." });
  if (request.status !== "pending") return json(409, { error: `This request is already ${request.status}.` });
  if (request.expires_at && new Date(request.expires_at).getTime() < Date.now()) return json(409, { error: "This request has lapsed." });

  const { data: member } = await supabase
    .from("vault_members")
    .select("id, user_id, status, pubkey")
    .eq("vault_id", request.vault_id)
    .eq("user_id", u.userId)
    .eq("status", "active")
    .maybeSingle();
  if (!member) return json(403, { error: "Not a member of this vault" });
  if (!member.pubkey) return json(403, { error: "You have no vault key yet, so your yes cannot be signed." });
  if (pubkey.toLowerCase() !== xOnly(member.pubkey)) return json(403, { error: "That is not your vault key." });

  const { data: purse } = await supabase.from("vault_purse").select("settings").eq("vault_id", request.vault_id).maybeSingle();
  const settings = { ...PURSE_DEFAULTS, ...(purse?.settings ?? {}) };
  if (!canVote(settings, member, request)) {
    return json(403, { error: member.user_id === request.requested_by ? "You cannot say yes to your own payout." : "You are not one of the purse's voters." });
  }

  const targetHash = createHash("sha256").update(payoutTargetText({ vault_id: request.vault_id, request_id: request.id, amount_sats: request.amount_sats, road: request.road, invoice_sha256: request.invoice_sha256 }), "utf8").digest("hex");
  if (!verifyAttestationSignature({ attestationType: YES_TYPE, targetHash, signature: signature.toLowerCase(), pubkey: pubkey.toLowerCase() })) {
    return json(403, { error: "That yes was not signed for this exact payout." });
  }

  const { error: insErr } = await supabase.from("purse_yeses").insert({
    request_id: request.id,
    vault_id: request.vault_id,
    member_id: member.id,
    user_id: u.userId,
    pubkey: pubkey.toLowerCase(),
    sig: signature.toLowerCase(),
    target_hash: targetHash,
  });
  if (insErr) {
    if (/duplicate|unique/i.test(insErr.message || "")) return json(409, { error: "You have already said yes to this payout." });
    return json(500, { error: insErr.message });
  }
  await recordEvent(supabase, { vault_id: request.vault_id, user_id: u.userId, event_type: "purse_yes", metadata: { request_id: request.id, amount_sats: request.amount_sats } });

  const { data: all } = await supabase.from("purse_yeses").select("member_id, target_hash").eq("request_id", request.id);
  const count = new Set((all ?? []).filter((y) => y.target_hash === targetHash).map((y) => y.member_id)).size;
  let status = "pending";
  if (count >= settings.approvals_needed) {
    const { error: upErr } = await supabase
      .from("vault_requests")
      .update({ status: "approved", resolved_at: new Date().toISOString() })
      .eq("id", request.id)
      .eq("status", "pending");
    if (upErr) return json(500, { error: upErr.message });
    status = "approved";
    await recordEvent(supabase, { vault_id: request.vault_id, user_id: u.userId, event_type: "purse_payout_approved", metadata: { request_id: request.id, amount_sats: request.amount_sats, yeses: count } });
  }
  return json(200, { ok: true, yeses: count, needed: settings.approvals_needed, status });
}
