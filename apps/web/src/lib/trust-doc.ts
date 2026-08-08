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
  const isGiftLocker = c.mode === 'inheritance' && !c.recoveryEnabled && c.plannedHeirs > 0;

  const purpose = templatePurpose
    ? `${vaultName} -- ${templatePurpose}`
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
  if (c.protectorEnabled) {
    rules.push(
      `A separate protector path lets ${c.protectorQ} of ${c.plannedProtectors} protector key${c.plannedProtectors === 1 ? '' : 's'} intervene after ${when(c.protectorAfter)} of inactivity -- an early safety valve to move funds to a fresh vault if something looks wrong, independent of the paths below.`,
    );
  }
  rules.push(
    'Add any real financial policy below -- spending caps, required approvals, what the funds are actually for -- as free text or as enforced per-proposal rules.',
  );

  const successionParts: string[] = [];
  if (c.mode === 'inheritance') {
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
// recovery_after/inheritance_after/protector_after are already ABSOLUTE
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
    protector_quorum: number | null;
    protector_keys: string[];
    protector_after: number | null;
    consent_quorum: number | null;
    consent_keys: string[];
  },
  tip: number | null,
): StandardConfig {
  const relative = (abs: number | null | undefined): number => {
    if (!abs || abs <= 0) return 0;
    if (tip == null) return abs; // tip fetch failed -- best effort, still non-negative
    return Math.max(0, abs - tip);
  };
  const hasHeirs = vault.heir_keys.length > 0 && vault.inheritance_after > 0;
  const hasProtector =
    vault.protector_keys.length > 0 && vault.protector_quorum != null && vault.protector_after != null;
  const hasConsent = vault.consent_keys.length > 0 && vault.consent_quorum != null;
  return {
    mode: hasHeirs ? 'inheritance' : 'plain',
    plannedFounders: vault.founder_keys.length,
    founderQ: vault.founder_quorum,
    plannedHeirs: vault.heir_keys.length,
    heirQ: vault.heir_quorum,
    recoveryEnabled: vault.recovery_after > 0,
    recoveryAfter: relative(vault.recovery_after),
    inheritanceAfter: relative(vault.inheritance_after),
    protectorEnabled: hasProtector,
    protectorAfter: hasProtector ? relative(vault.protector_after) : 0,
    protectorQ: vault.protector_quorum ?? 1,
    plannedProtectors: vault.protector_keys.length,
    consentEnabled: hasConsent,
    consentQ: vault.consent_quorum ?? 1,
    plannedConsenters: vault.consent_keys.length,
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
