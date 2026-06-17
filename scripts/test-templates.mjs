/**
 * test-templates.mjs -- the SINGLE-SOURCE drift guard.
 *
 * This is the safety net that keeps the canonical vault-templates module
 * honest. It is money-touching: the template `config` values are the
 * compile-critical structural params PolicyBuilder feeds the Bitcoin
 * compiler. If any of these invariants break, a vault could be built with
 * the wrong quorum or an impossible threshold.
 *
 * Invariants asserted:
 *   1. Template ids are unique (a dup would let one id silently shadow
 *      another in PolicyBuilder's id-keyed merge and Sage's lookups).
 *   2. For EVERY template: founderQ <= plannedFounders, and (when heirs
 *      exist) heirQ <= plannedHeirs. A quorum that exceeds its key count
 *      can never be met -- it would brick the path.
 *   3. Quorums and counts are non-negative integers; modes are valid.
 *   4. Protector/consent quorums, when enabled, are >= 1.
 *   5. The SSOT renders a non-empty digest and opening chips (so Sage's
 *      knowledge actually populates).
 *
 * Note: the SSOT is the ONLY definition of the compile-critical config
 * now -- PolicyBuilder consumes it directly and only merges page-local
 * trust-doc text on top -- so there is no separate mirrored copy to
 * cross-check. This guard verifies the SSOT's own internal soundness.
 */
import assert from 'node:assert/strict';
import {
  VAULT_TEMPLATES,
  TEMPLATE_TITLES,
  renderTemplateDigest,
  openingChips,
} from '../apps/web/src/data/vault-templates.js';

const VALID_MODES = new Set(['plain', 'inheritance']);

function isNonNegInt(n) {
  return Number.isInteger(n) && n >= 0;
}

// 1. Unique ids.
{
  const ids = VAULT_TEMPLATES.map((t) => t.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, 'template ids must be unique');
  assert.ok(ids.length > 0, 'there must be at least one template');
}

// 2-4. Per-template structural soundness.
for (const t of VAULT_TEMPLATES) {
  const c = t.config;
  assert.ok(typeof t.id === 'string' && t.id.length > 0, `template id missing`);
  assert.ok(typeof t.title === 'string' && t.title.length > 0, `${t.id}: title missing`);
  assert.ok(VALID_MODES.has(c.mode), `${t.id}: invalid mode ${c.mode}`);

  assert.ok(isNonNegInt(c.plannedFounders), `${t.id}: plannedFounders not a non-neg int`);
  assert.ok(isNonNegInt(c.founderQ), `${t.id}: founderQ not a non-neg int`);
  assert.ok(isNonNegInt(c.plannedHeirs), `${t.id}: plannedHeirs not a non-neg int`);
  assert.ok(isNonNegInt(c.heirQ), `${t.id}: heirQ not a non-neg int`);
  assert.ok(isNonNegInt(c.recoveryAfter), `${t.id}: recoveryAfter not a non-neg int`);
  assert.ok(isNonNegInt(c.inheritanceAfter), `${t.id}: inheritanceAfter not a non-neg int`);

  // Founder quorum must be reachable.
  assert.ok(c.founderQ >= 1, `${t.id}: founderQ must be >= 1`);
  assert.ok(
    c.founderQ <= c.plannedFounders,
    `${t.id}: founderQ (${c.founderQ}) exceeds plannedFounders (${c.plannedFounders})`,
  );

  // Heir quorum must be reachable when heirs exist.
  if (c.plannedHeirs > 0) {
    assert.ok(c.heirQ >= 1, `${t.id}: heirQ must be >= 1 when heirs exist`);
    assert.ok(
      c.heirQ <= c.plannedHeirs,
      `${t.id}: heirQ (${c.heirQ}) exceeds plannedHeirs (${c.plannedHeirs})`,
    );
  }

  // Inheritance vaults with heirs and a recovery window: inheritance must
  // come after recovery (matches PolicyBuilder's validate() rail).
  if (c.mode === 'inheritance' && c.plannedHeirs > 0 && c.recoveryAfter > 0) {
    assert.ok(
      c.inheritanceAfter > c.recoveryAfter,
      `${t.id}: inheritanceAfter (${c.inheritanceAfter}) must exceed recoveryAfter (${c.recoveryAfter})`,
    );
  }

  // Protector, when enabled, needs a real key + quorum and a positive
  // timelock that unlocks BEFORE inheritance, so the protector can
  // intervene before succession transfers control. (The shipped
  // Generational Trust deliberately puts the protector window EARLIER
  // than the founder recovery window -- the protector is an independent
  // rescue, not gated behind founder recovery -- so we do NOT require
  // protectorAfter > recoveryAfter here.)
  if (c.protectorEnabled) {
    assert.ok(Number.isInteger(c.protectorQ) && c.protectorQ >= 1, `${t.id}: protectorQ must be >= 1`);
    assert.ok(
      Number.isInteger(c.plannedProtectors) && c.plannedProtectors >= c.protectorQ,
      `${t.id}: plannedProtectors must be >= protectorQ`,
    );
    assert.ok(Number.isInteger(c.protectorAfter) && c.protectorAfter > 0, `${t.id}: protectorAfter must be a positive int`);
    assert.ok(
      c.protectorAfter < c.inheritanceAfter,
      `${t.id}: protectorAfter (${c.protectorAfter}) must be before inheritance (${c.inheritanceAfter}) so the protector can intervene before succession`,
    );
  }

  // Consent, when enabled, needs a real quorum.
  if (c.consentEnabled) {
    assert.ok(Number.isInteger(c.consentQ) && c.consentQ >= 1, `${t.id}: consentQ must be >= 1`);
    assert.ok(
      Number.isInteger(c.plannedConsenters) && c.plannedConsenters >= c.consentQ,
      `${t.id}: plannedConsenters must be >= consentQ`,
    );
  }

  // Every template must have at least one teaching scenario so Sage can
  // walk a "what happens if".
  assert.ok(Array.isArray(t.scenarios) && t.scenarios.length > 0, `${t.id}: needs at least one scenario`);
}

// TEMPLATE_TITLES must cover every template id exactly.
{
  const idSet = new Set(VAULT_TEMPLATES.map((t) => t.id));
  assert.equal(
    Object.keys(TEMPLATE_TITLES).length,
    idSet.size,
    'TEMPLATE_TITLES must have one entry per template',
  );
  for (const t of VAULT_TEMPLATES) {
    assert.equal(TEMPLATE_TITLES[t.id], t.title, `${t.id}: title map mismatch`);
  }
}

// 5. Sage's knowledge actually populates.
{
  const digest = renderTemplateDigest();
  assert.ok(typeof digest === 'string' && digest.length > 200, 'digest must be non-trivial');
  // The digest must reference real ids so the model proposes valid templates.
  assert.ok(digest.includes('family-inheritance'), 'digest must include real template ids');

  const chips = openingChips();
  assert.ok(Array.isArray(chips) && chips.length >= 3, 'opening chips must be a non-trivial array');
}

console.log(`template drift-guard passed (${VAULT_TEMPLATES.length} templates)`);
