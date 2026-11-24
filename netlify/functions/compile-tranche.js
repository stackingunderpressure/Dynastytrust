/**
 * POST /api/compile-tranche
 *
 * Proxy to the Fly.io Rust compiler's /compile-tranche endpoint.
 * Returns one tranche descriptor/address given a beneficiary pubkey,
 * the trustees' pubkeys and quorum, and an absolute unlock block.
 *
 * The ceremony UI calls this N times (once per scheduled unlock) to
 * generate the full year's worth of distribution addresses.
 *
 * Body: { network, beneficiary_key, trustee_keys, trustee_quorum,
 *         unlock_block }
 * Returns: { ok, network, miniscript_policy, descriptor, address,
 *            unlock_block }
 */

import { requireUser, json } from "./_auth.js";
import { fetchCompiler, compilerFailureReason } from "./_compiler.js";
import { assertNotPrivateExtendedKey } from "./_xpub.js";


export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const {
    network = "testnet",
    beneficiary_key,
    trustee_keys = [],
    trustee_quorum,
    unlock_block,
  } = body;

  if (!beneficiary_key) return json(400, { error: "Missing: beneficiary_key" });
  if (!trustee_keys.length) return json(400, { error: "Missing: trustee_keys" });
  if (!trustee_quorum) return json(400, { error: "Missing: trustee_quorum" });
  if (!unlock_block) return json(400, { error: "Missing: unlock_block" });

  // 2026-08-15 security audit: see compile.js's identical comment.
  for (const k of [beneficiary_key, ...trustee_keys]) {
    try {
      assertNotPrivateExtendedKey(k);
    } catch (e) {
      return json(400, { error: e.message });
    }
  }


  try {
    const res = await fetchCompiler(null, "/compile-tranche", {
      network,
      beneficiary_key,
      trustee_keys,
      trustee_quorum,
      unlock_block,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json(502, {
        error: `Compiler returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`,
        hint: "The vault compiler gave an answer that is not JSON -- this is a bug; please report it.",
      });
    }
    if (!res.ok || !data.ok) {
      return json(400, { error: data.error || "Compiler returned an error" });
    }
    return json(200, data);
  } catch (err) {
    return json(502, { error: `Compiler unreachable: ${compilerFailureReason(err)}` });
  }
}
