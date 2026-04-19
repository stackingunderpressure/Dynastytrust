/**
 * vault-attestations.js -- signed governance attestations.
 *
 * GET    /api/vault-attestations?vault_id=<uuid>[&type=<kind>]
 *          list attestations for a vault (members only)
 * POST   /api/vault-attestations
 *          body: { vault_id, attestation_type, target_hash,
 *                  target_data, signature, pubkey }
 *          create an attestation signed by the caller
 * DELETE /api/vault-attestations?id=<uuid>
 *          revoke your own attestation
 *
 * The server does not verify the Schnorr signature cryptographically
 * here -- we trust the DB RLS + the member check to gate writes,
 * and the browser verifies signatures when rendering. If/when we
 * need adversarial verification (e.g. court-grade export), add a
 * secp256k1 schnorr-verify step here.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const FIELDS =
  "id, vault_id, user_id, attestation_type, target_hash, target_data, signature, pubkey, signed_at";

const VALID_TYPES = new Set(["trust_doc", "proof_of_life", "death_declaration"]);

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

function isHex(s, expectedChars) {
  if (typeof s !== "string") return false;
  if (s.length !== expectedChars) return false;
  return /^[0-9a-f]+$/i.test(s);
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const vaultId = event.queryStringParameters?.vault_id;
    const type = event.queryStringParameters?.type;
    if (!vaultId) return json(400, { error: "Missing: vault_id" });
    if (!(await assertMember(supabase, vaultId, u.userId))) {
      return json(403, { error: "Not a member of this vault" });
    }
    let q = supabase
      .from("vault_attestations")
      .select(FIELDS)
      .eq("vault_id", vaultId)
      .order("signed_at", { ascending: false })
      .limit(500);
    if (type && VALID_TYPES.has(type)) q = q.eq("attestation_type", type);
    const { data, error } = await q;
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, attestations: data });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body" }); }

    const {
      vault_id, attestation_type, target_hash,
      target_data = {}, signature, pubkey,
    } = body;

    if (!vault_id) return json(400, { error: "Missing: vault_id" });
    if (!VALID_TYPES.has(attestation_type)) {
      return json(400, { error: "Invalid attestation_type" });
    }
    if (!isHex(target_hash, 64)) {
      return json(400, { error: "target_hash must be 64 hex chars (SHA-256)" });
    }
    if (!isHex(signature, 128)) {
      return json(400, { error: "signature must be 128 hex chars (Schnorr 64B)" });
    }
    if (!isHex(pubkey, 64)) {
      return json(400, { error: "pubkey must be 64 hex chars (x-only)" });
    }
    if (target_data && typeof target_data !== "object") {
      return json(400, { error: "target_data must be an object" });
    }

    if (!(await assertMember(supabase, vault_id, u.userId))) {
      return json(403, { error: "Not a member of this vault" });
    }

    const row = {
      vault_id,
      user_id: u.userId,
      attestation_type,
      target_hash,
      target_data,
      signature,
      pubkey,
    };

    const { data, error } = await supabase
      .from("vault_attestations")
      .insert(row)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id,
      user_id: u.userId,
      event_type: "attestation_" + attestation_type,
      metadata: { attestation_id: data.id, target_hash },
    });

    return json(201, { ok: true, attestation: data });
  }

  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing: id" });

    const { data: row, error: lookupErr } = await supabase
      .from("vault_attestations")
      .select("id, vault_id, user_id, attestation_type")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) return json(500, { error: lookupErr.message });
    if (!row) return json(404, { error: "Attestation not found" });
    if (row.user_id !== u.userId) {
      return json(403, { error: "Can only revoke your own attestation" });
    }

    const { error } = await supabase
      .from("vault_attestations")
      .delete()
      .eq("id", id);
    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id: row.vault_id,
      user_id: u.userId,
      event_type: "attestation_revoked",
      metadata: { attestation_id: id, type: row.attestation_type },
    });

    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
