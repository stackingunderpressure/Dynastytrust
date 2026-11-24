/**
 * vault-keys.js -- stores and hands out wrapped vault keys (zero-knowledge
 * storage, docs/zero-knowledge-storage-plan.md, Z1 slice 1). The server only
 * ever sees wraps it cannot open (lib/messaging.ts EncryptedMessage to one
 * member's X25519 messaging key) and a public check value.
 *
 * GET  /api/vault-keys?vault_id=<uuid>                       (active member)
 *   -> { version, owner_user_id, checks, mine: [{version, wrap}],
 *        current_holders: [{user_id, pubkey}], members: [{user_id, messaging_pubkey}] }
 *   current_holders names the messaging pubkey each current wrap was made
 *   to, so a member who moved to a new device (new messaging key) is seen
 *   as not holding the key and gets it shared again.
 *
 * POST /api/vault-keys                                      (active member)
 *   body: { vault_id, version, check?, wraps: [{ recipient_user_id, wrap }] }
 *   - version === current: share the current key with members who lack it.
 *   - version === current + 1: OWNER ONLY, with `check`; creates the first key
 *     or replaces it after a member left. Bumps vaults.vault_key_version.
 *   Every recipient must be an active member, every wrap must name exactly
 *   that recipient, and its sender_pubkey must be the CALLER's own published
 *   messaging pubkey (so a bad wrap is always traceable to who posted it).
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const MAX_WRAPS = 200;
const isHex = (s, len) => typeof s === "string" && s.length === len && /^[0-9a-f]+$/.test(s);

export function validWrap(wrap, recipientUserId, senderPubkey) {
  if (!wrap || typeof wrap !== "object") return false;
  if (wrap.sender_pubkey !== senderPubkey) return false;
  if (typeof wrap.nonce !== "string" || typeof wrap.ciphertext !== "string") return false;
  if (wrap.ciphertext.length > 4096) return false;
  if (!Array.isArray(wrap.recipients) || wrap.recipients.length !== 1) return false;
  const r = wrap.recipients[0];
  return r && r.user_id === recipientUserId && isHex(r.pubkey, 64)
    && typeof r.wrap_nonce === "string" && typeof r.wrapped_key === "string";
}

async function activeMembers(supabase, vaultId) {
  const { data } = await supabase
    .from("vault_members")
    .select("user_id, messaging_pubkey, status")
    .eq("vault_id", vaultId)
    .eq("status", "active");
  return (data ?? []).filter((m) => m.user_id);
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    const members = await activeMembers(supabase, vaultId);
    if (!members.some((m) => m.user_id === u.userId)) return json(403, { error: "Not a member of this vault" });
    const { data: vault } = await supabase
      .from("vaults")
      .select("id, user_id, vault_key_version, vault_key_checks")
      .eq("id", vaultId)
      .maybeSingle();
    if (!vault) return json(404, { error: "Vault not found" });
    const { data: rows } = await supabase
      .from("vault_keys")
      .select("version, recipient_user_id, recipient_pubkey, wrap")
      .eq("vault_id", vaultId);
    const all = rows ?? [];
    return json(200, {
      ok: true,
      version: vault.vault_key_version ?? 0,
      owner_user_id: vault.user_id,
      checks: vault.vault_key_checks ?? {},
      mine: all.filter((r) => r.recipient_user_id === u.userId).map((r) => ({ version: r.version, wrap: r.wrap })),
      current_holders: all
        .filter((r) => r.version === vault.vault_key_version)
        .map((r) => ({ user_id: r.recipient_user_id, pubkey: r.recipient_pubkey })),
      members: members.map((m) => ({ user_id: m.user_id, messaging_pubkey: m.messaging_pubkey ?? null })),
    });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
    const { vault_id, version, check, wraps } = body;
    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!Number.isInteger(version) || version < 1) return json(400, { error: "Invalid version" });
    if (!Array.isArray(wraps) || wraps.length === 0 || wraps.length > MAX_WRAPS) return json(400, { error: "Invalid wraps" });

    const members = await activeMembers(supabase, vault_id);
    const me = members.find((m) => m.user_id === u.userId);
    if (!me) return json(403, { error: "Not a member of this vault" });
    if (!isHex(me.messaging_pubkey, 64)) return json(409, { error: "Publish your messaging key first" });

    const { data: vault } = await supabase
      .from("vaults")
      .select("id, user_id, vault_key_version, vault_key_checks")
      .eq("id", vault_id)
      .maybeSingle();
    if (!vault) return json(404, { error: "Vault not found" });
    const current = vault.vault_key_version ?? 0;

    const activeIds = new Set(members.map((m) => m.user_id));
    for (const w of wraps) {
      if (!w || !activeIds.has(w.recipient_user_id)) return json(400, { error: "Every recipient must be an active member" });
      if (!validWrap(w.wrap, w.recipient_user_id, me.messaging_pubkey)) return json(400, { error: "Invalid wrap" });
    }

    if (version === current + 1) {
      if (vault.user_id !== u.userId) return json(403, { error: "Only the vault owner can create or replace the vault key" });
      if (!isHex(check, 32)) return json(400, { error: "Missing: check" });
      if (!wraps.some((w) => w.recipient_user_id === u.userId)) return json(400, { error: "The owner must hold the new key" });
      const checks = { ...(vault.vault_key_checks ?? {}), [String(version)]: check };
      // Conditional on the version we read, so two tabs can't both bump it.
      const { data: bumped, error: bumpErr } = await supabase
        .from("vaults")
        .update({ vault_key_version: version, vault_key_checks: checks })
        .eq("id", vault_id)
        .eq("vault_key_version", current)
        .select("id");
      if (bumpErr) return json(500, { error: bumpErr.message });
      if (!bumped || bumped.length === 0) return json(409, { error: "The vault key changed meanwhile; reload" });
    } else if (version !== current) {
      return json(409, { error: "Stale vault key version; reload" });
    }

    const rows = wraps.map((w) => ({
      vault_id,
      version,
      recipient_user_id: w.recipient_user_id,
      recipient_pubkey: w.wrap.recipients[0].pubkey,
      created_by: u.userId,
      wrap: w.wrap,
    }));
    const { error } = await supabase
      .from("vault_keys")
      .upsert(rows, { onConflict: "vault_id,version,recipient_user_id,recipient_pubkey,created_by", ignoreDuplicates: true });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, version });
  }

  return json(405, { error: "Method not allowed" });
}
