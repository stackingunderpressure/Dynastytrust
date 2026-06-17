/**
 * vault-templates.js -- THE SINGLE SOURCE OF TRUTH for vault template
 * knowledge in DynastyTrust.
 *
 * One canonical, framework-free ESM data module. It is consumed by:
 *   - apps/web/src/pages/PolicyBuilder.tsx   (Vite + tsc, the compiler UI)
 *   - apps/web/src/pages/ChatWizard.tsx      (Vite + tsc, Sage's chat)
 *   - netlify/functions/assistant.js         (Netlify esbuild, Sage's brain)
 *
 * Why a plain .js (with a .d.ts sibling) and not a .ts:
 *   - The web tsconfig uses moduleResolution "Bundler"; a .js import with
 *     a co-located .d.ts type-resolves and Vite bundles it natively.
 *   - The Netlify function bundler is esbuild; it follows the relative
 *     import "../../apps/web/src/data/vault-templates.js" and bundles the
 *     same physical file into the function. (A .ts would force the
 *     function bundler to transpile TypeScript; a .js needs no transform.)
 *   Both paths were verified empirically before this file was written.
 *
 * HARD RAIL -- MONEY-TOUCHING:
 *   The `config` object on every template holds the COMPILE-CRITICAL
 *   structural values (mode, planned counts, quorums, timelock block
 *   offsets, protector/consent presence). PolicyBuilder feeds these to
 *   the Fly.io compiler. These values must NEVER drift. They are the
 *   exact same numbers PolicyBuilder used before this module existed.
 *   The drift-guard test (scripts/test-templates.mjs) asserts the
 *   invariants (unique ids, quorum <= count). Do not change a single
 *   quorum, count, timelock offset, or mode here without intending to
 *   change the vault shape itself.
 *
 * Sage's knowledge IS this data. The TEMPLATE_DIGEST the assistant feeds
 * the model is rendered from this array by renderTemplateDigest(), so the
 * bot can never invent a detail the app does not actually support.
 *
 * ASCII only. No private key, mnemonic, xpub, pubkey, or any secret ever
 * appears here -- this is public template shape + teaching content only.
 */

/**
 * @typedef {'plain' | 'inheritance'} VaultMode
 */

/**
 * @typedef {Object} TemplateConfig
 * @property {VaultMode} mode
 * @property {number} plannedFounders
 * @property {number} founderQ
 * @property {number} plannedHeirs
 * @property {number} heirQ
 * @property {number} recoveryAfter   absolute? no -- relative block offset
 * @property {number} inheritanceAfter
 * @property {boolean} [protectorEnabled]
 * @property {number} [protectorAfter]
 * @property {number} [protectorQ]
 * @property {number} [plannedProtectors]
 * @property {boolean} [consentEnabled]
 * @property {number} [consentQ]
 * @property {number} [plannedConsenters]
 */

