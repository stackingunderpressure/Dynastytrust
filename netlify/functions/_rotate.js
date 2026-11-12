/**
 * _rotate.js -- carrying a path-builder ("leaf-list") vault's spending
 * paths forward into a successor draft. Pure.
 *
 * A vault's dates are fixed in its script for good, so the ONLY way to
 * push an inheritance date out is a new vault with later dates and the
 * coins moved to it. Until 2026-11-11 that could not be done for any
 * vault the wizard builds: vaults-rotate.js refused the shape outright
 * (it used to produce a broken named-field draft instead).
 *
 * What rotation may change is deliberately one thing: WHEN each dated
 * path opens. Who signs, how many must sign, the untouched-for-a-while
 * paths and the step-down ladders are copied exactly -- changing those
 * is a different vault, built fresh. The browser re-checks the compiled
 * successor against the vault it replaces (apps/web/src/lib/
 * rotate-plan.ts), so this function being wrong cannot pass silently.
 */
import { checkTimelockFloor } from "./_chain.js";

/**
 * `srcLeaves`: the compiled vault's leaves (dated paths hold ABSOLUTE
 * heights). `offsets`: { [leaf id]: blocks from the successor's compile }
 * for every dated path, chosen in the owner's browser. Returns the
 * successor draft's leaf list, where a dated path holds that RELATIVE
 * offset (compile-leaves.js adds the tip). Throws with a plain message.
 */
export function rotatedLeaves(srcLeaves, offsets) {
  if (!Array.isArray(srcLeaves) || srcLeaves.length === 0) throw new Error("This vault has no spending paths to carry forward.");
  if (!offsets || typeof offsets !== "object" || Array.isArray(offsets)) throw new Error("Missing: the new date for each dated path.");
  const dated = new Set(srcLeaves.filter((l) => l?.unlock?.type === "after").map((l) => l.id));
  for (const id of Object.keys(offsets)) {
    if (!dated.has(id)) throw new Error(`"${id}" is not a dated path of this vault.`);
  }
  return srcLeaves.map((leaf) => {
    if (!leaf || typeof leaf.id !== "string" || !leaf.id || !Array.isArray(leaf.keys) || !leaf.unlock) {
      throw new Error("This vault's stored paths are not readable; it cannot be rotated automatically.");
    }
    let unlock;
    if (leaf.unlock.type === "after") {
      const blocks = offsets[leaf.id];
      if (blocks === undefined) throw new Error(`Missing the new date for the path "${leaf.label || leaf.id}".`);
      // 0 would mean "no timelock": never acceptable for a path that had one.
      if (!blocks) throw new Error(`The path "${leaf.label || leaf.id}" must keep a waiting period.`);
      const err = checkTimelockFloor(blocks, `The path "${leaf.label || leaf.id}"`);
      if (err) throw new Error(err);
      unlock = { type: "after", blocks };
    } else if (leaf.unlock.type === "older") {
      unlock = { type: "older", blocks: leaf.unlock.blocks };
    } else if (leaf.unlock.type === "immediate") {
      unlock = { type: "immediate" };
    } else {
      throw new Error(`The path "${leaf.label || leaf.id}" has a timing rule this version cannot carry forward.`);
    }
    return {
      id: leaf.id,
      label: leaf.label || leaf.id,
      keys: [...leaf.keys],
      quorum: leaf.quorum,
      unlock,
      decay: leaf.decay ? { step_blocks: leaf.decay.step_blocks, floor_quorum: leaf.decay.floor_quorum } : null,
      // Must-sign keys carry over with the path. Dropping them would
      // hand the owner a successor that is WEAKER than the vault they
      // rotated from, without a word.
      ...(Array.isArray(leaf.required_keys) && leaf.required_keys.length > 0 ? { required_keys: [...leaf.required_keys] } : {}),
    };
  });
}
