/**
 * vault-purse.js -- the family purse's rules for one vault.
 *
 * GET  /api/vault-purse?vault_id=<uuid>
 *        The settings (defaults if none saved yet), who may change them,
 *        and the active members to pick voters and a treasurer from.
 *        Owner and active members.
 * PUT  /api/vault-purse
 *        Body: { vault_id, settings }. The vault owner only, and only
 *        while governance is 'owner'. After the handover a change needs
 *        the family's yeses (a later slice) and this refuses it.
 * POST /api/vault-purse
 *        Body: { vault_id, action: 'handover' }. The vault owner hands the
 *        rules to the family. One-way: nothing here turns it back.
 *
 * Every change is sealed into the vault's ledger with who and when, and
 * anchored to Bitcoin at once (_anchor.js milestones). Operator,
 * 2026-11-28: "Game master sets it at the start, family vote later."
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { recordEvent } from "./_ledger.js";
import { PURSE_DEFAULTS, changedKeys, validatePurseSettings } from "./_purse.js";

async function load(supabase, vaultId, userId) {
  const { data: vault } = await supabase.from("vaults").select("id, user_id").eq("id", vaultId).maybeSingle();
  if (!vault) return { error: json(404, { error: "Vault not found" }) };
  const { data: members, error } = await supabase
    .from("vault_members")
    .select("id, user_id, role, label")
    .eq("vault_id", vaultId)
    .eq("status", "active");
  if (error) return { error: json(500, { error: error.message }) };
  const isOwner = vault.user_id === userId;
  if (!isOwner && !(members ?? []).some((m) => m.user_id === userId)) return { error: json(403, { error: "Not a member of this vault" }) };
  const { data: row } = await supabase.from("vault_purse").select("settings, governance, handed_over_at, updated_at").eq("vault_id", vaultId).maybeSingle();
  return { vault, members: members ?? [], isOwner, row };
}

function view(ctx) {
  return {
    ok: true,
    saved: Boolean(ctx.row),
    settings: { ...PURSE_DEFAULTS, ...(ctx.row?.settings ?? {}) },
    governance: ctx.row?.governance ?? "owner",
    handed_over_at: ctx.row?.handed_over_at ?? null,
    updated_at: ctx.row?.updated_at ?? null,
    can_edit: ctx.isOwner && (ctx.row?.governance ?? "owner") === "owner",
    is_owner: ctx.isOwner,
    members: ctx.members.map((m) => ({ id: m.id, label: m.label ?? null, role: m.role })),
  };
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    const ctx = await load(supabase, vaultId, u.userId);
    if (ctx.error) return ctx.error;
    return json(200, view(ctx));
  }

  if (event.httpMethod !== "PUT" && event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  if (!body.vault_id) return json(400, { error: "Missing: vault_id" });
  const ctx = await load(supabase, body.vault_id, u.userId);
  if (ctx.error) return ctx.error;
  if (!ctx.isOwner) return json(403, { error: "Only the vault owner can change the purse rules before they are handed to the family." });
  const governance = ctx.row?.governance ?? "owner";
  if (governance === "family") {
    return json(409, { error: "The rules belong to the family now. A change needs the family's yeses." });
  }
  const before = { ...PURSE_DEFAULTS, ...(ctx.row?.settings ?? {}) };
  const now = new Date().toISOString();

  if (event.httpMethod === "PUT") {
    const v = validatePurseSettings(body.settings, ctx.members.map((m) => m.id));
    if (!v.ok) return json(400, { error: v.error });
    const changed = changedKeys(before, v.settings);
    const { error } = await supabase
      .from("vault_purse")
      .upsert({ vault_id: body.vault_id, settings: v.settings, governance: "owner", updated_at: now, updated_by: u.userId }, { onConflict: "vault_id" });
    if (error) return json(500, { error: error.message });
    await recordEvent(supabase, { vault_id: body.vault_id, user_id: u.userId, event_type: "purse_rules_set", metadata: { changed, settings: v.settings } });
    return json(200, view({ ...ctx, row: { settings: v.settings, governance: "owner", handed_over_at: null, updated_at: now } }));
  }

  if (body.action !== "handover") return json(400, { error: "Unknown action" });
  if (body.confirm !== true) return json(400, { error: "Confirm the handover: it cannot be undone." });
  const { error } = await supabase
    .from("vault_purse")
    .upsert(
      { vault_id: body.vault_id, settings: before, governance: "family", handed_over_at: now, handed_over_by: u.userId, updated_at: now, updated_by: u.userId },
      { onConflict: "vault_id" },
    );
  if (error) return json(500, { error: error.message });
  await recordEvent(supabase, { vault_id: body.vault_id, user_id: u.userId, event_type: "purse_rules_handed_to_family", metadata: { settings: before } });
  return json(200, view({ ...ctx, row: { settings: before, governance: "family", handed_over_at: now, updated_at: now } }));
}