export const VAULT_TEMPLATES = [
  {
    id: 'solo-savings',
    title: 'Solo Savings',
    tagline: '1-of-1 . No timelocks',
    description:
      'One person, one seed. The simplest possible Bitcoin wallet, with no inheritance path. Back up the seed on metal.',
    useCase:
      'One person, one seed. Simplest possible Bitcoin wallet. Back up the seed on metal; no inheritance path.',
    config: {
      mode: 'plain',
      plannedFounders: 1,
      founderQ: 1,
      plannedHeirs: 0,
      heirQ: 1,
      recoveryAfter: 0,
      inheritanceAfter: 0,
    },
    scenarios: [
      {
        title: 'You lose your seed',
        trigger: 'Device fails and you never wrote the seed words down.',
        outcome: 'Funds are gone. There is no recovery path in this template.',
        actions: [
          'Keep at least two metal backups of the seed before you fund the vault.',
          'If you only have plaintext backups, move to a Lost-Device Insurance vault instead.',
        ],
        severity: 'danger',
      },
      {
        title: 'You die',
        trigger: 'You pass away without your heirs knowing where the seed is.',
        outcome:
          'Bitcoin has no inheritance path in this template. Heirs need the seed words to recover.',
        actions: [
          'Leave the seed location in your legal will (not the words themselves).',
          'Consider upgrading to a Family Inheritance template for on-chain inheritance.',
        ],
        severity: 'warn',
      },
    ],
  },
  {
    id: 'couples',
    title: 'Couples',
    tagline: '2-of-2 . Both spouses sign',
    description:
      'Two partners jointly custody the stack. Every spend needs both signatures. No timelocks.',
    useCase:
      'Two partners jointly custody the stack. Every spend needs both signatures. No timelocks -- if one loses their key, recovery requires restoring from backup.',
    config: {
      mode: 'plain',
      plannedFounders: 2,
      founderQ: 2,
      plannedHeirs: 0,
      heirQ: 1,
      recoveryAfter: 0,
      inheritanceAfter: 0,
    },
    scenarios: [
      {
        title: 'One spouse loses their key',
        trigger: 'A device fails, a seed card is lost, or a key gets corrupted.',
        outcome:
          'You cannot spend without restoring the lost key. Assets are safe but immobile until recovery.',
        actions: [
          'Restore the lost key from its metal / paper backup into a new device.',
          'If no backup exists, sweep what you have after recovery and move to a Lost-Device Insurance template.',
        ],
        severity: 'warn',
      },
      {
        title: 'Divorce or serious disagreement',
        trigger: 'One spouse refuses to cooperate on any spend.',
        outcome:
          'Funds are frozen. 2-of-2 cannot spend unless both agree; there is no timelock override.',
        actions: [
          'Negotiate or mediate; on-chain there is no way to bypass.',
          'For futures with possible disputes, use a Family Inheritance or Generational Trust template so neutral trustees / timelocks exist.',
        ],
        severity: 'danger',
      },
      {
        title: 'One spouse dies',
        trigger: "Surviving spouse holds their key but the deceased's is inaccessible.",
        outcome:
          "Bitcoin has no inheritance path here. Survivor needs the deceased's seed words.",
        actions: [
          'Before funding, exchange sealed seed backups stored where the survivor can find them (lawyer, safe-deposit, executor).',
          'For on-chain-enforced inheritance, use a Family Inheritance template.',
        ],
        severity: 'warn',
      },
    ],
  },
  {
    id: 'family-inheritance',
    title: 'Family Inheritance',
    tagline: '2-of-3 trustees . 2-of-3 heirs . 6mo / 2yr',
    description:
      'Classic multi-generational setup. Three trustees share signing; after 6 months of silence they recover with a reduced quorum; after 2 years the heirs take over.',
    useCase:
      'Classic multi-generational setup. Three trustees share signing duty; after 6 months of trustee silence the same trustees can recover with a reduced quorum; after 2 years the heirs take over. Best starter shape for most families.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 3,
      heirQ: 2,
      recoveryAfter: 26280, // ~6 months
      inheritanceAfter: 105120, // ~2 years
    },
    scenarios: [
      {
        title: 'One trustee dies',
        trigger: 'One of the three trustees passes away.',
        outcome:
          'The remaining two trustees can still sign normally on Path 1 (2-of-3 is still met). No timelock needed.',
        actions: [
          'The two remaining trustees sign the next spend as usual.',
          'Consider recompiling the vault with a new third trustee added, rotating in a successor.',
        ],
        severity: 'info',
      },
      {
        title: 'A trustee loses their key',
        trigger: "A trustee's device fails or seed is lost.",
        outcome:
          'Path 1 still works (the other two sign). Path 2 recovery after 6mo lets trustees spend with a reduced quorum if a second key is also lost.',
        actions: [
          'Spend normally using the other two trustees.',
          'Replace the lost key by recompiling into a new vault and sweeping funds.',
        ],
        severity: 'warn',
      },
      {
        title: 'Beneficiary needs urgent funds',
        trigger: 'A family member asks for a distribution.',
        outcome:
          'Any 2 of 3 trustees can sign immediately on Path 1 -- no waiting, no timelock.',
        actions: [
          'Open the vault, tap Send, fill the distribution, and get two trustee signatures.',
          'Log the reason in the proposal memo so the audit trail captures it.',
        ],
        severity: 'info',
      },
      {
        title: 'All trustees go silent for 2 years',
        trigger: 'No trustee has acted (or can be reached) for 2 years.',
        outcome:
          'The inheritance path unlocks: 2 of 3 heirs can move funds to a fresh vault under their control.',
        actions: [
          'Any two heirs sign on the inheritance path to sweep the vault.',
          'Recompile a new vault with the heirs as new trustees.',
        ],
        severity: 'info',
      },
      {
        title: 'Two trustees collude to steal',
        trigger: 'Two of three trustees decide to take the funds for themselves.',
        outcome:
          'They can spend on Path 1 (quorum met). This template has no protector or beneficiary consent to block them.',
        actions: [
          'For significant estates, use the Generational Trust template instead -- it adds a protector path and optional beneficiary consent.',
          "At minimum, pick three trustees who don't all trust each other and who don't share a social circle.",
        ],
        severity: 'danger',
      },
    ],
  },
  {
    id: 'generational-trust',
    title: 'Generational Trust',
    tagline: '3-of-5 . protector . consent . 1yr / 3yr',
    description:
      'Institutional-grade: 5 trustees (3 needed), a protector who can rescue funds at 9 months, successors at 3 years, and a beneficiary-consent gate on every normal spend.',
    useCase:
      'Institutional-grade: 5 independent trustees (3 needed), a protector who can rescue funds at 9 months, successors take over at 3 years. Every day-to-day spend also requires one beneficiary signature so the family has veto power without custody burden.',
    config: {
      mode: 'inheritance',
      plannedFounders: 5,
      founderQ: 3,
      plannedHeirs: 3,
      heirQ: 2,
      recoveryAfter: 52560, // ~1 year
      inheritanceAfter: 157680, // ~3 years
      protectorEnabled: true,
      protectorAfter: 39420, // ~9 months
      protectorQ: 1,
      plannedProtectors: 1,
      consentEnabled: true,
      consentQ: 1,
      plannedConsenters: 1,
    },
    scenarios: [
      {
        title: 'Beneficiary refuses to cosign a spend',
        trigger: 'A trustee proposes a distribution; the beneficiary does not add their signature.',
        outcome:
          'Path 1 is frozen -- the consent gate blocks it. Trustees must wait for recovery (1yr) or protector (9mo) to unlock an alternate path.',
        actions: [
          'Talk to the beneficiary, understand the objection, amend the proposal.',
          'If the beneficiary is incapacitated or missing, the protector can rescue funds at 9 months.',
          'If nothing is resolved, recovery at 1 year lets trustees spend without consent.',
        ],
        severity: 'warn',
      },
      {
        title: 'Trustees try to collude and steal',
        trigger: '3 trustees agree to take funds for themselves.',
        outcome:
          'Path 1 is blocked by beneficiary consent. They must wait for recovery (1yr) or try the protector path (9mo, but the protector holds that key).',
        actions: [
          'The beneficiary refuses to cosign -- the consent gate is doing its job.',
          'Alert the protector; at 9 months they sweep funds to a new vault.',
          'File any off-chain legal action; Bitcoin has already bought you time.',
        ],
        severity: 'danger',
      },
      {
        title: 'Protector steps in at 9 months',
        trigger: 'Trustees have gone rogue or are unreachable; 9 months have elapsed.',
        outcome:
          'The protector path unlocks. The protector alone can move funds to a fresh vault with new trustees.',
        actions: [
          'Protector compiles a replacement vault first (new trustees, same heirs).',
          'Open the original vault, use the protector path to sweep to the new address.',
          'Record the reason in the audit trail for the attorney review.',
        ],
        severity: 'info',
      },
      {
        title: 'Trustee dies',
        trigger: 'One of the 5 trustees passes away.',
        outcome:
          '3-of-5 is still achievable (4 remain). Spending continues normally.',
        actions: [
          'Replace by recompiling with a new fifth trustee; sweep to new vault.',
        ],
        severity: 'info',
      },
      {
        title: 'All silent for 3 years',
        trigger: 'No trustee, protector, or beneficiary activity for 3 years.',
        outcome:
          'Inheritance path unlocks. Successor heirs (2 of 3) take over.',
        actions: [
          'Heirs sweep to a fresh vault that they control as the new trustees.',
        ],
        severity: 'info',
      },
    ],
  },
  {
    id: 'business-treasury',
    title: 'Business Treasury',
    tagline: '3-of-5 . No heirs . No timelocks',
    description:
      'Corporate cold storage. Five directors hold keys; any three can authorize a spend. No inheritance path because the business persists.',
    useCase:
      'Corporate cold storage. Five directors hold keys; any three can authorize a spend. No inheritance path because the business persists. Add directors or rotate keys by recompiling when needed.',
    config: {
      mode: 'plain',
      plannedFounders: 5,
      founderQ: 3,
      plannedHeirs: 0,
      heirQ: 1,
      recoveryAfter: 0,
      inheritanceAfter: 0,
    },
    scenarios: [
      {
        title: 'One director leaves',
        trigger: 'A key-holder resigns or is replaced.',
        outcome: '4 directors remain; 3-of-5 still achievable.',
        actions: [
          'Recompile into a new vault with a replacement director.',
          'Sweep funds from old vault to new before the departing director can collude (they still hold 1 of the 3 needed keys).',
        ],
        severity: 'warn',
      },
      {
        title: 'Director dispute',
        trigger: 'A minority bloc (1 or 2 directors) disagrees with a spend.',
        outcome: 'Any 3 of 5 can sign -- dissenters cannot block.',
        actions: [
          'Document the dispute in the proposal memo for corporate records.',
          'Run signing ceremony with any three willing directors.',
        ],
        severity: 'info',
      },
      {
        title: 'All keys lost',
        trigger: 'A catastrophic loss of seed backups across multiple directors.',
        outcome: 'Funds permanently unrecoverable. No timelock path in this template.',
        actions: [
          'Run regular signing drills (quarterly) to surface dead keys.',
          'Keep metal backups off-site and test restores yearly.',
          'For high-value treasuries, consider upgrading to Generational Trust shape with a recovery path.',
        ],
        severity: 'danger',
      },
    ],
  },
  {
    id: 'emergency-backup',
    title: 'Lost-Device Insurance',
    tagline: '2-of-3 . 6mo recovery',
    description:
      'Same-person multisig: you hold all three keys on three devices. Need 2 to spend; after 6 months of silence you can spend with just 1.',
    useCase:
      'Same-person multisig: you hold all three keys on three different devices. Need 2 to spend normally; after 6 months of silence you can spend with just 1. Saves the stack if one device is lost or destroyed.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 1,
      heirQ: 1,
      recoveryAfter: 26280, // ~6 months
      inheritanceAfter: 52560, // ~1 year
    },
    scenarios: [
      {
        title: 'Lose one device',
        trigger: 'One of three devices fails or is lost.',
        outcome: 'Other two devices still sign 2-of-3 on Path 1. No disruption.',
        actions: [
          'Spend normally with the remaining two.',
          'Buy a replacement device, recompile a fresh vault, sweep funds to it.',
        ],
        severity: 'info',
      },
      {
        title: 'Lose two devices',
        trigger: 'Two of three devices lost simultaneously (house fire, theft, shipwreck).',
        outcome:
          'Path 1 is blocked (only 1 key left). Wait 6 months -- recovery path opens so the remaining 1 key can spend.',
        actions: [
          'Do not panic: funds are safe, just immobile for 6 months.',
          'After the timelock, sign with the surviving device on the recovery path.',
          'Sweep to a new Lost-Device Insurance vault you build fresh.',
        ],
        severity: 'warn',
      },
      {
        title: 'Seed stolen',
        trigger: 'An attacker obtains one of your three seed backups.',
        outcome:
          'They have 1-of-3, which is not enough for Path 1. You have 6 months to act before the recovery path makes their 1 key sufficient.',
        actions: [
          'Immediately: build a new vault with fresh keys on new devices.',
          'Sign with your two remaining keys on Path 1, sweep funds to the new vault.',
          'Destroy any remaining old seeds (the compromised one is worthless once funds are moved).',
        ],
        severity: 'danger',
      },
      {
        title: 'Lose all three',
        trigger: 'All three devices and backups destroyed.',
        outcome: 'Funds permanently stuck.',
        actions: [
          'Always keep at least one metal backup of each seed off-site.',
          'Test the restore on each device quarterly.',
        ],
        severity: 'danger',
      },
    ],
  },
  {
    id: 'social-recovery',
    title: 'Self-Custody + Social Recovery',
    tagline: '2-of-3 you . 3-of-5 peers after 1yr',
    description:
      'You alone control the coins day to day (2-of-3 your own keys). If you go silent for a long time, a 3-of-5 quorum of trusted peers can rescue the funds -- but only after the timelock.',
    useCase:
      'You alone control the coins day to day with your own multisig (for example two hardware wallets plus one software key, 2-of-3). If you are ever locked out or go silent for a long time, a quorum of people you trust can rescue the funds -- but only after the timelock, and only as a group. Start with small amounts and a handful of close peers; the large-crowd version of this circle belongs off-chain as a FROST aggregate and is the later climb.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 5,
      heirQ: 3,
      recoveryAfter: 26280, // ~6 months -- your own keys, lower-friction self-recovery
      inheritanceAfter: 52560, // ~1 year -- the social-recovery leg unlocks for your peer quorum
    },
    scenarios: [
      {
        title: 'Everyday spending',
        trigger: 'You move funds normally.',
        outcome:
          'Your 2-of-3 signs on Path 1 instantly. No peer is involved and no one but you can move the coins.',
        actions: [
          'Spend with any two of your three keys.',
          'Moving the coins also refreshes the timelock -- see "You come back".',
        ],
        severity: 'info',
      },
      {
        title: 'Lose one of your own devices',
        trigger: 'One of your three keys is lost or destroyed.',
        outcome:
          'Your other two keys still sign 2-of-3 on Path 1. After ~6 months your own keys can also spend via the recovery path.',
        actions: [
          'Keep spending with the remaining two keys.',
          'Replace the device, build a fresh vault, and sweep funds to it.',
        ],
        severity: 'warn',
      },
      {
        title: 'You are locked out or go silent',
        trigger:
          'You lose enough of your own keys, are incapacitated, or simply stop touching the vault for a long time.',
        outcome:
          'After ~1 year with no activity, the social-recovery leg unlocks and a 3-of-5 quorum of your trusted peers can move the funds to rescue them.',
        actions: [
          'Your peers gather and sign 3-of-5 on the social-recovery path after the timelock.',
          'They sweep the funds to the destination named in your trust doc.',
          'Choose peers who will still be reachable years from now, and more than the quorum so a few being unavailable does not strand you.',
        ],
        severity: 'warn',
      },
      {
        title: 'A peer goes rogue',
        trigger: 'One of your five peers tries to take the funds, or you fear collusion.',
        outcome:
          'They cannot act: the social leg needs 3 of 5 AND stays locked until the ~1-year timelock passes, giving you a long window to react before any peer quorum could move a sat.',
        actions: [
          'While you are active the social leg is simply unspendable -- the timelock is your safety margin.',
          'If you distrust the circle, move the coins (which resets the clock) and rebuild with a new peer set.',
        ],
        severity: 'danger',
      },
      {
        title: 'You come back before the timelock',
        trigger: 'You were away but return before the social leg unlocks.',
        outcome:
          'Nothing was ever at risk. Moving the coins to a fresh vault output pushes the timelock back out ahead of you -- this is how the deadman stays armed without ever firing while you are alive.',
        actions: [
          'Spend or re-anchor the vault periodically to refresh the timelock.',
          'Treat a refresh like checking the batteries in a smoke detector.',
        ],
        severity: 'info',
      },
    ],
  },
  {
    id: 'test-family-inheritance',
    title: '[TEST] Family Inheritance',
    tagline: '2-of-3 . 2-of-3 heirs . 10 / 30 blocks',
    description:
      'Software-key sandbox for the Family Inheritance shape with timelocks in blocks (hours on signet) so every path can be exercised end-to-end.',
    useCase:
      'Software-key sandbox for the Family Inheritance shape. Recovery in ~10 blocks (~100 min on signet), inheritance in ~30 blocks (~5 hours). Verify every path end-to-end, then rebuild the real vault with production timelocks.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 3,
      heirQ: 2,
      recoveryAfter: 10,
      inheritanceAfter: 30,
    },
    scenarios: [
      {
        title: 'Test every path without waiting years',
        trigger: 'You want to see the recovery + inheritance paths actually unlock.',
        outcome:
          'Recovery opens ~100 min after compile; inheritance ~5 hours. Plenty of time to verify signing, broadcast, and role-specific behavior.',
        actions: [
          'Compile, fund from the signet faucet, send a normal spend first.',
          'Wait for tip to cross recovery_after; try a recovery-path spend.',
          'Wait longer; verify the inheritance path signs with heir keys alone.',
          'Once satisfied, recompile the production "Family Inheritance" template with real timelocks and fund that.',
        ],
        severity: 'info',
      },
    ],
    testMode: true,
  },
  {
    id: 'test-generational-trust',
    title: '[TEST] Generational Trust',
    tagline: '3-of-5 . protector . consent . 15 / 45 / 8',
    description:
      'Sandbox for the Generational Trust shape with protector + beneficiary-consent gate on short block timelocks for a one-afternoon dry run.',
    useCase:
      'Sandbox for the Generational Trust shape with its protector and beneficiary-consent gate. Protector unlocks at ~8 blocks, recovery at ~15 blocks, inheritance at ~45 blocks. Walk the full drama -- beneficiary refuses, protector steps in -- in one afternoon.',
    config: {
      mode: 'inheritance',
      plannedFounders: 5,
      founderQ: 3,
      plannedHeirs: 3,
      heirQ: 2,
      recoveryAfter: 15,
      inheritanceAfter: 45,
      protectorEnabled: true,
      protectorAfter: 8,
      protectorQ: 1,
      plannedProtectors: 1,
      consentEnabled: true,
      consentQ: 1,
      plannedConsenters: 1,
    },
    scenarios: [
      {
        title: 'Full governance dry-run',
        trigger: 'Walk the trust + beneficiary + protector + successor flows in one sitting.',
        outcome:
          'Enough window to test: beneficiary cosigns Path 1, beneficiary refuses, protector opens at 8 blocks and sweeps, successors inherit at 45 blocks.',
        actions: [
          'Fund, file a request, approve via trustee quorum + beneficiary consent.',
          'File another request; have the beneficiary refuse; confirm Path 1 is frozen.',
          'Wait for protector window; sweep to a replacement vault.',
          'Then recompile the production Generational Trust with the intended multi-year timelocks.',
        ],
        severity: 'info',
      },
    ],
    testMode: true,
  },
  {
    id: 'test-lost-device',
    title: '[TEST] Lost-Device Insurance',
    tagline: '2-of-3 . 12 / 30 blocks',
    description:
      'Short-timelock rehearsal for the Lost-Device shape so the 6-month recovery path can be observed in ~2 hours on signet.',
    useCase:
      'Short-timelock rehearsal for the Lost-Device shape. Lets you actually observe the 6-month recovery path by waiting ~2 hours on signet instead.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 1,
      heirQ: 1,
      recoveryAfter: 12,
      inheritanceAfter: 30,
    },
    scenarios: [
      {
        title: 'Lose two devices, wait, recover',
        trigger: 'Simulate losing 2 of 3 keys and using the 1-key recovery path.',
        outcome:
          'Fund, "lose" 2 keys (just don\'t sign), wait ~120 min, sign with the remaining key on the recovery path.',
        actions: [
          'Helpful to pair with the "Scan signed QR" flow to verify the air-gapped sign path.',
        ],
        severity: 'info',
      },
    ],
    testMode: true,
  },
  {
    id: 'test-social-recovery',
    title: '[TEST] Social Recovery',
    tagline: '2-of-3 you . 3-of-5 peers . 10 / 30 blocks',
    description:
      'Software-key sandbox for the Self-Custody + Social Recovery shape on short block timelocks so the peer-rescue drill can be rehearsed in an afternoon.',
    useCase:
      'Software-key sandbox for the Self-Custody + Social Recovery shape. Your own-keys recovery opens in ~10 blocks (~100 min on signet); the 3-of-5 social-recovery leg opens in ~30 blocks (~5 hours). Rehearse the full peer-rescue drill with play money, then rebuild the real vault with production timelocks.',
    config: {
      mode: 'inheritance',
      plannedFounders: 3,
      founderQ: 2,
      plannedHeirs: 5,
      heirQ: 3,
      recoveryAfter: 10,
      inheritanceAfter: 30,
    },
    scenarios: [
      {
        title: 'Rehearse the social rescue without waiting a year',
        trigger: 'You want to see the peer quorum actually unlock and sweep the funds.',
        outcome:
          'The own-keys recovery path opens ~100 min after compile; the 3-of-5 social leg ~5 hours. Enough time to rehearse the whole peer-rescue ceremony end to end.',
        actions: [
          'Compile, fund from the signet faucet, send a normal 2-of-3 spend first.',
          'Wait for tip to cross inheritance_after; have 3 of the 5 peer keys sign the social-recovery path.',
          'Verify they can sweep to the recovery destination with the holder absent.',
          'Once satisfied, recompile the production "Self-Custody + Social Recovery" template with real timelocks.',
        ],
        severity: 'info',
      },
    ],
    testMode: true,
  },
];

