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

## The duress phrase today, and what this slice must add (checked 2026-11-25)

Operator: "Already talked about this thought we had duress words" -- then
"Yes, check it and add to the note", on whether a duress phrase from one
checker stops the others.

What happens now (read from the code):
- Tapit (`SignApprovalScreen.tsx`, `circlePhrase.ts`): the checker types the
  phrase the owner reads them. The duress phrase makes THAT phone refuse and
  show, in red, "That was the duress phrase. Do not approve this request",
  telling the checker to contact the other members and the authorities by
  another channel, and that the owner should halt the vault.
- Nothing is sent anywhere. The result lives only on that screen
  (`phraseResult` is component state; `checkCirclePhrase` resets its
  counter and records nothing). The other checkers are not told, DynastyTrust
  is not told, and the same request reopened -- or the next one -- is not
  held.
- The vault halt (`vaults.duress`, "blocks every signing path") can be set
  only by the vault's OWNER (`vaults.js` PATCH matches `user_id`) -- the one
  person who, in this situation, is under duress.
- A signed duress signal already exists: Tapit's liveness feature can raise a
  `duress-flag`, which DynastyTrust's server verifies (`_liveness.js`) and its
  signing gate treats as red (`liveness-gate.ts`, `evaluateSigningGate`). But
  the phrase check does not raise one, and Tapit's co-signing does not check
  for red flags before signing (`signPsbtCosign.ts` reads neither).
- The phrase is only asked above the vault's live-check amount
  (`requiresCallbackConfirmation`); a smaller spend asks no phrase at all.

So with 3 of 5 checkers, an attacker can keep calling until 3 sign: the one
who heard the duress phrase refuses, and nothing stops the next.

What this slice adds:
1. **The duress phrase raises the signed duress flag automatically** -- the
   existing `duress-flag` signal, signed by the checker's own key, sent the
   way liveness signals already go, for this vault. Nothing new for the
   checker to do in the moment.
2. **Every checker's Tapit refuses while a red flag stands** for that vault:
   `signPsbtCosign` reads the vault's flags first and refuses with "Someone
   in this vault's circle reported duress. Nothing will be signed until the
   owner and the circle clear it together."
3. **DynastyTrust holds the whole vault** on a red flag from a member,
   exactly as its signing gate already does for liveness red -- the owner's
   own signer refuses too, and the vault page says why.
4. **Clearing it takes more than the owner**, because the owner may be the
   one under pressure: the decision for the operator below.
5. **In a vault with a wellness group, every spend on that path asks for the
   phrase**, not only spends above the live-check amount -- the group exists
   to confirm the person on every move.

Further decisions for the operator:
5. Who can clear a duress hold: the owner AND a quorum of the circle
   (Recommended -- the same 3 of 5), or the owner after a waiting period, or
   the owner alone.
6. Whether a duress hold also tells the other checkers immediately (a Tapit
   notice: "a duress phrase was used for this vault -- do not sign, call the
   others") (Recommended), or only blocks silently when they are asked.

Operator's answers (2026-11-25):
5. A duress hold is cleared only by the owner AND the circle's quorum (the
   same threshold as the wellness path).
6. The other checkers are told at once: their Tapit shows "A duress phrase
   was used for this vault. Do not sign. Call the others."

## Slice 2 addendum: the plumbing the note assumed does not fit (2026-11-25)

Slice 1 (the wellness path, views from the design, the fallback refusal,
the phrase on every wellness spend) is built: DynastyTrust c3f0e16, Tapit
9b25aad, held for the ship word.

Reading the code for slice 2 contradicted "sent the way liveness signals
already go":
- `netlify/functions/liveness.js` accepts a signal only from a signed-in
  DynastyTrust member of the vault (`requireUser`, `isActiveMember`). A Tapit
  checker has no DynastyTrust account.
- The signing gate applies red flags only when the vault has a liveness
  circle (`loadVaultLivenessConfig` reads `vault.bloc_policy.liveness` -- the
  Bloc shape). A path-builder vault has none, so red flags are ignored there.
- DynastyTrust's functions send no cross-site headers, so Tapit's site cannot
  call them today.
- The flags are about a PERSON (subject key), not a vault.

What slice 2 actually needs:
1. **A vault duress notice** -- a small message signed by the checker's own
   Tapit key, naming the vault, minted the moment the duress phrase is typed.
2. **Getting it to DynastyTrust.** Options (operator's decision 7):
   - (a) Tapit posts it straight to a new DynastyTrust function
     (`/api/vault-duress`) that accepts it ONLY if its signature is from a
     key that accepted membership in that vault (`vault_membership_grants`,
     status accepted) -- no account needed, nothing else accepted -- and puts
     the vault on hold at once (`vaults.duress`, which every DynastyTrust
     signing path already honours), recording it in the vault's history.
     Needs cross-site headers on that one function for Tapit's site only.
     (Recommended: it works even if the owner's own device is in the
     attacker's hands.)
   - (b) Nostr only, through the reply channel each member's request
     already has: DynastyTrust holds the vault when the OWNER'S browser next
     receives it -- which depends on the device an attacker may be holding.
3. **Telling the other checkers**: the request carries the Tapit keys of the
   other people on the same wellness path; the notice goes to each over Nostr
   (a new event kind beside the membership ones); their Tapit shows "A duress
   phrase was used for this vault. Do not sign. Call the others." and refuses
   that vault until cleared.
4. **Clearing (decision 5: owner + quorum)**: a table of clear approvals (one
   migration, shipped first): the owner asks from DynastyTrust, and K checkers
   each send a signed clear from Tapit to the same function; at K the hold
   lifts and a signed "cleared" notice goes to every checker.
5. Tests: notice signed by a non-member refused; a member's notice holds the
   vault; a second checker's Tapit refuses after the notice; clear below
   quorum keeps the hold; at quorum it lifts.

Blast radius beyond the note: a new public (signature-checked) function and
its cross-site headers, one migration, a new Nostr event kind in both apps,
the membership request gaining the circle's keys.
