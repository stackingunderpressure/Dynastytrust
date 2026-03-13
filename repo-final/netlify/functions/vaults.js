import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const VAULT_FIELDS =
  "id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, founder_quorum, heir_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, archived";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  // ── GET /api/vaults ──────────────────────────────────────────
  if (event.httpMethod === "GET") {
    const showArchived = event.queryStringParameters?.archived === "true";

    let query = supabase
      .from("vaults")
      .select(VAULT_FIELDS)
      .eq("user_id", u.userId)
      .order("created_at", { ascending: false });

    if (!showArchived) {
      query = query.eq("archived", false);
    }

    const { data, error } = await query;
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, vaults: data });
  }

  // ── POST /api/vaults ─────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    // Required fields
    const { address, descriptor, miniscript_policy } = body;
    if (!address) return json(400, { error: "Missing: address" });
    if (!descriptor) return json(400, { error: "Missing: descriptor" });
    if (!miniscript_policy) return json(400, { error: "Missing: miniscript_policy" });

    const network = body.network || "testnet";
    if (!["testnet", "bitcoin"].includes(network)) {
      return json(400, { error: "Invalid network. Use 'testnet' or 'bitcoin'" });
    }

    const address_type = body.address_type || "tr";
    if (!["wsh", "tr", "tr_multileaf"].includes(address_type)) {
      return json(400, { error: "Invalid address_type" });
    }

    const { data, error } = await supabase
      .from("vaults")
      .insert({
        user_id: u.userId,
        name: body.name || "Vault",
        network,
        address,
        descriptor,
        miniscript_policy,
        address_type,
        founder_quorum: body.founder_quorum ?? 2,
        heir_quorum: body.heir_quorum ?? 2,
        recovery_after: body.recovery_after ?? 26000,
        inheritance_after: body.inheritance_after ?? 52560,
        founder_keys: body.founder_keys ?? [],
        heir_keys: body.heir_keys ?? [],
      })
      .select(VAULT_FIELDS)
      .single();

    if (error) return json(500, { error: error.message });

    // Log creation event
    await supabase.from("vault_events").insert({
      vault_id: data.id,
      user_id: u.userId,
      event_type: "created",
      metadata: { address_type, network },
    });

    return json(201, { ok: true, vault: data });
  }

  // ── PATCH /api/vaults?id=<uuid> ──────────────────────────────
  if (event.httpMethod === "PATCH") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const allowed = ["name", "archived"];
    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k))
    );

    if (Object.keys(updates).length === 0) {
      return json(400, { error: "No updatable fields provided (allowed: name, archived)" });
    }

    const { data, error } = await supabase
      .from("vaults")
      .update(updates)
      .eq("id", id)
      .eq("user_id", u.userId)
      .select(VAULT_FIELDS)
      .single();

    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: "Vault not found" });

    return json(200, { ok: true, vault: data });
  }

  return json(405, { error: "Method not allowed" });
}