// Map of template id -> human-readable title. Derived from the canonical
// array so ChatWizard never hand-syncs a title.
export const TEMPLATE_TITLES = Object.fromEntries(
  VAULT_TEMPLATES.map((t) => [t.id, t.title]),
);

// The production (non-test) templates, in canonical order. Used to drive
// the opening common-path chips and the production grid.
export function productionTemplates() {
  return VAULT_TEMPLATES.filter((t) => !t.testMode);
}

// The test-mode templates, in canonical order.
export function testTemplates() {
  return VAULT_TEMPLATES.filter((t) => t.testMode);
}

// Look a template up by id. Returns undefined for an unknown id.
export function templateById(id) {
  return VAULT_TEMPLATES.find((t) => t.id === id);
}

// // -- Sage's knowledge digest ---------------------------------------
// Render the canonical array into the teaching prose the assistant feeds
// the model. Sage's knowledge IS this data: the model can describe any
// template and any scenario because the text below is generated from the
// same numbers PolicyBuilder compiles. Pure function, no side effects.

// One-line "shape" string from a config, e.g.
// "2-of-3 founders now, recovery after ~26,280 blocks, 2-of-3 heirs inherit
//  after ~105,120 blocks, protector at ~39,420 blocks, beneficiary consent".
function shapeLine(c) {
  const parts = [`${c.founderQ}-of-${c.plannedFounders} founders now`];
  if (c.recoveryAfter > 0) {
    parts.push(`recovery after ~${c.recoveryAfter.toLocaleString()} blocks`);
  }
  if (c.plannedHeirs > 0 && c.inheritanceAfter > 0) {
    parts.push(
      `${c.heirQ}-of-${c.plannedHeirs} heirs inherit after ~${c.inheritanceAfter.toLocaleString()} blocks`,
    );
  }
  if (c.protectorEnabled && c.protectorAfter) {
    parts.push(`protector at ~${c.protectorAfter.toLocaleString()} blocks`);
  }
  if (c.consentEnabled) {
    parts.push('beneficiary-consent gate on every normal spend');
  }
  if (c.recoveryAfter === 0 && c.inheritanceAfter === 0) {
    parts.push('no timelocks');
  }
  return parts.join(', ');
}

