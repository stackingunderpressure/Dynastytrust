// Binds apps/web/src/lib/vault-spending-paths.ts (the frontend's canonical
// "what are this vault's real spending paths" reader) to
// netlify/functions/_vault-shape.js (its Netlify-functions twin) --
// they cannot literally be one file (Netlify functions are plain Node
// ESM, the frontend is Vite-bundled TS), so this test runs both against
// the same fixtures and asserts byte-identical output. Without this,
// the two copies can silently drift the exact way eight-plus independent
// hand-written "what are this vault's spending paths" implementations
// already drifted across this repo (see CLAUDE.md's 2026-08-25 entries).
//
// Imports the real apps/web/src/lib/vault-spending-paths.ts directly via
// Node's native TS type-stripping -- no build step, no mocks, matching
// scripts/test-legacy-recovery.mjs's convention.

import assert from 'node:assert/strict';
import * as web from '../apps/web/src/lib/vault-spending-paths.ts';
import * as fn from './../netlify/functions/_vault-shape.js';

const FIXTURES = [
  // Leaf-list vault, two leaves -- the exact shape from the operator's
  // live "My Vault" that surfaced this whole bug family.
  {
    name: 'leaf-list: two leaves, one immediate one after',
    vault: {
      leaves: [
        { id: 'leaf_a', label: 'Everyday signers', keys: ['pub_a'], quorum: 1, unlock: { type: 'immediate' } },
        { id: 'leaf_b', label: 'Path 2', keys: ['pub_b'], quorum: 1, unlock: { type: 'after', blocks: 990193 } },
      ],
      founder_quorum: 2, founder_keys: [], heir_quorum: 2, heir_keys: [],
      recovery_after: 26000, inheritance_after: 52560,
    },
  },
  // Leaf-list vault with an OlderThan leaf and a decay-relevant quorum,
  // to exercise the 'older' branch and a >1 keyCount/quorum leaf.
  {
    name: 'leaf-list: older leaf + multi-key leaf',
    vault: {
      leaves: [
        { id: 'main', label: 'Trustees', keys: ['pk1', 'pk2', 'pk3'], quorum: 2, unlock: { type: 'immediate' } },
        { id: 'refresh', label: 'If untouched', keys: ['pk1', 'pk2'], quorum: 1, unlock: { type: 'older', blocks: 60000 } },
      ],
    },
  },
  // Named-field: the simplest shape, founders_now only.
  {
    name: 'named-field: founders only, no recovery/inheritance',
    vault: {
      leaves: null,
      founder_quorum: 1, founder_keys: ['fk1'],
      heir_quorum: 0, heir_keys: [],
      recovery_after: 0, inheritance_after: 0,
      backup_keys: [], backup_quorum: null,
      second_heir_keys: [], second_heir_quorum: null, second_inheritance_after: null,
    },
  },
  // Named-field: the full five-path shape (recovery + inheritance +
  // backup + second inheritance all configured).
  {
    name: 'named-field: all five paths configured',
    vault: {
      leaves: null,
      founder_quorum: 2, founder_keys: ['fk1', 'fk2', 'fk3'],
      recovery_quorum: 1, recovery_after: 26280,
      heir_quorum: 2, heir_keys: ['hk1', 'hk2'], inheritance_after: 52560,
      backup_keys: ['bk1', 'bk2', 'bk3', 'bk4'], backup_quorum: 3,
      second_heir_keys: ['sh1'], second_heir_quorum: 1, second_inheritance_after: 105120,
    },
  },
  // Named-field: recovery_quorum null falls back to founder_quorum.
  {
    name: 'named-field: recovery_quorum null falls back to founder_quorum',
    vault: {
      leaves: null,
      founder_quorum: 2, founder_keys: ['fk1', 'fk2'],
      recovery_quorum: null, recovery_after: 26280,
      heir_quorum: 0, heir_keys: [], inheritance_after: 0,
    },
  },
  // Named-field: heir_keys set but inheritance_after is 0 -- Gift
  // Locker-style shape with no inheritance leaf despite heir_keys
  // technically being non-empty in some legacy row shape.
  {
    name: 'named-field: heir_keys present but inheritance_after is 0 -- no inheritance leaf',
    vault: {
      leaves: null,
      founder_quorum: 2, founder_keys: ['fk1', 'fk2'],
      heir_quorum: 1, heir_keys: ['hk1'], inheritance_after: 0,
      recovery_after: 0,
    },
  },
  // Empty leaves array (not null) must be treated as named-field, same
  // as null -- a leaf-list vault always has leaves.length > 0.
  {
    name: 'named-field: leaves is an empty array, not null',
    vault: {
      leaves: [],
      founder_quorum: 1, founder_keys: ['fk1'],
      heir_quorum: 0, heir_keys: [], recovery_after: 0, inheritance_after: 0,
    },
  },
];

let ran = 0;
for (const { name, vault } of FIXTURES) {
  const webResult = web.getSpendingPaths(vault);
  const fnResult = fn.getSpendingPaths(vault);
  assert.deepStrictEqual(webResult, fnResult, `getSpendingPaths drift on fixture: ${name}`);
  assert.strictEqual(web.isLeafListVault(vault), fn.isLeafListVault(vault), `isLeafListVault drift on fixture: ${name}`);
  ran += 1;
}

