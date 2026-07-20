/**
 * check-policy-builder.mjs -- durable guardrails on the vault builder UI so the
 * de-cluttering (docs/policy-builder-audit.md) cannot silently regress and so
 * the money-touching footguns cannot creep back in.
 *
 * This is a source-text guardrail in the repo's node-script style (like
 * test-literacy.mjs / test-rung-digest.mjs). It does NOT render the component --
 * it asserts invariants that must hold regardless of layout, chosen to catch
 * the exact regressions this page is prone to:
 *
 *   1. Address type defaults to the only safe multi-path Taproot shape
 *      (tr_multileaf). A `tr` single-leaf default is the documented
 *      DuplicatePubKeys footgun (CLAUDE.md known issues).
 *   2. The `tr` single-leaf option is NOT offered to users in the picker.
 *   3. The builder never auto-persists during compile -- the compile call sends
 *      `save: false`; persistence is always the explicit Save step.
 *   4. The audit trail is preserved -- save records `terms_accepted_version`.
 *   5. No raw `alert()` -- the design system's toast/inline errors are the rule.
 *   6. Both creation capabilities still exist after the save-flow merge:
 *      draft-and-invite (api.vaults.createDraft) and compile-now
 *      (api.compile) + persist (api.vaults.create).
 *   7. The two old competing sections ("Save as draft", "Compile immediately")
 *      stay merged into the single "Create your vault" flow.
 *   8. The file stays under a line budget so it cannot re-bloat back toward the
 *      2,600-line monster this cleanup is unwinding.
 *
 * Run directly:  node scripts/check-policy-builder.mjs
 * Wired into `npm test`.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pbPath = join(here, '..', 'apps', 'web', 'src', 'pages', 'PolicyBuilder.tsx');
const src = await readFile(pbPath, 'utf8');

const LINE_BUDGET = 2700;

function present(needle) {
  return src.includes(needle);
}

// 1. Safe default address type.
assert.ok(
  /useState<[^>]*>\(\s*['"]tr_multileaf['"]\s*\)/.test(src),
  'PolicyBuilder: address type must default to tr_multileaf (tr single-leaf trips DuplicatePubKeys)',
);

// 2. No user-facing single-leaf option.
assert.ok(
  !/<option\s+value=["']tr["']\s*>/.test(src),
  'PolicyBuilder: the tr single-leaf <option> must NOT be offered -- it is the DuplicatePubKeys footgun',
);

// 3. Compile never auto-persists.
assert.ok(
  present('save: false'),
  'PolicyBuilder: the compile() call must send save:false -- the builder must never auto-persist during compile',
);

// 4. Audit trail preserved on save.
assert.ok(
  present('terms_accepted_version'),
  'PolicyBuilder: save() must record terms_accepted_version for the audit trail',
);

// 5. No raw alert().
assert.ok(
  !/\balert\s*\(/.test(src),
  'PolicyBuilder: use the design system (toast / inline errors), never alert()',
);

// 6. Both creation capabilities preserved after the merge.
for (const cap of ['api.vaults.createDraft', 'api.compile(', 'api.vaults.create(']) {
  assert.ok(
    present(cap),
    `PolicyBuilder: the save-flow merge must preserve ${cap} -- a creation capability went missing`,
  );
}

// 7. The two old competing sections stay merged into one flow.
assert.ok(
  !present('title="Save as draft"') && !present('>Compile immediately<'),
  'PolicyBuilder: the old "Save as draft" / "Compile immediately" sections must stay merged, not return',
);
assert.ok(
  present('title="Create your vault"'),
  'PolicyBuilder: the single unified "Create your vault" flow must be present',
);

// 8. Line budget -- no re-bloat.
const lines = src.split('\n').length;
assert.ok(
  lines <= LINE_BUDGET,
  `PolicyBuilder: ${lines} lines exceeds the ${LINE_BUDGET}-line budget -- split it or push work into shared components`,
);

console.log(
  `policy-builder guardrails OK -- safe address default, no single-leaf option, ` +
    `compile save:false, TOS audit, no alert(), both creation paths, merged flow, ${lines}/${LINE_BUDGET} lines`,
);
