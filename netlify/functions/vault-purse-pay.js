/**
 * vault-purse-pay.js -- the treasurer pays an approved purse payout.
 *
 * GET  /api/vault-purse-pay?vault_id=<uuid>
 *        Every payment on the vault, and what is left of this month's cap
 *        (owner and active members).
 * POST /api/vault-purse-pay  { action: 'start', request_id }
 *        Before the treasurer's wallet is asked to pay. Refused unless the
 *        caller is the purse's treasurer, the request is an approved
 *        Lightning payout, its yeses STILL count when re-checked from
 *        scratch against today's members and rules, it has not been paid,
 *        and it fits under the monthly cap. Starting holds the amount
 *        against the cap. Starting again after an unknown outcome is
 *        allowed and safe: a Lightning invoice can be paid only once.
 * POST { action: 'paid', request_id, preimage, fee_sats }
 *        The wallet's receipt. Counted only if sha256(preimage) is the
 *        request's payment hash -- a value only the person paid could have
 *        handed back. The request becomes fulfilled and the payment is a
 *        ledger milestone, stamped into Bitcoin.
 * POST { action: 'failed', request_id, reason }
 *        The wallet said no. Frees the cap; the request stays approved so
 *        the treasurer can try again.
 *
 * The server never holds the wallet connection and never reads the
 * invoice: it checks, counts and records. The wallet's own budget is the
 * backstop if this software is ever wrong.
 */

import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { recordEvent } from "./_ledger.js";
import { PURSE_DEFAULTS, goodYeses, spentThisMonth } from "./_purse.js";

const HEX64 = /^[0-9a-f]{64}$/;

async function loadPurse(supabase, vaultId) {
  const { data } = await supabase.from("vault_purse").select("settings").eq("vault_id", vaultId).maybeSingle();
  return { ...PURSE_DEFAULTS, ...(data?.settings ?? {}) };
}

async function activeMembers(supabase, vaultId) {
  const { data } = await supabase.from("vault_members").select("id, user_id, status, pubkey").eq("vault_id", vaultId).eq("status", "active");
  return data ?? [];
}

