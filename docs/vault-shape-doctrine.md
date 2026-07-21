# Vault-shape doctrine -- curated structures, machine-validated parameters

Status: adopted 2026-07-20 (operator decision). This governs how many vault
shapes exist and how flexibility is offered. Where an older "flexible compiler"
assumption conflicts, this doc wins.

---

## 1. The decision

DynastyTrust ships a **small, fixed set of vetted vault STRUCTURES** with **free,
machine-validated PARAMETERS** inside each, selected by **conversation** (Sage).
It does NOT ship an open miniscript-authoring surface. The engine's job is to
VALIDATE a parameterized instance of a known structure, not to let anyone author
an arbitrary new structure.

This is the escape from the combinatorial wall. "One million miniscript
variations" conflates two different things:

- **Structure** -- the topology: how many Taproot leaves, which spending paths
  exist, how the and/or/thresh nesting is arranged. A new structure is a new
  thing nobody has drilled. This is the dangerous infinity, and we fix it at a
  handful.
- **Parameters** -- the numbers inside a fixed structure: founder count and
  quorum, heir count and quorum, timelock durations, which keys. A 2-of-3 and a
  3-of-5 founders leaf are the SAME structure. These vary freely and are proven
  correct per-instance by rust-miniscript's round-trip on every compile (the
  descriptor compiles, the address re-derives, the tree is single-sourced with
  the PSBT builder). We do NOT hand-check these; the machine does.

So the product is not "six rigid scripts" and not "a million hand-verified
ones." It is a few vetted structures, each with real parameter freedom, each
proven per instance by the compiler.

## 2. Why small is a security property, not a limitation

Fixing the structure count is the ONLY thing that makes the acceptance test
matrix **finite and completable**. With 7-8 structures times their spending
paths, "test every shape, every path on signet" is an afternoon of work and a
hard gate we can actually finish. With an open authoring surface it is infinite
and therefore untestable -- and that untestability IS the risk in
money-touching, irreversible software.

This finiteness is also the promise Nunchuk structurally cannot make. Nunchuk
has the engine but no conversation; it can build an arbitrary policy but cannot
tell you which one your family needs or promise every path of it has been
exercised. We do the opposite: the conversation maps a messy human situation
onto the right drilled archetype, fills its parameters, and teaches what happens
when a trustee dies or a beneficiary won't cosign. The curated set and the
conversation are complementary -- the conversation is worthless if it outputs an
untested bespoke script and powerful if it outputs one of a few drilled shapes.

## 3. The archetypes (the finite set)

Human inheritance and shared-control patterns cluster into a handful of shapes.
These are the vetted structures; everything else is parameters.

1. **Solo custody** (`solo-savings`) -- 1-of-1, no timelock.
2. **Simple shared, no timelock** (`couples` 2-of-2, `business-treasury` 3-of-5)
   -- plain `thresh(k, keys)`, one structure at different parameters.
3. **Founders-now + heirs-later** (`family-inheritance`) -- the core dynasty
   shape: founders-now leaf, timelocked recovery leaf (founders, reduced
   quorum), timelocked inheritance leaf (heirs).
4. **+ Protector** (`generational-trust`) -- adds an independent protector leaf
   between recovery and inheritance.
5. **+ Beneficiary-consent gate** (`generational-trust`) -- founders-now path is
   consent-gated; the timelocked paths intentionally are not.
6. **Self-recovery / lost-device** (`emergency-backup`) -- same-person multisig
   with a reduced-quorum recovery timelock.
7. **Social recovery** (`social-recovery`) -- you-now, plus a peer quorum after a
   long timelock.
8. **Decaying / vesting** (`dynasty-bloc`) -- a multisig that decays over time /
   tranche legs that unlock at set heights.

That is essentially the whole space of real trusts. New structures are **parked**
(living-ideas discipline) and built only when a real family actually needs one --
never speculatively, and each new structure updates this doc and the gate ceiling.

## 4. Rulings

- **No free-form authoring.** The app must never expose a raw-miniscript / raw-
  policy input. Vaults are compiled from structured parameters of a vetted shape
  only. (Confirmed today: `miniscript_policy` appears in the builder solely as a
  read-only compiled output.)
- **Parameter freedom stays.** Families are not forced into rigid numbers;
  counts, quorums, and timelocks vary within a shape and are validated per
  instance.
- **The engine is a validator behind the conversation, not an authoring
  playground in front of it.** rust-miniscript's round-trip is kept precisely
  because it proves each parameterized instance -- that is what lets us offer
  flexibility without hand-checking a million scripts.
- **Arbitrary-policy ambitions are out of scope.** Bespoke policy authoring
  serves a power user who is Liana's/Sparrow's customer, not ours. The Dynasty
  Bloc is a *specific vetted shape* (decaying multisig, archetype 8), not a
  free-form hatch.
- **The finite test matrix is the acceptance gate.** "Every shape, every path,
  green on signet" (section 5) is the bar before a shape is trusted with real
  value.

## 5. Signet coverage matrix (the acceptance gate)

Each vetted shape must have every spending path exercised end-to-end on signet
(build -> register on a device -> fund -> propose -> sign both in-app and on
hardware -> merge -> finalize -> broadcast). Status is honest: PENDING until a
real signet run confirms it. Test-mode (`test-*`) templates exist precisely to
walk the timelocked paths in hours.

| Shape | founders-now | recovery | inheritance | protector | consent gate | decay/social |
|---|---|---|---|---|---|---|
| solo-savings | PENDING | -- | -- | -- | -- | -- |
| couples | PENDING | -- | -- | -- | -- | -- |
| business-treasury | PENDING | -- | -- | -- | -- | -- |
| family-inheritance | PENDING | PENDING | PENDING | -- | -- | -- |
| generational-trust | PENDING | PENDING | PENDING | PENDING | PENDING | -- |
| emergency-backup | PENDING | PENDING | -- | -- | -- | -- |
| social-recovery | PENDING | PENDING | PENDING (peer leg) | -- | -- | PENDING |
| dynasty-bloc | PENDING | -- | PENDING (kids leg) | -- | -- | PENDING (decay legs) |

Update a cell to VERIFIED (with the broadcast txid) only after a real signet
round-trip. This table is the operator's "I'll test each one" turned into a
tracked, finite checklist.

## 6. Mechanism

`scripts/check-vault-shapes.mjs` (wired into `npm test`) enforces the finite set:
the production shape count stays within the curated band, every shape declares a
known `mode`, and compilation is parameter-driven (structured keys + quorums, not
a raw policy string). Adding a shape past the ceiling fails the build, which
forces the deliberate "is this a real new archetype?" decision and an update to
this doc -- the discipline, made mechanical.
