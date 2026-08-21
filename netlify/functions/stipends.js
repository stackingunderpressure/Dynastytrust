/**
 * stipends.js -- scheduled distribution schedule.
 *
 * GET    /api/stipends?vault_id=<uuid>       list (member-only)
 * POST   /api/stipends                       create (owner only)
 *          body: { vault_id, name, recipient_name?, destination?,
 *                  rule_id?, amount_sats, interval_kind,
 *                  starts_at? (ISO) }
 * PATCH  /api/stipends?id=<uuid>             update (owner only)
 *          body: any editable field, including active / next_due_at
 * DELETE /api/stipends?id=<uuid>             remove (owner only)
 *
 * The trustee UI advances next_due_at after a successful broadcast
 * via PATCH so the schedule tracks completion without a cron.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const FIELDS =
  "id, created_at, updated_at, vault_id, name, recipient_name, destination, rule_id, amount_sats, interval_kind, next_due_at, last_proposed_at, last_proposal_id, active";

const INTERVALS = ["weekly", "monthly", "quarterly", "annually"];

// Mirrors VaultDetail.tsx's advanceDueDate exactly -- the one legitimate
// use a non-owner member has for writing next_due_at is bumping it
// forward by one interval right after a broadcast, so the server
// recomputes that same value independently rather than trusting
// whatever timestamp the client sent.
function advanceDueDate(from, interval) {
  const d = new Date(from.getTime());
  if (interval === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (interval === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (interval === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (interval === "annually") d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

async function assertOwner(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vaults")
    .select("id")
    .eq("id", vaultId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function assertMember(supabase, vaultId, userId) {
  const { data } = await supabase
    .from("vault_members")
    .select("id")
    .eq("vault_id", vaultId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return !!data;
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    if (!(await assertMember(supabase, vaultId, u.userId))) {
      return json(403, { error: "Not a member of this vault" });
    }
    const { data, error } = await supabase
      .from("scheduled_stipends")
      .select(FIELDS)
      .eq("vault_id", vaultId)
      .order("next_due_at", { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, stipends: data });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
    const { vault_id, name, amount_sats, interval_kind } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!name) return json(400, { error: "Missing: name" });
    if (!amount_sats || amount_sats < 546) {
      return json(400, { error: "amount_sats must be >= 546" });
    }
    if (!INTERVALS.includes(interval_kind)) {
      return json(400, { error: "interval_kind must be one of: " + INTERVALS.join(", ") });
    }
    if (!(await assertOwner(supabase, vault_id, u.userId))) {
      return json(403, { error: "Only the primary trustee can create stipends" });
    }

    const next_due_at = body.starts_at
      ? new Date(body.starts_at).toISOString()
      : new Date().toISOString();

    const row = {
      vault_id,
      name,
      recipient_name: body.recipient_name || null,
      destination: body.destination || null,
      rule_id: body.rule_id || null,
      amount_sats,
      interval_kind,
      next_due_at,
      active: true,
    };

    const { data, error } = await supabase
      .from("scheduled_stipends")
      .insert(row)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id,
      user_id: u.userId,
      event_type: "stipend_created",
      metadata: { stipend_id: data.id, name, amount_sats, interval_kind },
    });

    return json(201, { ok: true, stipend: data });
  }

  if (event.httpMethod === "PATCH") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing: id" });
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { data: existing } = await supabase
      .from("scheduled_stipends")
      .select("vault_id, interval_kind")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return json(404, { error: "Stipend not found" });

    // Owner edits schedule. Any active member can bump next_due_at
    // + last_proposed_at + last_proposal_id (after broadcast).
    const ownerAllowed = [
      "name", "recipient_name", "destination", "rule_id",
      "amount_sats", "interval_kind", "next_due_at", "active",
    ];
    const memberAllowed = ["next_due_at", "last_proposed_at", "last_proposal_id"];
    const isOwner = await assertOwner(supabase, existing.vault_id, u.userId);
    const isMember = isOwner || (await assertMember(supabase, existing.vault_id, u.userId));
    if (!isMember) return json(403, { error: "Not a member of this vault" });

    const allowed = isOwner ? ownerAllowed : memberAllowed;
    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k)),
    );

    // A non-owner member's only legitimate reason to touch next_due_at is
    // bumping it forward by one interval right after a broadcast --
    // VaultDetail.tsx's advanceDueDate does exactly that client-side.
    // Without this check any active member could set next_due_at to any
    // arbitrary date: far in the future to indefinitely stall a
    // stipend's payout, or in the past to make it look immediately due
    // (Kimi K3 scan #55). Recompute the expected advance server-side and
    // require the client's value to land within a day of it -- tight
    // enough to reject an arbitrary jump, loose enough to absorb normal
    // client/server clock skew and request latency.
    if (!isOwner && updates.next_due_at) {
      const expected = advanceDueDate(new Date(), existing.interval_kind).getTime();
      const got = Date.parse(updates.next_due_at);
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      if (!Number.isFinite(got) || Math.abs(got - expected) > ONE_DAY_MS) {
        return json(400, {
          error: "next_due_at must be the next scheduled occurrence (one interval from now), not an arbitrary date.",
        });
      }
    }

    if (!Object.keys(updates).length) {
      return json(400, { error: `No editable fields provided. Allowed: ${allowed.join(", ")}` });
    }
    if (updates.interval_kind && !INTERVALS.includes(updates.interval_kind)) {
      return json(400, { error: "Invalid interval_kind" });
    }

    const { data, error } = await supabase
      .from("scheduled_stipends")
      .update(updates)
      .eq("id", id)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, stipend: data });
  }

  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing: id" });
    const { data: existing } = await supabase
      .from("scheduled_stipends")
      .select("vault_id")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return json(404, { error: "Stipend not found" });
    if (!(await assertOwner(supabase, existing.vault_id, u.userId))) {
      return json(403, { error: "Only the primary trustee can delete stipends" });
    }
    const { error } = await supabase.from("scheduled_stipends").delete().eq("id", id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
