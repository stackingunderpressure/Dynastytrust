// Turns a compiled vault's REAL numbers -- its actual quorums, actual
// timelocks, actual chosen shape -- into a starting trust document,
// instead of the trust doc editor opening on a blank slate. The
// per-template `trustDoc` boilerplate in vault-templates.ts already
// carried a hand-written `purpose` line per shape (its doc comment even
// says "saved to the vault's trust_doc field right after compile" --
// that wiring never actually happened, so every vault has shipped with
// an empty trust doc regardless of template). This closes that gap AND
// goes further: `distribution_rules` and `succession_notes` are computed
// from the vault's own config, not copied template boilerplate, so a
// 2-of-3-turned-3-of-5 vault reads back its real numbers, not the
// template's defaults. Only the genuinely personal fields -- who the
// beneficiaries actually are, any custom financial policy -- are left
// for the owner to fill in from here.

import type { TrustDoc } from './api';
import type { StandardConfig, BlocConfig } from './vault-templates';
import { blocksToHuman } from './blocks';
import { approxWallclockDate } from './chain';

function when(blocks: number): string {
  return `roughly ${blocksToHuman(blocks)} (around ${approxWallclockDate(blocks).toLocaleDateString()})`;
}

export function buildStandardTrustDoc(opts: {
  vaultName: string;
  templatePurpose?: string;
  config: StandardConfig;
}): TrustDoc {
  const { vaultName, templatePurpose, config: c } = opts;
  const isGiftLocker = c.mode === 'inheritance' && !c.recoveryEnabled && !c.backupEnabled && c.plannedHeirs > 0;
  const isBackupOnly = c.mode === 'inheritance' && c.backupEnabled && c.plannedHeirs === 0;

  const purpose = templatePurpose
    ? `${vaultName} -- ${templatePurpose}`
    : isBackupOnly
      ? `${vaultName} is a ${c.founderQ}-of-${c.plannedFounders} Bitcoin vault with an always-available backup path (${c.backupQ}-of-${c.plannedBackups} separate keys, no timelock) instead of a timelocked recovery leg.`
      : c.mode === 'inheritance'
        ? `${vaultName} is a ${c.founderQ}-of-${c.plannedFounders} Bitcoin vault with an inheritance path to ${c.heirQ}-of-${c.plannedHeirs} successor keys.`
        : `${vaultName} is a ${c.founderQ}-of-${c.plannedFounders} Bitcoin vault. No inheritance path is configured -- only the founder quorum can ever spend.`;

  const rules: string[] = [
    `Day to day, any ${c.founderQ} of the ${c.plannedFounders} founder key${c.plannedFounders === 1 ? '' : 's'} can spend at any time -- no waiting, no timelock.`,
  ];
  if (c.consentEnabled) {
    rules.push(
      `Every one of those spends also requires ${c.consentQ} of ${c.plannedConsenters} beneficiary signature${c.plannedConsenters === 1 ? '' : 's'} -- the founders cannot move funds without at least one beneficiary agreeing.`,
    );
  }
  if (c.backupEnabled) {
    rules.push(
      `A separate backup path lets ${c.backupQ} of ${c.plannedBackups} backup key${c.plannedBackups === 1 ? '' : 's'} -- held by the founders themselves, kept apart from the day-to-day keys -- spend at any time, no waiting. This is not a committee override: it exists so the founders can always move funds even if the day-to-day quorum can't be reached, at the cost of more physical effort to gather the backup keys.`,
    );
  }
  if (c.secondInheritanceEnabled) {
    rules.push(
      `A second, independent inheritance path lets ${c.secondHeirQ} of ${c.plannedSecondHeirs} second-group heir key${c.plannedSecondHeirs === 1 ? '' : 's'} spend alone after ${when(c.secondInheritanceAfter)} -- a completely separate heir group and timeline from the inheritance path above, with no required ordering between the two.`,
    );
  }
  rules.push(
    'Add any real financial policy below -- spending caps, required approvals, what the funds are actually for -- as free text or as enforced per-proposal rules.',
  );

  const successionParts: string[] = [];
  if (isBackupOnly) {
    successionParts.push(
      `This vault has no separate inheritance leg -- the backup path (${c.backupQ}-of-${c.plannedBackups} keys, no timelock) is the only path beyond the day-to-day founder quorum. It is always available, not gated by time; the friction is retrieving enough of the backup keys, not waiting out a clock.`,
    );
    successionParts.push(
      'If estate planning / true succession also matters for these funds, pair this vault with a dedicated inheritance arrangement -- this shape intentionally does not provide one.',
    );
  } else if (c.mode === 'inheritance') {
    if (isGiftLocker) {
      successionParts.push(
        `This vault has no separate recovery path by design: before the gift date, only the ${c.founderQ}-of-${c.plannedFounders} founders together can spend. After ${when(c.inheritanceAfter)}, ${c.heirQ} of ${c.plannedHeirs} recipient key${c.plannedHeirs === 1 ? '' : 's'} can spend alone -- no founder signature needed, and no founder can block it once the date arrives.`,
      );
      successionParts.push(
        'If a founder key is lost before the gift date, the remaining founder(s) alone cannot spend early -- the gift stays frozen but safe until the date, when the recipient can still claim it on schedule.',
      );
    } else {
      successionParts.push(
        `If the founders go silent for ${when(c.recoveryAfter)}, the same ${c.founderQ}-of-${c.plannedFounders} founder quorum can still spend -- this rescues funds if a founder key goes missing without waiting for full inheritance.`,
      );
      successionParts.push(
        `If nobody spends at all for ${when(c.inheritanceAfter)}, ${c.heirQ} of ${c.plannedHeirs} successor key${c.plannedHeirs === 1 ? '' : 's'} can act without the founders. Name who holds those successor keys and how they should be reached below.`,
      );
    }
  } else {
    successionParts.push(
      'No inheritance path exists on this vault -- if every founder becomes unable to act, funds are stranded. Pair this with a separate inheritance vault, or reconfigure with heirs, if that risk matters.',
    );
  }

  return {
    purpose,
    distribution_rules: rules.join('\n\n'),
    succession_notes: successionParts.join(' '),
  };
}

