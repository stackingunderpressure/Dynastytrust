# UX coherence redesign -- one app, not eleven bolted-on pages

Status: design north-star (operator directive, 2026-06-22). Not a feature
spec -- the coherent target the whole UI moves toward, so future cuts
collapse sprawl instead of adding to it. Pairs with the teaching pedagogy
in `docs/sovereignty-education-bot.md` and `docs/chat-wizard-mediator.md`.

---

## The measure (the one test every screen must pass)

Operator refinement, 2026-06-22 -- the governing standard for the whole
redesign. Every screen, field, button, and default is measured against a
single sentence:

> **Does this keep the user safe -- from themselves AND from attackers --
> hide what they do not need to see, show only what they need, and teach
> what they need to know to be a more aware holder?**

Four parts, each load-bearing:

1. **Safe from themselves.** Fail-closed defaults; no naked footgun is ever
   a one-click choice; consequences shown before commitment (the behavior
   timeline, the floor warnings, the backup ritual). The app educates the
   user OUT of a bad decision rather than letting them stumble into it
   (`docs/threat-model-and-fail-closed.md`, Q3).
2. **Safe from attackers.** Tap-to-confirm the REAL destination + amount on
   the signing device; the fail-closed signing gate; the never-a-shortcut
   invariant; duress handling; hardware as the trusted display. The
   platform is never the weak link.
3. **Hide what they do not need.** The cryptography -- descriptors, PSBTs,
   sighashes, derivation paths, the jargon -- runs behind the scenes and is
   never shown. (Section 5.)
4. **Show only what they need + teach it.** The handful of things
   sovereignty truly requires -- who can spend and when, where the backups
   are, what is being signed -- shown in plain words, with Sage woven in to
   teach the why at the moment it matters (sections 4-5). The goal is an
   ever more AWARE holder, not a dependent one.

If a screen cannot justify itself against that sentence, it is cut or
redesigned. This is the lens for sections 1-9 below.

---

## 0. The operator's verdict (captured)

"I was in the wallet and I do not like the discombobulated pickers and
compilers and buttons -- it's overwhelming, no one's gonna use it. It's
bolting feature after feature; I say something, something gets added, and
it's not coherent -- you can see the dated separation where they don't
flow together. I want to roll all the ideas into a way better experience:
how the user comes to the wallet, the tab it picks, where it gets dropped
off. If they're making a vault, there aren't 5 billion templates to read
through -- it's 'this is what I want, this is what I'm gonna do.' When
someone signs up to start a wallet, or signs in to join one, they are not
left in the dark having to figure out cryptography. We bridge the gaps
into the newbie world, do the crazy math behind the scenes and hide it,
and show only what must be shown for security and sovereignty."

This note is the answer.

---

## 1. The diagnosis, grounded

The information architecture mirrors the TECHNICAL ASSEMBLY LINE, not the
human. Today's nav is literally the build pipeline exposed as navigation:

```
Keys  ->  Policy builder  ->  Vaults  ->  (Proposals)  ->  Reminders
 ^ generate    ^ compile        ^ list       ^ sign         ^ nag
```

Evidence of the seams:
- A brand-new user is dropped on `/keys` -- a cryptography page -- on first
  sign-in. The very first impression is jargon.
- Five top-level tabs are five technical stations. "Policy builder" is the
  tell: nobody thinks "I need to build a policy."
- `VaultDetail.tsx` is 6,134 lines; `PolicyBuilder` 2,588; `BlocBuilder`
  1,089 (a SEPARATE page bolted beside PolicyBuilder for the same job).
  Eleven page files, each its own visual + interaction dialect, each from
  a different week.
- Templates are a CATALOG to read through, not an intent to express.

The disease is not ugliness; it is INCOHERENCE -- the app makes the user
assemble the product in their head because the product is organized around
how it was built, not what it is for.

---

## 2. The reframe: organize around the journey, not the station

The user never sees "keys," "policy," or "compile" as places. Those are
steps inside a guided flow, or hidden entirely. The entire app collapses
into THREE journeys:

1. **START** -- "Protect my Bitcoin." One guided front door. Intent first
   ("what are you trying to do?"), then keys + policy + compile + fund all
   happen INSIDE it, mostly hidden, ending in a funded vault and the
   backup ritual. This absorbs KeyManager (generation), PolicyBuilder, and
   BlocBuilder into a single coherent flow.
2. **JOIN** -- "You've been invited to a vault." A co-signer (a kid, a
   trustee) lands on a role-aware, plain-language flow: here is the vault,
   here is your job, set up your key (guided), done. Never dropped into a
   crypto interface cold. This is the second front door, equal to START.
3. **LIVE** -- "My vaults / what needs me." One coherent home PER VAULT:
   balance, the behavior timeline (what can move, when, by whom), "what
   can I do now," requests + approvals, reminders. This absorbs Dashboard,
   VaultDetail, ProposalDetail, and Reminders into one surface.

