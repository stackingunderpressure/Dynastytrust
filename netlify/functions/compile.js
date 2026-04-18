/**
 * POST /api/compile
 *
 * Netlify Function that proxies compile requests to the Fly.io Rust compiler
 * service. The COMPILER_SECRET is kept server-side — the browser never sees it.
 *
 * Flow:
 *   Browser → POST /api/compile (with Supabase JWT)
 *     → This function verifies the JWT
 *     → Forwards to COMPILER_URL/compile (with COMPILER_SECRET)
 *     → Returns compiled address, descriptor, miniscript_policy
 *     → Optionally saves to Supabase vaults table if save=true
 *
 * Required env vars (Netlify):
 *   COMPILER_URL     — e.g. https://dynastytrust-compiler.fly.dev
 *   COMPILER_SECRET  — shared secret set via: fly secrets set COMPILER_SECRET=…
 *   SUPABASE_URL     — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { requireUser, json } from "./_auth.js";
import { getSupabaseAdmin } from "./_supabase.js";

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  // 1. Verify user JWT
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  // 2. Parse request body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const {
    name,
    network = "testnet",
    address_type = "tr",
    founder_keys = [],
    founder_quorum,
    recovery_quorum = null,
    heir_keys = [],
    heir_quorum = 1,
    recovery_after = 0,
    inheritance_after = 0,
    protector_keys = [],
    protector_quorum = null,
    protector_after = null,
    consent_keys = [],
    consent_quorum = null,
    save = true,   // if true, auto-save compiled vault to DB
  } = body;

  // Validate required fields. Heirs + timelocks are optional --
  // omitting them compiles a plain multisig / single-sig vault with
  // no recovery or inheritance paths. If the caller says "no heirs"
  // we also zero the timelocks so Rust's is_plain() kicks in and
  // skips the heir-quorum check that would otherwise fail with
  // heir_keys=[] and heir_quorum=1.
  let finalHeirQuorum = heir_quorum;
  let finalRecoveryAfter = recovery_after;
  let finalInheritanceAfter = inheritance_after;
  if (!founder_keys.length) return json(400, { error: "Missing: founder_keys" });
  if (!founder_quorum)      return json(400, { error: "Missing: founder_quorum" });
  if (heir_keys.length === 0) {
    finalHeirQuorum = 1;
    finalRecoveryAfter = 0;
    finalInheritanceAfter = 0;
  } else {
    if (!finalHeirQuorum) return json(400, { error: "Missing: heir_quorum" });
    if (!finalRecoveryAfter) return json(400, { error: "Missing: recovery_after" });
    if (!finalInheritanceAfter) return json(400, { error: "Missing: inheritance_after" });
  }

  if (!COMPILER_URL) {
    return json(503, {
      error: "Compiler service not configured. Set COMPILER_URL in Netlify environment variables.",
      hint: "Deploy the Rust compiler to Fly.io and set COMPILER_URL to its URL."
    });
  }

  // 4. Forward to Fly.io compiler — retry once in case machine is waking up
  let compiled;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
      const compilerRes = await fetch(`${COMPILER_URL.replace(/\/$/, "")}/compile`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
        },
        body: JSON.stringify({
          name, network, address_type,
          founder_keys, founder_quorum,
          recovery_quorum,
          heir_keys,
          heir_quorum: finalHeirQuorum,
          recovery_after: finalRecoveryAfter,
          inheritance_after: finalInheritanceAfter,
          ...(protector_keys.length > 0 && protector_quorum != null && protector_after != null
            ? { protector_keys, protector_quorum, protector_after }
            : {}),
          ...(consent_keys.length > 0 && consent_quorum != null
            ? { consent_keys, consent_quorum }
            : {}),
        }),
      });
      clearTimeout(timeout);

      const rawText = await compilerRes.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        return json(502, {
          error: `Compiler returned non-JSON (status ${compilerRes.status}): ${rawText.slice(0, 200)}`,
          hint: "Check COMPILER_SECRET matches between Netlify and Fly.io"
        });
      }

      if (!compilerRes.ok || !data.ok) {
        return json(400, {
          error: data.error || "Compiler returned an error",
          detail: `Compiler status: ${compilerRes.status}`,
        });
      }

      compiled = data;
      break; // success — exit retry loop

    } catch (err) {
      lastErr = err;
      console.error(`Compiler attempt ${attempt} failed:`, err.message);
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (!compiled) {
    const reason = lastErr?.name === 'AbortError'
      ? 'Compiler timed out after 15s'
      : lastErr?.message || 'Unknown error';
    return json(502, {
      error: `Compiler unreachable: ${reason}`,
      compiler_url: COMPILER_URL,
      secret_set: !!COMPILER_SECRET,
    });
  }

  // 5. Optionally save to Supabase
  if (save) {
    try {
      const supabase = getSupabaseAdmin();
      const { data: vault, error } = await supabase
        .from("vaults")
        .insert({
          user_id:           u.userId,
          name:              compiled.name || name || "Vault",
          network:           compiled.network,
          address_type:      compiled.address_type,
          address:           compiled.address,
          descriptor:        compiled.descriptor,
          miniscript_policy: compiled.miniscript_policy,
          founder_quorum,
          recovery_quorum,
          heir_quorum,
          recovery_after,
          inheritance_after,
          founder_keys,
          heir_keys,
          protector_keys,
          protector_quorum,
          protector_after,
          consent_keys,
          consent_quorum,
        })
        .select("id, created_at, name, network, address_type, address, descriptor, miniscript_policy, founder_quorum, heir_quorum, recovery_after, inheritance_after, founder_keys, heir_keys")
        .single();

      if (error) {
        console.error("Supabase insert error:", error);
        // Return compiled result even if save failed — don't lose the address
        return json(200, {
          ok: true,
          compiled,
          saved: false,
          save_error: error.message,
        });
      }

      // Log event
      await supabase.from("vault_events").insert({
        vault_id:   vault.id,
        user_id:    u.userId,
        event_type: "created",
        metadata:   { address_type: compiled.address_type, network: compiled.network, via: "browser" },
      });

      return json(201, { ok: true, compiled, saved: true, vault });
    } catch (err) {
      console.error("Save error:", err);
      return json(200, { ok: true, compiled, saved: false, save_error: err.message });
    }
  }

  // Compile-only (no save)
  return json(200, { ok: true, compiled, saved: false });
}