// A draft vault compiled via the wizard (VaultWizard.tsx's runCompile)
// still has its timelocks as relative block counts at that point, so
// buildStandardTrustDoc above takes StandardConfig directly. But a draft
// resumed from VaultDetail -- members bring their own xpub via an invite
// link, then the owner hits "Compile" from DraftReadinessCard -- never
// passes through the wizard at all, and by the time compile() returns,
// recovery_after/inheritance_after are already ABSOLUTE
// CLTV heights, not relative offsets. This reprojects them back to
// "blocks from now" against the current chain tip so the same generator
// still reads as a countdown instead of quoting a raw absolute height as
// if it were a duration.
export function standardConfigFromCompiledVault(
  vault: {
    founder_quorum: number;
    founder_keys: string[];
    heir_quorum: number;
    heir_keys: string[];
    recovery_after: number;
    inheritance_after: number;
    consent_quorum: number | null;
    consent_keys: string[];
    backup_quorum?: number | null;
    backup_keys?: string[];
    second_heir_quorum?: number | null;
    second_heir_keys?: string[];
    second_inheritance_after?: number | null;
  },
  tip: number | null,
): StandardConfig {
  const relative = (abs: number | null | undefined): number => {
    if (!abs || abs <= 0) return 0;
    if (tip == null) return abs; // tip fetch failed -- best effort, still non-negative
    return Math.max(0, abs - tip);
  };
  const hasHeirs = vault.heir_keys.length > 0 && vault.inheritance_after > 0;
  const hasConsent = vault.consent_keys.length > 0 && vault.consent_quorum != null;
  const backupKeys = vault.backup_keys ?? [];
  const hasBackup = backupKeys.length > 0 && vault.backup_quorum != null;
  const secondHeirKeys = vault.second_heir_keys ?? [];
  const hasSecondInheritance =
    secondHeirKeys.length > 0 && vault.second_heir_quorum != null && vault.second_inheritance_after != null;
  return {
    mode: hasHeirs ? 'inheritance' : 'plain',
    plannedFounders: vault.founder_keys.length,
    founderQ: vault.founder_quorum,
    plannedHeirs: vault.heir_keys.length,
    heirQ: vault.heir_quorum,
    recoveryEnabled: vault.recovery_after > 0,
    recoveryAfter: relative(vault.recovery_after),
    inheritanceAfter: relative(vault.inheritance_after),
    consentEnabled: hasConsent,
    consentQ: vault.consent_quorum ?? 1,
    plannedConsenters: vault.consent_keys.length,
    backupEnabled: hasBackup,
    backupQ: vault.backup_quorum ?? 1,
    plannedBackups: backupKeys.length,
    secondInheritanceEnabled: hasSecondInheritance,
    secondInheritanceAfter: hasSecondInheritance ? relative(vault.second_inheritance_after) : 0,
    secondHeirQ: vault.second_heir_quorum ?? 1,
    plannedSecondHeirs: secondHeirKeys.length,
  };
}

// The generic leaf-list ("custom builder") vault has no fixed shape to
// hang a hand-written narrative on the way Standard/Bloc do -- but every
// path it CAN have (immediate / after a fixed date / if untouched for a
// while, each with its own quorum and optional step-down) is fully
// mechanical, so a real trust doc can still be generated from it, same
// as the other two. This was the actual gap: VaultWizard.tsx's leaf-list
// compile branch had a comment explaining why it left the doc blank
// ("no template to draw from") -- there was a template, it just hadn't
// been written yet.
export interface LeafDocInput {
  label: string;
  plannedKeys: number;
  quorum: number;
  unlockType: 'immediate' | 'after' | 'older';
  afterBlocks: number;
  olderBlocks: number;
  decayEnabled: boolean;
  decayFloorQ: number;
}

