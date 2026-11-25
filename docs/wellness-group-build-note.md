# Build note: a wellness-check group, designed into the vault

Status: NOTE ONLY. No code until the operator says go.

## The ask (operator, 2026-11-25, in his words)

"I really think the wellness check decision should be vault specific at set
up as an option for someone to add as many of those keys as they think they
need. And threshold of those wellness checks. Along with owner as a has to
sign. Just an example but you might want 3 of 5 people to verify everything
is kosher."

Then: "I just feel in a trust or legal frame work you [don't] blind anything.
But someone setting up a multi layer approach can use it as a create barrier
for attacker and allow time to move funds without the compromised leaf.
Should we give option to blind within a vault of a family though."

## The rule this note proposes

- Blinding belongs to ONE role: the wellness group. Its job is to confirm
  the person is safe, calm and not under pressure -- not to approve money.
- Every role with a trust or legal meaning (trustee, protector, beneficiary
  consent, heir, co-founder) always sees full spend details. No switch.
- In a family vault the builder may make the wellness group blind, and that
  is its default.
- A path that needs the wellness group must not be the vault's only way to
  move coins: a later path without the group keeps the vault from locking up
  if the checkers cannot be reached, and is where coins go if the owner's key
  is compromised.

## What is true today (read from the code)

- The path builder already expresses "owner must sign + K of N others": a
  path has keys and a quorum (`quorum`, `plannedKeys`) plus must-sign keys
  (`plannedRequired`, `mustSlot`, `required_keys`), checked against the
  compiled scripts (`lib/must-sign-check.ts`). Bitcoin enforces it.
- What a Tapit member sees is chosen per member on the Members tab
  (`review_mode` on the grant, shipped 2026-11-24), independent of the
  vault's design.
- The wizard already warns about risky shapes (`lib/path-risk.ts`,
  `pathNotes`, the dead-man's-switch card).

## What would be built

1. **Path builder: "Wellness check" as a path kind.** One tap adds a path
   shaped as: the owner (must sign) + a group of checkers + how many of them
   (e.g. 3 of 5), with plain words: "Before coins move this way, [3] of these
   [5] people confirm you are safe. They see no amounts unless you choose."
   The group's size and threshold are free; keys may be Tapit or hardware.
2. **Visibility follows the design.** The path's checkers are marked
   `wellness` in the vault's leaf data, sealed with the vault key like other
   path names. The Members tab shows each member's view as decided by the
   vault: wellness checkers blind by default (the builder can switch the
   group to full details); every other role full details, not switchable.
   The membership request carries it as today.
3. **The fallback rule** in `path-risk.ts`: a vault whose only immediate path
   needs the wellness group gets a card and a tick box -- "If [3] of these
   people can't be reached, the coins can only move by [the later path].
   Without a later path they cannot move at all." -- refusing to compile with
   no later path at all.
4. **The barrier wording** for the multi-layer case: a short note on the
   compiled vault: "If your own key is ever stolen, it is not enough on its
   own: it still needs [3] of your checkers. Move the coins through
   [recovery path] while they refuse."

## Decisions that are the operator's

1. **Who may be blind.** Only the wellness group (Recommended), or any
   member at the builder's choice.
2. **The wellness group's default view.** Blind (Recommended, matches "only
   need the wellness check part"), or full details.
3. **No later path.** Refuse to compile (Recommended), or allow it behind the
   card and tick box like the dead-man's switch.
4. **Today's per-member switch.** Replace it with the design-driven view
   (Recommended: one source of truth; existing members keep what they have
   until their vault is rebuilt or the request resent), or keep it as an
   override.

## Blast radius (read from the code, 2026-11-25)

- Wizard: `VaultWizard.tsx` (the path kind and its copy), `lib/path-risk.ts`
  (fallback rule + barrier wording), `lib/path-words.ts`, the leaf spec
  (`toLeafSpec` adds a `wellness` marker; no change to the script itself --
  owner + thresh is already what the compiler builds).
- Compile and storage: the marker rides in the leaf list the server already
  stores (`vaults.leaves`); no migration expected -- to be confirmed when
  reading `compile-leaves.js` before building.
- Members tab: `VaultMembershipSetup.tsx` reads the view from the vault
  instead of offering a choice (decision 4); the grant's `review_mode` keeps
  recording what was sent.
- Tapit: none -- it already shows what the signed membership says.
- Tests: the path kind compiles to owner AND K-of-N (signed and finalized
  through the offline harness); the fallback refusal; trust roles never
  blind; the Members tab reads the design.
- What people are told: the new path card's wording, the fallback card, the
  Members tab's view line.

## Deliberately left out

- Changing vaults already compiled (a vault's scripts are fixed; a new design
  means a successor vault).
- Making blind checkers able to stop a strange destination: they verify the
  person, not the payment -- the note says so where the group is chosen.

## Operator's decisions (2026-11-25)

1. Only the wellness group may be blind.
2. The wellness group is blind by default in a family vault.
3. No later path: refuse to compile.
4. Replace the per-member switch with the vault's design.
