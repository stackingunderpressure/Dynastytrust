// Shared vault-education logic and content -- one source of truth so the
// SAME computed sentences appear both in the new /start/:layerId concept
// pages (VaultLayerGuide.tsx) and live inside the builder (VaultWizard.tsx),
// instead of two hand-written copies that drift apart. Split out of
// VaultWizard.tsx (2026-08-17 front-door redesign) rather than duplicated.
//
// Never says "leaf" or "quorum" in any string returned here --
// docs/ux-coherence-redesign.md section 5 -- every sentence is written the
// way the rest of the app already talks: "path," "how many people must
// agree," plain consequences.

import { blocksToHuman } from './blocks';
import type { StandardConfig } from './vault-templates';
import type { SpendLeg } from '../components/vault-builder';

// ── Consequence sentences ──────────────────────────────────────────────

// Generalizes the hand-written key-loss sentences already sitting in every
// VaultTemplate.scenarios[] entry (vault-templates.ts) into something
// computed live from the operator's actual quorum/count for THIS path,
// instead of static per-template text that goes stale the moment a quorum
// is tuned away from the template's own defaults.
export function keyLossLine(quorum: number, total: number): string {
  if (total <= 0) return '';
  if (quorum >= total) {
    return `If any one of these ${total} ${total === 1 ? 'key is' : 'keys is'} lost, this path can never be used again.`;
  }
  const spare = total - quorum;
  return `This path can lose up to ${spare} of these ${total} and still work -- the remaining ${quorum} can act.`;
}

// Standalone version of keyLossLine for an illustrative example that isn't
// tied to a specific configured path yet (the front-door concept pages) --
// same computation, phrased for "here's what this trade-off means" rather
// than a specific leg's own consequence line.
export function quorumTradeoffLine(quorum: number, total: number): string {
  if (total <= 0) return '';
  if (quorum >= total) {
    return `Every one of these ${total} must agree -- the safest bar, but losing even one key freezes this path for good.`;
  }
  const spare = total - quorum;
  return `Any ${quorum} of these ${total} can act. Lose ${spare === 1 ? 'one' : `up to ${spare}`} and the rest can still move funds -- lose more than that, and this path is dead until a backup kicks in.`;
}

// Minimal structural shape leafFloorWarningText actually needs -- avoids
// importing VaultWizard.tsx's LeafDraft here (which would create a
// circular import, since VaultWizard imports FROM this file). LeafDraft
// already satisfies this shape structurally, so no cast is needed at the
// call site.
interface DecayLeafLike {
  enabled: boolean;
  decayEnabled: boolean;
  decayFloorQ: number;
  label: string;
}

// A leaf-list vault's decay-enabled paths bottoming out at a floor of 1
// eventually let a single key spend alone -- flag every offender by name
// rather than assuming there's only ever one (Bloc's own hardcoded
// "kid ladder" warning is the one-path special case of this).
export function leafFloorWarningText(drafts: DecayLeafLike[]): string | undefined {
  const offenders = drafts.filter(l => l.enabled && l.decayEnabled && l.decayFloorQ === 1);
  if (!offenders.length) return undefined;
  const names = offenders.map(l => `"${l.label}"`).join(', ');
  return `Heads up: ${names} eventually lets a SINGLE key spend alone. Consider a floor of 2 or higher -- so no one lost or stolen key is ever enough on its own.`;
}

// ── Live cross-role key-reuse warning ──────────────────────────────────

export interface KeyReuseRole {
  id: string;
  label: string;
  keys: { keyId: string }[];
}

// Client-side approximation of the compiler's own find_key_reuse
// (policy_compiler.rs) -- computed here instead of waiting on a compile
// round trip, so the warning shows up the moment a key is picked into a
// second path, not after. Shared by every shape's Keys step (standard AND
// leaves) so both compute the same way instead of two copies of the same
// loop drifting apart.
export function keyReuseNotes(roles: KeyReuseRole[]): Map<string, string> {
  const notes = new Map<string, string>();
  for (const role of roles) {
    const elsewhere = roles.filter(o => o.id !== role.id);
    const reusedInto = new Set(
      elsewhere
        .filter(o => o.keys.some(ok => role.keys.some(mk => mk.keyId === ok.keyId)))
        .map(o => o.label),
    );
    if (reusedInto.size) {
      notes.set(
        role.id,
        ` Heads up: one of the keys picked below is also used in ${Array.from(reusedInto).join(', ')} -- that key can spend either path once that path's own conditions are met, not just this one.`,
      );
    }
  }
  return notes;
}

