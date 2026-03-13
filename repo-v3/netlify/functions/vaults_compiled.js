/**
 * POST /api/vaults_compiled
 *
 * Receives a pre-compiled vault payload from the Rust CLI or compiler service
 * and stores it via the same vaults table. This is the endpoint the CLI posts to.
 */
import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const VAULT_FIELDS =
  "id, created_at, user_id, name, network, address, descriptor, miniscript_policy, address_type";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { name, network, miniscript_policy, descriptor, address } = body;

  if (!address) return json(400, { error: "Missing: address" });
  if (!descriptor) return json(400, { error: "Missing: descriptor" });
  if (!miniscript_policy) return json(400, { error: "Missing: miniscript_policy" });

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("vaults")
    .insert({
      user_id: u.userId,
      name: name || "CLI Vault",
      network: network || "testnet",
      address,
      descriptor,
      miniscript_policy,
      address_type: body.address_type || "tr",
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

  return json(201, { ok: true, vault: data });
}
