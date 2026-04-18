/**
 * GET /api/utxos?vault_id=<uuid>
 *
 * Returns every UTXO sitting at the vault's address: confirmed +
 * unconfirmed, with value, confirmation count, and block-age. Lets
 * the overview tab list each UTXO individually and lets the Send
 * flow offer coin-control ("spend just this UTXO").
 */

import { requireUser, json } from "./_auth.js";
import { getSupabaseAdmin } from "./_supabase.js";

const MEMPOOL = {
  testnet: "https://mempool.space/testnet/api",
  bitcoin: "https://mempool.space/api",
};

async function mempoolFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mempool.space ${res.status}: ${url}`);
  return res.json();
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
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const vaultId = event.queryStringParameters?.vault_id;
  if (!vaultId) return json(400, { error: "Missing: vault_id" });

  const supabase = getSupabaseAdmin();
  const { data: vault, error } = await supabase
    .from("vaults")
    .select("id, address, network")
    .eq("id", vaultId)
    .maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!vault) return json(404, { error: "Vault not found" });
  if (!vault.address) return json(200, { ok: true, utxos: [], tip: null });

  if (!(await assertMember(supabase, vaultId, u.userId))) {
    return json(403, { error: "Not a member of this vault" });
  }

  const network = vault.network || "testnet";
  const base = MEMPOOL[network] || MEMPOOL.testnet;

  let raw;
  let tip;
  try {
    [raw, tip] = await Promise.all([
      mempoolFetch(`${base}/address/${vault.address}/utxo`),
      mempoolFetch(`${base}/blocks/tip/height`),
    ]);
  } catch (err) {
    return json(502, { error: "mempool.space error: " + err.message });
  }

  const utxos = (raw || []).map(u => {
    const confirmed = !!u.status?.confirmed;
    const blockHeight = u.status?.block_height ?? null;
    const blockTime = u.status?.block_time ?? null;
    const confirmations =
      confirmed && blockHeight != null && typeof tip === "number"
        ? Math.max(0, tip - blockHeight + 1)
        : 0;
    return {
      txid: u.txid,
      vout: u.vout,
      value_sats: u.value,
      confirmed,
      block_height: blockHeight,
      block_time: blockTime,
      confirmations,
    };
  });

  utxos.sort((a, b) => b.value_sats - a.value_sats);

  return json(200, {
    ok: true,
    vault_address: vault.address,
    network,
    tip: typeof tip === "number" ? tip : null,
    utxos,
  });
}