// ── Standard-shape BehaviorTimeline parity ─────────────────────────────

// Converts a standard-shape config (founders/backup/recovery/heirs/
// second-inheritance) into the same SpendLeg[] shape
// BehaviorTimeline already consumes for Bloc and the leaf-list builder --
// the timeline component itself needs zero changes, it just gets a new
// caller. Consent is deliberately NOT its own leg here: it's a modifier
// gate on the founders' path (every founder spend also needs consent),
// not an alternative way in, so it's folded into the founders leg's own
// meaning text instead of appearing as a separate timeline entry.
export function buildStandardLegs(config: StandardConfig): SpendLeg[] {
  const legs: SpendLeg[] = [];

  legs.push({
    label: 'Everyday signers',
    who: `${config.founderQ} of ${config.plannedFounders}`,
    afterBlocks: 0,
    requiredSigners: config.founderQ,
    meaning: config.consentEnabled
      ? `Any normal spend, right away -- also needs ${config.consentQ} of ${config.plannedConsenters} beneficiary-consent signatures every time.`
      : 'Any normal spend, right away.',
    weak: config.founderQ === 1,
  });

  if (config.backupEnabled) {
    legs.push({
      label: 'Backup',
      who: `${config.backupQ} of ${config.plannedBackups}`,
      afterBlocks: 0,
      requiredSigners: config.backupQ,
      meaning: 'A separate set of keys, also right away -- for when the everyday signers above are lost, unavailable, or compromised.',
      weak: config.backupQ === 1,
    });
  }

  if (config.recoveryEnabled) {
    legs.push({
      label: 'Recovery',
      who: `${config.founderQ} of ${config.plannedFounders}`,
      afterBlocks: config.recoveryAfter,
      requiredSigners: config.founderQ,
      meaning: `From ${blocksToHuman(config.recoveryAfter)} after funding, your everyday signers can act again -- a second chance before the heir-only path opens.`,
    });
  }

  if (config.mode === 'inheritance' && config.plannedHeirs > 0) {
    legs.push({
      label: 'Heirs',
      who: `${config.heirQ} of ${config.plannedHeirs}`,
      afterBlocks: config.inheritanceAfter,
      requiredSigners: config.heirQ,
      meaning: `From ${blocksToHuman(config.inheritanceAfter)} after funding, your heirs can spend on their own -- your everyday signers no longer have a say.`,
      weak: config.heirQ === 1,
    });
  }

  if (config.secondInheritanceEnabled) {
    legs.push({
      label: 'Second inheritance',
      who: `${config.secondHeirQ} of ${config.plannedSecondHeirs}`,
      afterBlocks: config.secondInheritanceAfter,
      requiredSigners: config.secondHeirQ,
      meaning: `From ${blocksToHuman(config.secondInheritanceAfter)} after funding, a second, independent group of heirs can spend on their own.`,
      weak: config.secondHeirQ === 1,
    });
  }

  return legs;
}

// ── Front-door layer-concept content ───────────────────────────────────

export interface VaultLayer {
  id: string;
  title: string;
  tagline: string;
  explanation: string;
  tradeoffs: string[];
  illustration: { title: string; lines: string[] };
  howToCraft?: string;
}

