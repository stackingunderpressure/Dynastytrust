// The path-builder ("leaves") vault's compile rules, moved from
// netlify/functions/compile-leaves.js into pure functions so the website's
// server and the downloaded app run ONE copy (download slice,
// docs/download-and-run-build-note.md). Same order, same checks, same
// messages; proven unchanged by scripts/test-vault-rules-leaves.mjs.
//
// Pure: no database, no network. The caller loads the draft row, does its
// own account checks (the server: owner, finalize guard, confirmed member
// keys), supplies the chain tip when `leavesNeedTip` says so, sends the
// payload to the compiler (Fly or the in-browser module), checks the answer
// with `leavesCompiledProblem`, and stores the row `leavesCompiledRow`
// returns.

import { checkTimelockFloor, relativeToAbsolute } from "./timelocks.js";
import { checkNumberBounds } from "./numeric.js";
import { assertNotPrivateExtendedKey } from "./xpub.js";
import { mustSignPathsNotInScripts } from "./must-sign.js";

const refuse = (status, error) => ({ ok: false, status, error });

/**
 * BIP32 origins for hardware-wallet signing, as sent by the caller's own
 * browser: entries without pubkey, fingerprint and derivation_path strings
 * are dropped (not re-derived).
 */
export function leavesKeyOrigins(raw) {
  return Array.isArray(raw)
    ? raw.filter((o) => o && typeof o.pubkey === "string" && typeof o.fingerprint === "string" && typeof o.derivation_path === "string")
    : [];
}

/**
 * Every path's own checks, then the consent keys. Returns
 * `{ ok:false, status, error }` or `{ ok:true, leaves }`.
 */
export function leavesCheck(vault) {
  const leaves = Array.isArray(vault.leaves) ? vault.leaves : [];
  if (!leaves.length) return refuse(400, "Draft has no leaves configured");

  for (const leaf of leaves) {
    if (!leaf || typeof leaf.id !== "string" || !leaf.id) {
      return refuse(400, "Every leaf needs a non-empty id");
    }
    if (!Array.isArray(leaf.keys) || !leaf.keys.length) {
      return refuse(400, `Leaf '${leaf.id}' has no keys`);
    }
    // Rust's own verify_leaf_policy also bounds the quorum; checked here
    // too so a future change there leaves this path guarded (Kimi K3 scan
    // Family D).
    const quorumErr = checkNumberBounds(leaf.quorum, { field: `Leaf '${leaf.id}' quorum`, min: 1, max: leaf.keys.length, integer: true });
    if (quorumErr) return refuse(400, quorumErr);
    for (const k of leaf.keys) {
      try {
        assertNotPrivateExtendedKey(k);
      } catch (e) {
        return refuse(400, e.message);
      }
    }
    // Floor-check an After leaf's raw relative offset BEFORE tip+offset
    // conversion -- Rust only ever sees the absolute value. OlderThan
    // leaves are a duration forwarded unchanged, so Rust's own
    // MAX_RELATIVE_BLOCKS check against the raw value already applies.
    if (leaf.unlock?.type === "after") {
      const err = checkTimelockFloor(leaf.unlock.blocks, `Leaf '${leaf.id}' unlock.blocks`);
      if (err) return refuse(400, err);
    }
    // Must-sign keys (protocol::Leaf::required_keys): each must sign on top
    // of the quorum of `keys`. Plain public keys only, never also in `keys`
    // -- the Rust compiler refuses that too (one signature would count
    // twice); checked here so the owner gets a sentence, not a compiler
    // error.
    if (leaf.required_keys !== undefined) {
      if (!Array.isArray(leaf.required_keys) || leaf.required_keys.some((k) => typeof k !== "string" || !/^0[23][0-9a-fA-F]{64}$/.test(k))) {
        return refuse(400, `The must-sign keys on "${leaf.label || leaf.id}" are not readable public keys.`);
      }
      const x = (k) => k.slice(2).toLowerCase();
      const pool = new Set(leaf.keys.filter((k) => typeof k === "string").map(x));
      const seen = new Set();
      for (const k of leaf.required_keys) {
        if (pool.has(x(k)) || seen.has(x(k))) {
          return refuse(400, `A key on "${leaf.label || leaf.id}" is listed twice. A must-sign key cannot also be one of the other keys on the same path.`);
        }
        seen.add(x(k));
      }
    }
  }
  for (const k of vault.consent_keys ?? []) {
    try {
      assertNotPrivateExtendedKey(k);
    } catch (e) {
      return refuse(400, e.message);
    }
  }
  return { ok: true, leaves };
}

/** Only AFTER leaves carry a relative offset that needs the chain tip; an
 *  OLDER leaf's block count is already the exact BIP68 duration. */
export function leavesNeedTip(leaves) {
  return leaves.some((l) => l.unlock?.type === "after");
}

/** The leaves as the compiler receives them and the row stores them: AFTER
 *  offsets become absolute heights (tip + offset), everything else as is. */
export function leavesWire(leaves, tipHeight) {
  return leaves.map((leaf) => {
    const unlock = leaf.unlock?.type === "after"
      ? { type: "after", blocks: relativeToAbsolute(leaf.unlock.blocks, tipHeight) }
      : leaf.unlock;
    return {
      id: leaf.id,
      label: leaf.label || leaf.id,
      keys: leaf.keys,
      quorum: leaf.quorum,
      unlock,
      decay: leaf.decay ?? null,
      // Only present on a path that has them, so every other vault's
      // stored paths keep the exact shape they always had.
      ...(Array.isArray(leaf.required_keys) && leaf.required_keys.length > 0 ? { required_keys: leaf.required_keys } : {}),
    };
  });
}

/** The compiler request (POST /compile-leaves). */
export function leavesCompilePayload(vault, wireLeaves) {
  return {
    name: vault.name,
    network: vault.network,
    leaves: wireLeaves,
    consent_keys: vault.consent_keys ?? [],
    consent_quorum: vault.consent_quorum,
  };
}

/**
 * Fail closed if the compiler did not honour the must-sign keys: a compiler
 * build from before they existed ignores the list and returns a valid,
 * WEAKER vault. Returns a refusal (nothing to save) or null.
 */
export function leavesCompiledProblem(wireLeaves, compiled) {
  const missing = mustSignPathsNotInScripts(wireLeaves, compiled.leaf_scripts);
  if (missing.length > 0) {
    return refuse(502, `The vault builder service did not include the must-sign ${missing.length === 1 ? 'key' : 'keys'} for "${missing.join('", "')}". Nothing was saved and no address was made. Try again in a few minutes.`);
  }
  return null;
}

/** The vault row update once compiled. The leaf list is stored with its
 *  absolute heights, matching what the compiled tree bakes in; the
 *  per-leaf scripts are kept (circle-membership invites read them). */
export function leavesCompiledRow(compiled, wireLeaves, keyOrigins) {
  return {
    address: compiled.address,
    descriptor: compiled.descriptor,
    miniscript_policy: compiled.miniscript_policy,
    leaves: wireLeaves,
    address_type: "tr_multileaf",
    status: "compiled",
    leaf_scripts: compiled.leaf_scripts ?? null,
    key_origins: keyOrigins,
  };
}