Two front doors (START, JOIN) + one home (LIVE). That is the whole app.

---

## 3. Intent, not a template catalog

Replace "read 15 templates and guess which fits" with a short, plain
question and a few big, clear answers -- "this is what I want":

- "Just protect my own stack." (solo, intelligent-timelock starter)
- "Pass my Bitcoin to my kids." (the Dynasty Bloc shape)
- "A family treasury we run together." (multisig, no decay)
- "Don't let me lose it if I lose a device." (lost-device insurance)
- "Something a business holds." (treasury, no heirs)

The user picks the OUTCOME; the app chooses the shape behind the scenes.
Sage (the bot) does this conversationally for the unsure; the express path
is the same five choices as big cards. The dozens of fine-grained template
permutations stop being a menu and become defaults the chosen intent sets
-- tunable later in the LIVE surface for the few who care. (The behavior
timeline already built is how a tuned shape stays legible.)

---

## 4. The bot is connective tissue, not a tab

Sage is not `/assistant`, a place you go. It is the guide woven INTO every
step -- the persistent "explain this / what should I pick / what does this
mean" presence that bridges the newbie gap inline, then gets out of the
way. The same engine, surfaced where the decision is, never a detour to a
separate chat screen and back. (Pedagogy + safety rails already specified
in chat-wizard-mediator.md; this is about PLACEMENT.)

---

## 5. The hide/show line -- sovereignty, not cryptography

The governing UX rule, stated as two lists:

- **HIDE behind the scenes** (do the math, never show the jargon):
  descriptors, miniscript, PSBT hex, sighashes, derivation paths, xpubs,
  the words "compile," "leaf," "quorum," "tapscript." These are how it
  works, not what the user decides.
- **SHOW, in plain language** (sovereignty + security require it):
  who can spend and when (the timeline), where your backups are and whether
  they are safe, tap-to-confirm the REAL destination + amount on the
  signing device, the security floor and any weak point, the duress /
  heartbeat status. These are the irreducible verifications a sovereign
  holder must see -- so they are shown clearly, and nothing else is.

The test: a smart newcomer should complete START without learning a single
cryptography term, yet never be asked to blindly trust -- because every
consequential value is shown in words they already own.

---

## 6. The coherent shell (nav, reframed)

Replace `[Keys, Policy builder, Vaults, Assistant, Reminders]` with a nav
organized by journey:

- **Home** -- my vaults + what needs me (absorbs Vaults list + Reminders +
  pending approvals). The default landing for a returning user.
- **Start a vault** -- the guided intent-first front door (absorbs Policy
  builder + Bloc builder + key generation).
- **Learn / Sage** -- the education home, but Sage also appears inline
  everywhere (section 4).

Keys/devices become "Backups & devices" -- a SETTINGS-level surface inside
a vault or the account, not a top-level technical tab. The first thing a
new user sees is "What do you want to protect?", never the Key Manager.

---

## 7. Migration -- north star, collapse don't add

Honest: a full rewrite of 6k+1k+2k-line pages at once is huge and risky,
and money-touching flows must keep working throughout. So this is a
direction, walked incrementally, with one rule: **every cut from here
collapses sprawl toward the three journeys; nothing new gets bolted beside
the old.** Order by leverage:

1. **Front door + nav (highest leverage, lowest risk).** Change where a
   new user lands (intent question, not `/keys`) and reframe the nav around
   journeys. This transforms felt coherence WITHOUT touching the 6k-line
   VaultDetail. Cheapest, biggest impact -- do it first.
2. **The unified START flow.** One guided builder that absorbs key
   generation + policy + Bloc + compile + fund, intent-first. The existing
   PolicyBuilder/BlocBuilder/KeyManager become its internals or retire.
3. **The unified LIVE surface.** Collapse Dashboard + VaultDetail +
   ProposalDetail + Reminders into one per-vault home. (VaultDetail's 6k
   lines get decomposed here -- the riskiest, so it comes after the front
   door already proved the new shell.)
4. **JOIN.** Make the invite/claim flow role-aware and plain-language end
   to end (InviteClaim exists; reframe it into the JOIN journey).
5. Retire each technical tab as its function is absorbed.

The existing pages keep functioning during the transition; the NAV and the
FRONT DOOR change first, because that is where coherence is felt and where
the cost/impact ratio is best.

---

## 8. The one-line standard

When it is done, the app should feel like it was all made at the same
moment to solve one problem: help a normal person protect Bitcoin for the
people they love, without learning cryptography and without being asked to
trust blindly. Every screen earns its place against that sentence, or it
goes.

---

## 9. Self-critical note

The Dynasty Bloc builder added during this build is itself an instance of
the disease -- a separate `/policy/bloc` page bolted beside PolicyBuilder
for the same job. The redesign ABSORBS it as one intent ("pass it to my
kids") inside the unified START flow; it should not survive as a standalone
page. Captured so the fix is deliberate, not forgotten.
