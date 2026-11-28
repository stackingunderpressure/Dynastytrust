/**
 * vault-requests.js -- distribution request queue.
 *
 * GET    /api/vault-requests?vault_id=<uuid>
 *          List requests for a vault (member-only).
 * POST   /api/vault-requests
 *          Body: { vault_id, rule_id?, rule_name?, amount_sats,
 *                  recipient_name?, reason? }
 *          Any active member (beneficiary, trustee, etc.) can
 *          open a request.
 * PATCH  /api/vault-requests?id=<uuid>
 *          Body: { status, resolution_note?, linked_proposal_id? }
 *          Trustees (role in ['owner', 'founder']) only.
 *          Approving or declining stamps resolved_by + _at.
 *
 * Family purse (slice 2): a POST may carry road ('onchain' | 'lightning').
 * A Lightning request also carries the invoice, sealed with the vault key
 * in the browser, and its sha256 fingerprint in the clear; it must fit
 * the purse's per-payout limit and sit below the on-chain threshold, and
 * it lapses after the purse's request_expiry_days. A Lightning request is
 * approved ONLY by the family's signed yeses (/api/vault-purse-yes):
 * a trustee cannot mark it approved here.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { recordEvent } from "./_ledger.js";
import { PURSE_DEFAULTS } from "./_purse.js";

const FIELDS =
  "id, created_at, updated_at, vault_id, requested_by, rule_id, rule_name, amount_sats, recipient_name, reason, status, linked_proposal_id, resolved_by, resolved_at, resolution_note, road, invoice, invoice_sha256, expires_at, payment_hash";

async function membership(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vault_members")
    .select("id, role")
    .eq("vault_id", vaultId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return data;
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    const me = await membership(supabase, vaultId, u.userId);
    if (!me) return json(403, { error: "Not a member of this vault" });

    const { data, error } = await supabase
      .from("vault_requests")
      .select(FIELDS)
      .eq("vault_id", vaultId)
      .order("created_at", { ascending: false });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, requests: data });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
    const { vault_id, rule_id, rule_name, amount_sats, recipient_name, reason } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!amount_sats || amount_sats < 546) {
      return json(400, { error: "amount_sats must be >= 546" });
    }

    const me = await membership(supabase, vault_id, u.userId);
    if (!me) return json(403, { error: "Not a member of this vault" });

    const road = body.road ?? null;
    if (road !== null && road !== "onchain" && road !== "lightning") {
      return json(400, { error: "road must be onchain or lightning" });
    }
    let purseFields = {};
    if (road) {
      const { data: purse } = await supabase.from("vault_purse").select("settings").eq("vault_id", vault_id).maybeSingle();
      const settings = { ...PURSE_DEFAULTS, ...(purse?.settings ?? {}) };
      const days = Number(settings.request_expiry_days) || PURSE_DEFAULTS.request_expiry_days;
      purseFields = { road, expires_at: new Date(Date.now() + days * 86400000).toISOString() };
      if (road === "lightning") {
        if (amount_sats > settings.per_payout_limit_sats) {
          return json(400, { error: `A Lightning payout can be at most ${settings.per_payout_limit_sats} sats.` });
        }
        if (amount_sats >= settings.onchain_threshold_sats) {
          return json(400, { error: `From ${settings.onchain_threshold_sats} sats a payout goes on-chain from the vault.` });
        }
        const sha = typeof body.invoice_sha256 === "string" ? body.invoice_sha256.toLowerCase() : "";
        if (!/^[0-9a-f]{64}$/.test(sha)) return json(400, { error: "A Lightning request needs its invoice fingerprint (invoice_sha256)." });
        if (typeof body.invoice !== "string" || !body.invoice) return json(400, { error: "A Lightning request needs its invoice." });
        if (body.invoice.length > 4000) return json(400, { error: "That invoice is too long." });
        const ph = typeof body.payment_hash === "string" ? body.payment_hash.toLowerCase() : "";
        if (!/^[0-9a-f]{64}$/.test(ph)) return json(400, { error: "A Lightning request needs its invoice's payment hash." });
        purseFields.invoice = body.invoice;
        purseFields.invoice_sha256 = sha;
        purseFields.payment_hash = ph;
      }
    }

    const row = {
      ...purseFields,
      vault_id,
      requested_by: u.userId,
      rule_id: rule_id || null,
      rule_name: rule_name || null,
      amount_sats,
      recipient_name: recipient_name || null,
      reason: reason || null,
      status: "pending",
    };

    const { data, error } = await supabase
      .from("vault_requests")
      .insert(row)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await recordEvent(supabase, {
      vault_id,
      user_id: u.userId,
      event_type: "request_created",
      metadata: {
        request_id: data.id,
        amount_sats,
        rule_name: rule_name || null,
        recipient_name: recipient_name || null,
        road,
      },
    });

    return json(201, { ok: true, request: data });
  }

  if (event.httpMethod === "PATCH") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { data: existing } = await supabase
      .from("vault_requests")
      .select("vault_id, requested_by, status, road")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return json(404, { error: "Request not found" });

    const me = await membership(supabase, existing.vault_id, u.userId);
    if (!me) return json(403, { error: "Not a member of this vault" });

    // Requester can cancel their own pending request.
    // Trustees (owner/founder) can approve/decline/fulfill.
    const isRequester = existing.requested_by === u.userId;
    const isTrustee = me.role === "owner" || me.role === "founder";

    const wantsStatus = body.status;
    // Explicit allowed-transitions table (Kimi K3 scan #15/#49): every
    // status string not listed here is rejected outright (closes the
    // "arbitrary status value" gap -- previously any string not equal to
    // the four checked literals slipped past both role checks below and
    // got written verbatim, stamping resolved_by/resolved_at on
    // gibberish; the DB's own CHECK constraint would reject it too, but
    // as an ugly 500 rather than a clean 400). Each FROM state only
    // allows the transitions that actually make sense: a request can be
    // decided once from pending, an approved request can still be
    // cancelled by its own requester before payout or marked fulfilled
    // by a trustee once paid, and declined/fulfilled/cancelled are all
    // terminal. This also closes the reordering gap the comment above
    // already claimed but never enforced: "requester can cancel their
    // own PENDING request" only ever checked isRequester, never that the
    // request was still pending -- an approved-or-fulfilled distribution
    // could be flipped back to cancelled after the fact.
    const TRANSITIONS = {
      pending:  ["approved", "declined", "cancelled"],
      approved: ["fulfilled", "cancelled"],
    };
    if (wantsStatus !== undefined) {
      const allowedNext = TRANSITIONS[existing.status] ?? [];
      if (!allowedNext.includes(wantsStatus)) {
        return json(409, {
          error: `Cannot move a "${existing.status}" request to "${wantsStatus}". ` +
            (allowedNext.length
              ? `Valid next states: ${allowedNext.join(", ")}.`
              : `This request is already ${existing.status} and cannot be changed further.`),
        });
      }
    }
    if (wantsStatus === "approved" && existing.road === "lightning") {
      return json(403, { error: "A Lightning purse payout is approved only by the family's signed yeses, not by hand." });
    }
    if (wantsStatus === "cancelled" && existing.road === "lightning") {
      const { data: pay } = await supabase.from("purse_payments").select("status").eq("request_id", id).maybeSingle();
      if (pay && pay.status !== "failed") {
        return json(409, { error: "The treasurer has already started paying this, so it cannot be cancelled now." });
      }
    }
    if (wantsStatus === "fulfilled" && existing.road === "lightning") {
      return json(403, { error: "A Lightning purse payout is marked paid only by its receipt, not by hand." });
    }
    if (
      wantsStatus === "cancelled" && !isRequester
    ) {
      return json(403, { error: "Only the requester can cancel" });
    }
    if (
      ["approved", "declined", "fulfilled"].includes(wantsStatus) && !isTrustee
    ) {
      return json(403, { error: "Only trustees can approve, decline, or mark fulfilled" });
    }

    // The note and the linked proposal are part of the decision record.
    // Previously both role checks above were skipped whenever `status`
    // was absent, so any member could rewrite them on any request in any
    // state. Trustees may always set them; the requester only while the
    // request is still pending or as part of cancelling it.
    const touchesRecord = body.resolution_note !== undefined || body.linked_proposal_id !== undefined;
    if (touchesRecord && !isTrustee && !(isRequester && (existing.status === "pending" || wantsStatus === "cancelled"))) {
      return json(403, { error: "Only trustees can edit a request's note or linked proposal" });
    }
    if (body.linked_proposal_id) {
      const { data: lp } = await supabase
        .from("proposals")
        .select("vault_id")
        .eq("id", body.linked_proposal_id)
        .maybeSingle();
      if (!lp || lp.vault_id !== existing.vault_id) {
        return json(400, { error: "linked_proposal_id does not belong to this vault" });
      }
    }

    const allowed = ["status", "resolution_note", "linked_proposal_id"];
    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k)),
    );
    if (wantsStatus && wantsStatus !== "pending") {
      updates.resolved_by = u.userId;
      updates.resolved_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from("vault_requests")
      .update(updates)
      .eq("id", id)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await recordEvent(supabase, {
      vault_id: existing.vault_id,
      user_id: u.userId,
      event_type: `request_${wantsStatus ?? "updated"}`,
      metadata: { request_id: id, resolution_note: updates.resolution_note ?? null },
    });

    return json(200, { ok: true, request: data });
  }

  return json(405, { error: "Method not allowed" });
}