// Render every scenario into a compact teaching list so the model can
// answer "what happens if..." for ANY path the app supports.
function scenarioLines(scenarios) {
  return scenarios
    .map((s) => `     * ${s.title}: ${s.outcome}`)
    .join('\n');
}

/**
 * Render the full template knowledge into the digest string Sage's
 * system prompt embeds. Counts and shapes ONLY -- no key material can
 * appear here because the source data has none.
 *
 * @param {{ includeTest?: boolean }} [opts]
 * @returns {string}
 */
export function renderTemplateDigest(opts) {
  const includeTest = !!(opts && opts.includeTest);
  const prod = productionTemplates();
  const blocks = prod.map((t, i) => {
    return `${i + 1}. ${t.id} -- "${t.title}": ${t.description}
   Shape: ${shapeLine(t.config)}.
   What happens if:
${scenarioLines(t.scenarios)}`;
  });

  let out = `
VAULT TEMPLATES you can guide a person toward (use the exact template id in a proposal).
You know every detail below; describe any template or any "what happens if" scenario
accurately from this list and never invent a shape the app does not support:

${blocks.join('\n\n')}
`;

  if (includeTest) {
    const tests = testTemplates()
      .map((t) => `- ${t.id} -- "${t.title}": ${shapeLine(t.config)}.`)
      .join('\n');
    out += `
There are also [TEST] variants with timelocks measured in blocks (hours on signet)
for sandbox rehearsal -- only mention these if the person explicitly wants to
practice end-to-end before using real value:
${tests}
`;
  } else {
    out += `
There are also [TEST] variants of several templates with timelocks measured in
blocks (hours on signet) for sandbox rehearsal -- only mention these if the person
explicitly wants to practice end-to-end before using real value.
`;
  }

  out += `
TIMELOCK RULE OF THUMB (Bitcoin block heights): ~26,280 blocks = 6 months,
~52,560 = 1 year, ~105,120 = 2 years, ~157,680 = 3 years, ~262,800 = 5 years.
`;
  return out;
}

// // -- Opening common-path chips -------------------------------------
// The curated tap-able starting points shown before the first message.
// Derived from the SSOT: the most common production templates by title,
// plus two evergreen entries. Each chip's text is a full sentence the
// person can send as their opening message, so tapping it kicks the
// conversation off in a concrete direction.

// The most common starting templates, by id, in the order we surface them.
const OPENING_TEMPLATE_IDS = [
  'family-inheritance',
  'solo-savings',
  'couples',
  'generational-trust',
];

/**
 * The opening chips for the chat surface. Returns an array of short,
 * tap-able prompts derived from the canonical template list plus two
 * evergreen helpers. Pure -- safe to call on every render.
 *
 * @returns {string[]}
 */
export function openingChips() {
  const fromTemplates = OPENING_TEMPLATE_IDS.map((id) => {
    const t = templateById(id);
    return t ? `Tell me about ${t.title}` : null;
  }).filter((s) => typeof s === 'string');
  return [
    ...fromTemplates,
    'Which vault fits me?',
    'Let me just practice first',
  ];
}
