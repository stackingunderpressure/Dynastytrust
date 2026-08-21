/**
 * POST /api/compile-bloc
 *
 * Compiles a Dynasty Bloc vault -- a decaying-multisig family tree --
 * via the Fly.io Rust compiler's /compile-bloc endpoint.
 *
 *   A  parents together                                 now
 *   B  one parent + every kid                           now
 *   C  one parent alone                  after parent_solo_after
 *   D+ kids alone, decaying threshold,   after kids_decay_start_after
 *
 * Phase 1 is COMPILE-ONLY: it returns the address + descriptor +
 * miniscript for hardware-wallet export. The bloc shape is not yet
 * persisted to the founders/heirs-shaped vaults table (Phase 2), so
 * there is no save branch here.
 *
 * Timelocks: callers pass RELATIVE block offsets. Miniscript
 * `after(N)` is absolute CLTV, so we add the current chain tip
 * (tip + offset) before forwarding -- identical to compile.js.
 * `kids_decay_step_blocks` is a duration between decay rungs, NOT an
 * offset from now, so it is forwarded unchanged.
 */

import { requireUser, json } from "./_auth.js";
import { fetchTipHeight, relativeToAbsolute, checkTimelockFloor } from "./_chain.js";
import { fetchCompiler, compilerFailureReason } from "./_compiler.js";

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

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

  const {
    name = "Dynasty Bloc",
    network = "testnet",
    parent_keys = [],
    parents_together_quorum,
    coparent_quorum,
    kid_keys = [],
    kids_with_parent_quorum,
    parent_solo_after = 0,
    parent_solo_quorum,
    kids_decay_start_after = 0,
    kids_decay_step_blocks = 0,
    kids_decay_start_quorum,
    kids_decay_floor_quorum,
  } = body;

  // Minimal required-field checks; the Rust compiler enforces the
  // full quorum/ordering rules and returns a precise message.
  if (!parent_keys.length) return json(400, { error: "Missing: parent_keys" });
  if (!kid_keys.length)    return json(400, { error: "Missing: kid_keys" });
  if (!parents_together_quorum) return json(400, { error: "Missing: parents_together_quorum" });
  if (!coparent_quorum)         return json(400, { error: "Missing: coparent_quorum" });
  if (!kids_with_parent_quorum) return json(400, { error: "Missing: kids_with_parent_quorum" });
  if (!parent_solo_quorum)      return json(400, { error: "Missing: parent_solo_quorum" });
  if (!kids_decay_start_quorum) return json(400, { error: "Missing: kids_decay_start_quorum" });
  if (!kids_decay_floor_quorum) return json(400, { error: "Missing: kids_decay_floor_quorum" });
  if (!parent_solo_after)       return json(400, { error: "Missing: parent_solo_after" });
  if (!kids_decay_start_after)  return json(400, { error: "Missing: kids_decay_start_after" });

  // Floor-check the raw relative offsets BEFORE tip+offset conversion
  // below -- Rust's own MIN_RECOVERY_BLOCKS check
  // (verify_bloc/parent_solo_after) only ever sees the already-absolute
  // value and is a structural no-op by then (Kimi K3 scan Family D;
  // this file previously had no floor check at all, unlike compile.js's
  // recovery_after).
  for (const [value, field] of [
    [parent_solo_after, "parent_solo_after"],
    [kids_decay_start_after, "kids_decay_start_after"],
  ]) {
    const err = checkTimelockFloor(value, field);
    if (err) return json(400, { error: err });
  }

  if (!COMPILER_URL) {
    return json(503, {
      error: "Compiler service not configured. Set COMPILER_URL in Netlify environment variables.",
      hint: "Deploy the Rust compiler to Fly.io and set COMPILER_URL to its URL.",
    });
  }

  // Relative offsets -> absolute CLTV heights (tip + offset).
  let tipHeight;
  try {
    tipHeight = await fetchTipHeight(network);
  } catch (e) {
    return json(502, { error: `Could not fetch chain tip for ${network}: ${e.message}` });
  }
  const absParentSoloAfter   = relativeToAbsolute(parent_solo_after,      tipHeight);
  const absKidsDecayStart    = relativeToAbsolute(kids_decay_start_after, tipHeight);

  let compiled;
  try {
    const compilerRes = await fetchCompiler(COMPILER_URL, "/compile-bloc", {
      name, network,
      parent_keys,
      parents_together_quorum,
      coparent_quorum,
      kid_keys,
      kids_with_parent_quorum,
      parent_solo_after: absParentSoloAfter,
      parent_solo_quorum,
      kids_decay_start_after: absKidsDecayStart,
      kids_decay_step_blocks,
      kids_decay_start_quorum,
      kids_decay_floor_quorum,
    }, { compilerSecret: COMPILER_SECRET });

    const rawText = await compilerRes.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return json(502, {
        error: `Compiler returned non-JSON (status ${compilerRes.status}): ${rawText.slice(0, 200)}`,
        hint: "Check COMPILER_SECRET matches between Netlify and Fly.io",
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
    // See compile.js's identical fix: the internal compiler URL and
    // whether its secret is configured are server infrastructure
    // details, not something the client needs -- log, don't return.
    console.error("Compiler unreachable:", { compiler_url: COMPILER_URL, secret_set: !!COMPILER_SECRET, reason });
    return json(502, { error: `Compiler unreachable: ${reason}` });
  }

  return json(200, {
    ok: true,
    compiled,
    absolute_timelocks: {
      parent_solo_after: absParentSoloAfter,
      kids_decay_start_after: absKidsDecayStart,
      tip_height: tipHeight,
    },
  });
}