async function payments(supabase, vaultId) {
  const { data } = await supabase.from("purse_payments").select("request_id, vault_id, amount_sats, status, started_by, started_at, preimage, fee_sats, failure, ended_at").eq("vault_id", vaultId);
  return data ?? [];
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    const { data: vault } = await supabase.from("vaults").select("id, user_id").eq("id", vaultId).maybeSingle();
    if (!vault) return json(404, { error: "Vault not found" });
    const members = await activeMembers(supabase, vaultId);
    if (vault.user_id !== u.userId && !members.some((m) => m.user_id === u.userId)) return json(403, { error: "Not a member of this vault" });
    const settings = await loadPurse(supabase, vaultId);
    const list = await payments(supabase, vaultId);
    const spent = spentThisMonth(list);
    return json(200, { ok: true, payments: list, month_spent_sats: spent, month_left_sats: Math.max(0, settings.monthly_cap_sats - spent) });
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const { action, request_id } = body;
  if (!["start", "paid", "failed"].includes(action)) return json(400, { error: "action must be start, paid or failed" });
  if (!request_id) return json(400, { error: "Missing: request_id" });

  const { data: request } = await supabase
    .from("vault_requests")
    .select("id, vault_id, requested_by, amount_sats, road, invoice_sha256, payment_hash, status")
    .eq("id", request_id)
    .maybeSingle();
  if (!request) return json(404, { error: "Request not found" });
  if (request.road !== "lightning") return json(400, { error: "Only a Lightning purse payout is paid here." });

  const members = await activeMembers(supabase, request.vault_id);
  const me = members.find((m) => m.user_id === u.userId);
  if (!me) return json(403, { error: "Not a member of this vault" });
  const settings = await loadPurse(supabase, request.vault_id);
  if (!settings.treasurer_member_id || settings.treasurer_member_id !== me.id) {
    return json(403, { error: "Only the purse's treasurer pays." });
  }

  const { data: existing } = await supabase.from("purse_payments").select("request_id, status, started_by, amount_sats, started_at").eq("request_id", request.id).maybeSingle();

  if (action === "start") {
    if (request.status !== "approved") return json(409, { error: `This request is ${request.status}, not approved.` });
    if (!request.payment_hash) return json(409, { error: "This request has no payment hash, so its receipt could not be checked. File it again." });
    if (existing?.status === "paid") return json(409, { error: "This payout has already been paid." });
    const { data: yeses } = await supabase.from("purse_yeses").select("request_id, member_id, pubkey, sig, target_hash").eq("request_id", request.id);
    const good = goodYeses({ yeses, members, settings, request });
    if (good.length < settings.approvals_needed) {
      return json(409, { error: `Only ${good.length} of the ${settings.approvals_needed} yeses needed still count under today's rules and members.` });
    }
    if (existing?.status === "started") {
      // An earlier attempt's outcome is unknown. Paying the same invoice
      // again cannot pay twice, so let the treasurer try again.
      return json(200, { ok: true, resumed: true });
    }
    const all = await payments(supabase, request.vault_id);
    const spent = spentThisMonth(all.filter((p) => p.request_id !== request.id));
    if (spent + Number(request.amount_sats) > settings.monthly_cap_sats) {
      return json(409, { error: `That would go over the monthly cap: ${Math.max(0, settings.monthly_cap_sats - spent)} sats are left this month.` });
    }
    const row = { request_id: request.id, vault_id: request.vault_id, amount_sats: request.amount_sats, status: "started", started_by: u.userId, started_at: new Date().toISOString(), preimage: null, fee_sats: null, failure: null, ended_at: null };
    const { error } = existing
      ? await supabase.from("purse_payments").update(row).eq("request_id", request.id).eq("status", "failed")
      : await supabase.from("purse_payments").insert(row);
    if (error) {
      if (/duplicate|unique/i.test(error.message || "")) return json(409, { error: "Someone else has just started paying this." });
      return json(500, { error: error.message });
    }
    return json(200, { ok: true, resumed: false, month_left_sats: settings.monthly_cap_sats - spent - Number(request.amount_sats) });
  }

  if (!existing || existing.status !== "started") return json(409, { error: "This payout is not being paid right now." });

  if (action === "failed") {
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : "The wallet refused";
    const { error } = await supabase.from("purse_payments").update({ status: "failed", failure: reason, ended_at: new Date().toISOString() }).eq("request_id", request.id).eq("status", "started");
    if (error) return json(500, { error: error.message });
    await recordEvent(supabase, { vault_id: request.vault_id, user_id: u.userId, event_type: "purse_payment_failed", metadata: { request_id: request.id, amount_sats: request.amount_sats, reason } });
    return json(200, { ok: true });
  }

  // action === "paid"
  const preimage = typeof body.preimage === "string" ? body.preimage.toLowerCase() : "";
  if (!HEX64.test(preimage)) return json(400, { error: "A receipt is a 32-byte preimage in hex." });
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  if (hash !== request.payment_hash) return json(403, { error: "That receipt is not for this invoice." });
  const fee = Number.isSafeInteger(body.fee_sats) && body.fee_sats >= 0 ? body.fee_sats : null;
  const now = new Date().toISOString();
  const { error: pErr } = await supabase.from("purse_payments").update({ status: "paid", preimage, fee_sats: fee, ended_at: now }).eq("request_id", request.id).eq("status", "started");
  if (pErr) return json(500, { error: pErr.message });
  const { error: rErr } = await supabase.from("vault_requests").update({ status: "fulfilled", resolved_by: u.userId, resolved_at: now }).eq("id", request.id);
  if (rErr) return json(500, { error: rErr.message });
  await recordEvent(supabase, {
    vault_id: request.vault_id,
    user_id: u.userId,
    event_type: "purse_payout_paid",
    metadata: { request_id: request.id, amount_sats: request.amount_sats, fee_sats: fee, payment_hash: request.payment_hash, preimage },
  });
  return json(200, { ok: true });
}