// Four fixed pages, not a template gallery -- the front door teaches the
// MECHANISM a vault is assembled from, not which of N named presets to
// pick. Prose here is adapted from the scenario playbooks already written
// per template in vault-templates.ts (e.g. Family Inheritance's "One
// trustee dies" / "A trustee loses their key" / "Two trustees collude to
// steal" scenarios generalize directly into Primary Path's teaching)
// rather than invented from nothing -- reusing real prior writing,
// restructured around layers instead of templates.
export const VAULT_LAYERS: VaultLayer[] = [
  {
    id: 'primary',
    title: 'Primary Path',
    tagline: 'Your everyday signers -- always on, no waiting',
    explanation:
      'Every vault has one always-on path: a group of signers who can move funds the moment enough of them agree. '
      + 'This is the path you actually use. How many people you require, and how many you keep in reserve, is the '
      + 'first and most important trade-off in the whole vault.',
    tradeoffs: [
      'Fewer required signers is frictionless -- but if you require ALL of them (unanimous), losing even one key freezes this path forever.',
      'More required signers is safer against any one person going rogue or losing a key -- but slower to act, since more people have to be reachable at once.',
      'A quorum below unanimous always carries a collusion risk: enough of the group agreeing (even wrongfully) can move funds. Pick signers who do not all trust each other and do not share one social circle.',
    ],
    illustration: {
      title: 'Three ways to set the same 3 signers',
      lines: [
        quorumTradeoffLine(3, 3),
        quorumTradeoffLine(2, 3),
        quorumTradeoffLine(1, 3),
      ],
    },
  },
  {
    id: 'backup',
    title: 'Backup & Recovery',
    tagline: 'A second way in if the primary path stops working',
    explanation:
      'The primary path is only as good as its signers staying reachable. A backup path gives you a second, '
      + 'separate way to move funds if the everyday signers above are ever lost, unavailable, or compromised -- '
      + 'either a separate set of keys that works right away, or the SAME everyday signers regaining access after '
      + 'a waiting period.',
    tradeoffs: [
      'A separate backup key set works with zero wait, but only helps if you actually keep those keys somewhere different and harder to reach than your everyday signers -- that difficulty is the point, not a flaw.',
      'A timelocked recovery path (same signers, after a delay) needs no extra key set, but the wait length is a real trade-off: too short and a bad actor who compromises a device can just wait it out; too long and a genuine emergency waits too.',
      'A vault can have one of the two, not both -- they occupy the same structural slot.',
    ],
    illustration: {
      title: 'What a lost key actually costs you',
      lines: [
        'No backup path: lose the primary quorum, and funds are stuck until the inheritance wait finishes -- if there even is one.',
        'With a backup path: the same loss just means switching to the separate backup keys, no waiting.',
        'With a recovery path instead: the same everyday signers get a second chance to act, once the wait you set has passed.',
      ],
    },
  },
  {
    id: 'inheritance',
    title: 'Inheritance',
    tagline: 'Hands off to the next generation, on its own timeline',
    explanation:
      'A separate group of heirs, with their own keys and their own waiting period, who can spend on their own once '
      + 'the wait finishes -- and NOT before, and never alongside your everyday signers once it opens. This is how '
      + 'a vault survives you without needing anyone else\'s cooperation.',
    tradeoffs: [
      'A short wait hands off sooner, which matters if your everyday signers might genuinely become unreachable (illness, death, a lost generation of keys) -- but it also means a shorter window to notice and fix a mistake before heirs gain full control.',
      'A long wait keeps you in control longer and gives more time to catch problems, but funds stay locked from heirs for that entire stretch even in a real emergency.',
      'You can add a second, independent inheritance group with its own timing -- a spouse who should be able to act sooner, and extended family who wait longer, for example.',
    ],
    illustration: {
      title: 'What "after a wait" actually means',
      lines: [
        'Before the wait finishes: only your everyday signers (and backup, if you added it) can move funds -- heirs cannot act early no matter what.',
        'After the wait finishes: your heirs can move funds on their own -- your everyday signers no longer have a say, even if they are still around.',
      ],
    },
  },
  {
    id: 'backstop',
    title: 'Long-Horizon Backstop',
    tagline: 'How to get crafty -- decay ladders and self-refreshing paths',
    explanation:
      'Beyond a fixed primary/backup/inheritance structure, you can build paths that change shape over time. A decay '
      + 'ladder starts by requiring everyone in a group and quietly needs one fewer person every so often, so losing '
      + 'a key over the years does not eventually lock everyone out. A self-refreshing path stays strict as long as '
      + 'you actually use the vault, and only relaxes if it sits completely untouched for a long stretch -- any '
      + 'normal spend resets the clock back to full strength.',
    tradeoffs: [
      'A decay ladder trades early strictness for long-term resilience -- great for a group of heirs you expect to slowly lose touch with over decades, risky if the floor is ever set to 1 (a single surviving key becomes enough alone).',
      'A self-refreshing path only helps a vault you actually use -- if you fund it once and never touch it again, "untouched for a while" starts on day one, which may not be what you want.',
      'These can combine with a fixed calendar backstop too: an emergency path after a few years, a full hand-off after longer, and a last-resort path decades out in case everything else has failed by then.',
    ],
    illustration: {
      title: 'A 5-signer group, decaying over time',
      lines: [
        'Starts needing all 5 to agree, from the moment this path opens.',
        'One fewer required every set interval after that.',
        'Bottoms out at a floor you choose -- never let that floor be 1, or a single remaining key becomes enough alone.',
      ],
    },
    howToCraft:
      'Decay ladders and self-refreshing paths live under "More: crafty or specialty paths" in the builder\'s shape '
      + 'tabs -- they need more than a fixed founders/heirs shape can express.',
  },
];
