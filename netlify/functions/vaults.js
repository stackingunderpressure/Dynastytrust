import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const VAULT_FIELDS =
  "id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, founder_quorum, heir_quorum, recovery_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, protector_keys, protector_quorum, protector_after, consent_keys, consent_quorum, archived, status, planned_founder_count, planned_heir_count, trust_doc, predecessor_id";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  // ── GET /api/vaults ──────────────────────────────────────────
  // Returns every vault the caller is an active member of (owner
  // rows are seeded by a trigger so creators are included too).
  if (event.httpMethod === "GET") {
    const showArchived = event.queryStringParameters?.archived === "true";

    const { data: memberships, error: mErr } = await supabase
      .from("vault_members")
      .select("vault_id, role")
      .eq("user_id", u.userId)
      .eq("status", "active");
    if (mErr) return json(500, { error: mErr.message });

    const vaultIds = (memberships ?? []).map(m => m.vault_id);
    if (vaultIds.length === 0) return json(200, { ok: true, vaults: [] });
    const roleById = new Map((memberships ?? []).map(m => [m.vault_id, m.role]));

    let query = supabase
      .from("vaults")
      .select(VAULT_FIELDS)
      .in("id", vaultIds)
      .order("created_at", { ascending: false });

    if (!showArchived) query = query.eq("archived", false);

    const { data, error } = await query;
    if (error) return json(500, { error: error.message });
    // Attach the caller's role in each vault so the Dashboard can
    // render a role-aware view without an N+1 fetch.
    const vaults = (data ?? []).map(v => ({ ...v, my_role: roleById.get(v.id) ?? null }));
    return json(200, { ok: true, vaults });
  }

  // ── POST /api/vaults ─────────────────────────────────────────
  // Two modes:
  //   { mode: "draft", name, network, address_type, founder_quorum,
  //     heir_quorum, recovery_after, inheritance_after,
  //     planned_founder_count, planned_heir_count }
  //       -- creates a shape-only vault; address/descriptor null.
  //       -- members fill slots via invites; owner compiles when
  //          every slot has an xpub.
  //   Legacy mode (no `mode` field, or mode: "compiled"):
  //       -- the existing "I compiled this already, save it" path.
  //       -- requires address, descriptor, miniscript_policy.
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const network = body.network || "testnet";
    if (!["testnet", "signet", "bitcoin"].includes(network)) {
      return json(400, { error: "Invalid network. Use 'testnet', 'signet', or 'bitcoin'" });
    }

    const address_type = body.address_type || "tr_multileaf";
    if (!["wsh", "tr", "tr_multileaf"].includes(address_type)) {
      return json(400, { error: "Invalid address_type" });
    }

    const isDraft = body.mode === "draft";
    let insertRow;

    if (isDraft) {
      const planned_founder_count = body.planned_founder_count;
      const planned_heir_count = body.planned_heir_count ?? 0;
      if (!planned_founder_count || planned_founder_count < 1) {
        return json(400, { error: "planned_founder_count must be >= 1" });
      }
      if (planned_heir_count < 0) {
        return json(400, { error: "planned_heir_count cannot be negative" });
      }

      insertRow = {
        user_id: u.userId,
        name: body.name || "Vault",
        network,
        address_type,
        address: null,
        descriptor: null,
        miniscript_policy: null,
        founder_quorum: body.founder_quorum ?? planned_founder_count,
        heir_quorum: body.heir_quorum ?? Math.max(1, planned_heir_count),
        recovery_quorum: body.recovery_quorum ?? null,
        recovery_after: body.recovery_after ?? 26000,
        inheritance_after: body.inheritance_after ?? 52560,
        protector_keys: [],
        protector_quorum: body.protector_quorum ?? null,
        protector_after: body.protector_after ?? null,
        consent_keys: [],
        consent_quorum: body.consent_quorum ?? null,
        founder_keys: [],
        heir_keys: [],
        status: "draft",
        planned_founder_count,
        planned_heir_count,
      };
    } else {
      const { address, descriptor, miniscript_policy } = body;
      if (!address) return json(400, { error: "Missing: address" });
      if (!descriptor) return json(400, { error: "Missing: descriptor" });
      if (!miniscript_policy) return json(400, { error: "Missing: miniscript_policy" });

      // The vault address was already compiled by /api/compile,
      // which converted any relative block offsets into absolute
      // CLTV heights (tip + offset) and returned them in the
      // response. The client MUST pass those absolute values back
      // here so the DB matches what the Taproot tree actually
      // bakes in. Passing a relative offset here (or fetching a
      // fresh tip and re-converting) would give a value that
      // differs from what the address was compiled against, and
      // /api/psbt-binary's tree rebuild would produce a different
      // merkle root -- "Control block verification failed at
      // index 0" on finalize.
      insertRow = {
        user_id: u.userId,
        name: body.name || "Vault",
        network,
        address,
        descriptor,
        miniscript_policy,
        address_type,
        founder_quorum: body.founder_quorum ?? 2,
        heir_quorum: body.heir_quorum ?? 2,
        recovery_quorum: body.recovery_quorum ?? null,
        recovery_after: body.recovery_after ?? 0,
        inheritance_after: body.inheritance_after ?? 0,
        protector_keys: body.protector_keys ?? [],
        protector_quorum: body.protector_quorum ?? null,
        protector_after: body.protector_after ?? null,
        consent_keys: body.consent_keys ?? [],
        consent_quorum: body.consent_quorum ?? null,
        founder_keys: body.founder_keys ?? [],
        heir_keys: body.heir_keys ?? [],
        status: "compiled",
      };
    }

    const { data, error } = await supabase
      .from("vaults")
      .insert(insertRow)
      .select(VAULT_FIELDS)
      .single();

    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id: data.id,
      user_id: u.userId,
      event_type: isDraft ? "draft_created" : "created",
      metadata: isDraft
        ? {
            address_type,
            network,
            planned_founder_count: insertRow.planned_founder_count,
            planned_heir_count: insertRow.planned_heir_count,
          }
        : { address_type, network },
    });

    // Record explicit terms-of-service acceptance alongside the
    // vault creation. The client passes the version string it saw
    // in the UI; the server timestamps it. This gives us a durable
    // audit trail tied to a specific user and vault_id without
    // adding a separate table.
    if (body.terms_accepted_version) {
      await supabase.from("vault_events").insert({
        vault_id: data.id,
        user_id: u.userId,
        event_type: "terms_accepted",
        metadata: {
          terms_version: String(body.terms_accepted_version),
          user_agent: event.headers?.["user-agent"] || null,
        },
      });
    }

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

    const allowed = ["name", "archived", "trust_doc"];
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

  // -- DELETE /api/vaults?id=<uuid>
  // Owner only. Cascades through vault_members, proposals, etc via
  // ON DELETE CASCADE on the schema. Use archive for soft-delete;
  // this is for drafts or genuinely abandoned vaults.
  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    const { data: existing } = await supabase
      .from("vaults")
      .select("id, user_id, name")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return json(404, { error: "Vault not found" });
    if (existing.user_id !== u.userId) {
      return json(403, { error: "Only the primary trustee can delete this vault" });
    }

    const { error: delErr } = await supabase
      .from("vaults")
      .delete()
      .eq("id", id);
    if (delErr) return json(500, { error: delErr.message });

    await supabase.from("vault_events").insert({
      vault_id: id,
      user_id: u.userId,
      event_type: "deleted",
      metadata: { name: existing.name },
    }).then(() => {}, () => { /* event table may cascade-delete too */ });

    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