export function buildLeavesTrustDoc(opts: {
  vaultName: string;
  leaves: LeafDocInput[];
}): TrustDoc {
  const { vaultName, leaves } = opts;
  const immediate = leaves.filter(l => l.unlockType === 'immediate');

  const purpose = immediate.length > 0
    ? `${vaultName} is a custom-built Bitcoin vault with ${leaves.length} spending path${leaves.length === 1 ? '' : 's'}. Day to day, ${immediate.map(l => `${l.quorum} of ${l.plannedKeys} "${l.label}" key${l.plannedKeys === 1 ? '' : 's'}`).join(' or ')} can spend at any time, no waiting.`
    : `${vaultName} is a custom-built Bitcoin vault with ${leaves.length} spending path${leaves.length === 1 ? '' : 's'}, each opening only under a specific condition -- see below. No path here can spend without waiting first; confirm that is actually intended.`;

  const rules: string[] = leaves.map(l => {
    if (l.unlockType === 'immediate') {
      return `"${l.label}": ${l.quorum} of ${l.plannedKeys} key${l.plannedKeys === 1 ? '' : 's'} can spend at any time, no waiting.`;
    }
    if (l.unlockType === 'after') {
      const decay = l.decayEnabled ? ` The number of signers required steps down the longer it waits, down to a floor of ${l.decayFloorQ}.` : '';
      return `"${l.label}": ${l.quorum} of ${l.plannedKeys} key${l.plannedKeys === 1 ? '' : 's'} can spend after ${when(l.afterBlocks)} -- a fixed calendar date that does not move regardless of activity.${decay}`;
    }
    const decay = l.decayEnabled ? ` The number of signers required steps down the longer it stays untouched, down to a floor of ${l.decayFloorQ}.` : '';
    return `"${l.label}": ${l.quorum} of ${l.plannedKeys} key${l.plannedKeys === 1 ? '' : 's'} can spend if the vault sits completely untouched for about ${blocksToHuman(l.olderBlocks)} -- any normal spend from any path resets this clock back to the start.${decay}`;
  });
  rules.push(
    'Add any real financial policy below -- spending caps, required approvals, what the funds are actually for -- as free text or as enforced per-proposal rules.',
  );

  const successionParts: string[] = [];
  const laterPaths = leaves.filter(l => l.unlockType !== 'immediate');
  if (immediate.length === 0) {
    successionParts.push('No path here can spend without waiting for a timelock -- confirm that is actually intended before funding this vault.');
  }
  if (laterPaths.length === 0) {
    successionParts.push(
      'No fallback or succession path exists on this vault -- if every day-to-day key becomes unavailable, funds are stranded. Pair this with a separate recovery or inheritance path if that risk matters.',
    );
  } else {
    successionParts.push(
      `Beyond day-to-day use, ${laterPaths.length} more path${laterPaths.length === 1 ? '' : 's'} exist for when things go wrong or enough time passes: ${laterPaths.map(l => `"${l.label}"`).join(', ')}. Name who actually holds each of those keys, and how they should be reached, below.`,
    );
  }
  successionParts.push(
    'Any path timed "if untouched for a while" is a proxy for a real-world determination (incapacity, going silent), not the same thing as one -- the moment an actual determination is made through the process this trust document names, hand off deliberately by rotating the vault to the responsible party\'s own keys rather than waiting out the on-chain clock.',
  );

  return {
    purpose,
    distribution_rules: rules.join('\n\n'),
    succession_notes: successionParts.join(' '),
  };
}

export function buildBlocTrustDoc(opts: {
  vaultName: string;
  config: BlocConfig;
}): TrustDoc {
  const { vaultName, config: c } = opts;

  const purpose =
    `${vaultName} is a Dynasty Bloc vault: ${c.plannedParents} parent key${c.plannedParents === 1 ? '' : 's'} hold full control now, and control decays toward the ${c.plannedKids} kids over time as they grow up, rather than transferring all at once on a single future date.`;

  const rules: string[] = [
    `Together, ${c.parentsTogetherQ} of the ${c.plannedParents} parents can spend at any time -- the normal, day-to-day path.`,
  ];
  if (c.plannedParents > 1) {
    rules.push(
      `Either parent can also act with ${c.kidsWithParentQ} of the ${c.plannedKids} kids alongside them -- useful once the kids are old enough to co-sign but a parent is still present.`,
    );
    rules.push(
      `A single parent, alone, can spend after ${when(c.parentSoloAfter)} of the other parent's inactivity -- the co-parent recovery path.`,
    );
  }
  rules.push(
    'Add any real financial policy below -- spending caps, required approvals, what the funds are actually for -- as free text or as enforced per-proposal rules.',
  );

  const successionParts: string[] = [
    `If the parents are gone or unreachable, the kids can act on their own on a decaying quorum: starting ${when(c.kidsDecayStartAfter)} from now, ${c.kidsDecayStartQ} of ${c.plannedKids} kids can spend together; every additional ${blocksToHuman(c.kidsDecayStepBlocks)} after that, the required quorum drops by one, down to a floor of ${c.kidsDecayFloorQ} of ${c.plannedKids}.`,
    'This is a gradual handoff, not a single inheritance date -- the vault keeps working as the kids grow up and as their number of available signers changes, rather than assuming every one of them is reachable the moment a fixed date arrives.',
  ];

  return {
    purpose,
    distribution_rules: rules.join('\n\n'),
    succession_notes: successionParts.join(' '),
  };
}