// findSpendingPath: leaf-list lookup by real leaf id, and named-field
// lookup by the standard path id, both implementations agree.
{
  const leafVault = FIXTURES[0].vault;
  assert.deepStrictEqual(web.findSpendingPath(leafVault, 'leaf_b'), fn.findSpendingPath(leafVault, 'leaf_b'));
  assert.strictEqual(web.findSpendingPath(leafVault, 'leaf_b').unlockBlocks, 990193);
  assert.strictEqual(web.findSpendingPath(leafVault, 'nonexistent'), undefined);
  assert.strictEqual(fn.findSpendingPath(leafVault, 'nonexistent'), undefined);

  const namedVault = FIXTURES[3].vault;
  const recovery = web.findSpendingPath(namedVault, 'recovery');
  assert.strictEqual(recovery.quorum, 1);
  assert.strictEqual(recovery.unlockBlocks, 26280);
  assert.deepStrictEqual(recovery, fn.findSpendingPath(namedVault, 'recovery'));
}

// Must-sign keys and the consent group: both twins describe them the
// same way, and "fully signed" is decided by WHO signed, not how many.
{
  const K = (c) => '02' + c.repeat(64);
  const vault = {
    leaves: [
      { id: 'everyday', label: 'Everyday', required_keys: [K('a')], keys: [K('b'), K('c')], quorum: 1, unlock: { type: 'immediate' } },
      { id: 'later', label: 'Later', keys: [K('d'), K('e')], quorum: 2, unlock: { type: 'after', blocks: 900000 } },
      { id: 'second', label: 'Second open path', keys: [K('f')], quorum: 1, unlock: { type: 'immediate' } },
    ],
    consent_keys: [K('1'), K('2')], consent_quorum: 1,
  };
  assert.deepStrictEqual(web.getSpendingPaths(vault), fn.getSpendingPaths(vault));
  const [everyday, later, second] = fn.getSpendingPaths(vault);
  assert.deepStrictEqual(everyday.requiredKeys, [K('a')]);
  assert.deepStrictEqual(everyday.consent, { keys: [K('1'), K('2')], quorum: 1 });
  assert.strictEqual(later.consent, null); assert.strictEqual(second.consent, null);
  assert.deepStrictEqual(later.requiredKeys, []);
  for (const m of [web, fn]) {
    assert.strictEqual(m.signaturesNeeded(everyday), 3);
    assert.strictEqual(m.signaturesNeeded(later), 2);
    // Two phones and a consenter: three signatures, the must-sign key is not among them.
    const wrong = m.pathSignatureStatus(everyday, [K('b'), K('c'), K('1')]);
    assert.deepStrictEqual(wrong, { byName: true, satisfied: false, have: 2, need: 3, missingRequired: [K('a')], poolHave: 1, consentHave: 1 });
    // The must-sign key and a phone, no consent yet.
    assert.strictEqual(m.pathSignatureStatus(everyday, [K('a'), K('b')]).satisfied, false);
    // x-only form, other parity, upper case: still the same keys.
    const right = m.pathSignatureStatus(everyday, ['a'.repeat(64), '03' + 'B'.repeat(64), K('2')]);
    assert.deepStrictEqual(right, { byName: true, satisfied: true, have: 3, need: 3, missingRequired: [], poolHave: 1, consentHave: 1 });
    // A stranger's key and a key from another path count for nothing.
    assert.strictEqual(m.pathSignatureStatus(later, [K('d'), K('a'), K('9')]).have, 1);
    assert.strictEqual(m.pathSignatureStatus(later, [K('d'), K('e')]).satisfied, true);
    // An xpub on the path cannot be matched by name: fall back to the count, and say so.
    const named = m.getSpendingPaths({ leaves: null, founder_quorum: 2, founder_keys: ['tpubA', 'tpubB'], heir_keys: [], consent_keys: ['tpubC'], consent_quorum: 1 })[0];
    assert.deepStrictEqual(named.consent, { keys: ['tpubC'], quorum: 1 });
    assert.strictEqual(m.signaturesNeeded(named), 3);
    assert.deepStrictEqual(m.pathSignatureStatus(named, [K('x'.replace('x', '7')), K('8')]), { byName: false, satisfied: false, have: 2, need: 3, missingRequired: [], poolHave: 0, consentHave: 0 });
  }
  ran += 1;
}

// A step of a relaxing path, named the way a spend names it.
{
  const K = (c) => '02' + c.repeat(64);
  const vault = { leaves: [
    { id: 'main', label: 'Main', keys: [K('a')], quorum: 1, unlock: { type: 'immediate' }, decay: null },
    { id: 'kids', label: 'Kids', required_keys: [K('9')], keys: [K('b'), K('c'), K('d')], quorum: 3, unlock: { type: 'after', blocks: 950000 }, decay: { step_blocks: 52560, floor_quorum: 2 } },
  ] };
  for (const m of [web, fn]) {
    const rung = m.findSpendingPath(vault, 'kids_1');
    assert.strictEqual(rung.quorum, 2); assert.strictEqual(rung.unlockBlocks, 1002560);
    assert.deepStrictEqual(rung.requiredKeys, [K('9')]);
    assert.strictEqual(m.pathSignatureStatus(rung, [K('b'), K('c'), K('d')]).satisfied, false, 'the kids alone, without the must-sign key');
    assert.strictEqual(m.pathSignatureStatus(rung, [K('9'), K('b'), K('c')]).satisfied, true);
    assert.strictEqual(m.findSpendingPath(vault, 'kids_0').quorum, 3);
    assert.strictEqual(m.findSpendingPath(vault, 'kids_2'), undefined, 'below the floor');
    assert.strictEqual(m.findSpendingPath(vault, 'main_1'), undefined, 'not a relaxing path');
  }
  assert.deepStrictEqual(web.findSpendingPath(vault, 'kids_1'), fn.findSpendingPath(vault, 'kids_1'));
  ran += 1;
}

console.log(`vault-spending-paths tests passed (${ran} fixtures, web/functions byte-identical)`);
