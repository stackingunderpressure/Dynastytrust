// Did the compiler actually put every must-sign key into the script of
// the path that names it?
//
// A compiler that does not know about must-sign keys (an older build
// still running while a new one deploys, or after a failed deploy)
// ignores the list and returns a perfectly valid vault WITHOUT them --
// weaker than the one the owner was shown, with nothing to say so. So
// the answer is checked from the compiled scripts themselves: each
// must-sign key's 32-byte x-only form has to appear in its own path's
// script, on every step of a relaxing path. A key that merely appears
// somewhere else in the vault does not count.
//
// Twin of apps/web/src/lib/must-sign-check.ts (scripts/test-must-sign-check.mjs
// holds them identical). Returns the labels of paths that failed.

export function mustSignPathsNotInScripts(leaves, leafScripts) {
  const failed = [];
  for (const leaf of leaves ?? []) {
    const must = leaf?.required_keys ?? [];
    if (must.length === 0) continue;
    const scripts = Object.entries(leafScripts ?? {})
      .filter(([id]) => id === leaf.id || id.startsWith(`${leaf.id}_`))
      .map(([, hex]) => String(hex).toLowerCase());
    const ok = scripts.length > 0
      && must.every((k) => typeof k === 'string' && k.length === 66 && scripts.every((s) => s.includes(k.slice(2).toLowerCase())));
    if (!ok) failed.push(leaf.label || leaf.id);
  }
  return failed;
}
