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
import { fetchTipHeight, relativeToAbsolute } from "./_chain.js";
import { fetchCompiler, compilerFailureReason } from "./_compiler.js";
import { assertNotPrivateExtendedKey } from "./_xpub.js";

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

// Mirrors protocol/src/policy_compiler.rs's MIN_RECOVERY_BLOCKS. Must be
// checked HERE, against the raw relative offset, before the tip+offset
// conversion below turns it into an absolute height -- by the time a
// value reaches the Rust compiler's own verify() it is already absolute
// (tip + offset, generally in the hundreds of thousands on any live
// network), so Rust's `recovery_after < MIN_RECOVERY_BLOCKS` check is
// structurally a no-op on every live network and cannot be relied on to
// catch a too-soon recovery timelock.
const MIN_RECOVERY_BLOCKS = 26_000;

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

  // 2026-08-15 security audit: only psbt-binary.js and vaults-compile.js
  // ever ran this check (via pubkeyFromXpub's internal call) -- every
  // other endpoint that accepts a key-shaped string, including this one,
  // stored whatever it was given with no check. A private extended key
  // (xprv/tprv/uprv/vprv) must never reach the server at all, whether or
  // not anything is derived from it.
  for (const k of [...founder_keys, ...heir_keys, ...consent_keys]) {
    try {
      assertNotPrivateExtendedKey(k);
    } catch (e) {
      return json(400, { error: e.message });
    }
  }
  if (heir_keys.length === 0) {
    finalHeirQuorum = 1;
    finalRecoveryAfter = 0;
    finalInheritanceAfter = 0;
  } else {
    if (!finalHeirQuorum) return json(400, { error: "Missing: heir_quorum" });
    if (!finalInheritanceAfter) return json(400, { error: "Missing: inheritance_after" });
    // recovery_after == 0 is no longer an error here: it's the "Gift
    // Locker" shape (founders-now OR a single beneficiary path that
    // unlocks after a specified time, with no separate founders-after-
    // a-delay recovery leaf in between) -- see DynastyPolicy::has_recovery()
    // in protocol/src/policy_compiler.rs. When recovery_after IS set to
    // something nonzero it must still clear MIN_RECOVERY_BLOCKS -- check
    // it here, against the raw relative value, since Rust's own verify()
    // only ever sees the absolute height post-conversion below.
    if (finalRecoveryAfter && finalRecoveryAfter < MIN_RECOVERY_BLOCKS) {
      return json(400, {
        error: `recovery_after must be >= ${MIN_RECOVERY_BLOCKS} blocks (or 0 for no recovery leaf)`,
      });
    }
  }

  if (!COMPILER_URL) {
    return json(503, {
      error: "Compiler service not configured. Set COMPILER_URL in Netlify environment variables.",
      hint: "Deploy the Rust compiler to Fly.io and set COMPILER_URL to its URL."
    });
  }

  // Convert the relative block offsets the caller passed ("6 months
  // from now") into absolute CLTV heights (tip + offset). Miniscript
  // `after(N)` compiles to OP_CLTV which is always absolute, so the
  // leaf bakes in a specific block height at compile time. Without
  // this step every timelock N < current tip would be unlocked.
  let tipHeight = 0;
  if (finalRecoveryAfter || finalInheritanceAfter) {
    try {
      tipHeight = await fetchTipHeight(network);
    } catch (e) {
      return json(502, { error: `Could not fetch chain tip for ${network}: ${e.message}` });
    }
  }
  const absRecoveryAfter    = relativeToAbsolute(finalRecoveryAfter,    tipHeight);
  const absInheritanceAfter = relativeToAbsolute(finalInheritanceAfter, tipHeight);

  // 4. Forward to Fly.io compiler — fetchCompiler retries once in case
  // the machine is waking up from a cold start.
  let compiled;
  try {
    const compilerRes = await fetchCompiler(COMPILER_URL, "/compile", {
      name, network, address_type,
      founder_keys, founder_quorum,
      recovery_quorum,
      heir_keys,
      heir_quorum: finalHeirQuorum,
      recovery_after: absRecoveryAfter,
      inheritance_after: absInheritanceAfter,
      ...(consent_keys.length > 0 && consent_quorum != null
        ? { consent_keys, consent_quorum }
        : {}),
    }, { compilerSecret: COMPILER_SECRET });

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
  } catch (err) {
    const reason = compilerFailureReason(err);
    // The internal Fly.io compiler URL and whether its secret is
    // configured are server infrastructure details, not something an
    // authenticated app user needs to debug a transient network blip --
    // log them server-side instead of handing them back in the response.
    console.error('Compiler unreachable:', { compiler_url: COMPILER_URL, secret_set: !!COMPILER_SECRET, reason });
    return json(502, { error: `Compiler unreachable: ${reason}` });
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
          // Store absolute CLTV heights, not the relative offsets
          // the caller sent. The UI subtracts current tip to render
          // "unlocks in Y months".
          recovery_after: absRecoveryAfter,
          inheritance_after: absInheritanceAfter,
          founder_keys,
          heir_keys,
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

      return json(201, {
        ok: true, compiled, saved: true, vault,
        absolute_timelocks: {
          recovery_after: absRecoveryAfter,
          inheritance_after: absInheritanceAfter,
          tip_height: tipHeight,
        },
      });
    } catch (err) {
      console.error("Save error:", err);
      return json(200, { ok: true, compiled, saved: false, save_error: err.message });
    }
  }

  // Compile-only (no save)
  return json(200, {
    ok: true,
    compiled,
    saved: false,
    // Echo back the absolute CLTV heights we computed so the
    // caller can store them against the vault row instead of
    // re-deriving (which would race against a fresh chain tip).
    absolute_timelocks: {
      recovery_after: absRecoveryAfter,
      inheritance_after: absInheritanceAfter,
      tip_height: tipHeight,
    },
  });
}
