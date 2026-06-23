# Green-Ladder Spec -- the liveness tally on the decaying multisig

Status: design spec (operator chose "keep designing", 2026-06-22). Turns the
green-gated-FROST idea (`docs/green-gated-frost-and-liveness.md`) into a buildable
plan by grounding it on what is ALREADY shipped or designed, naming the narrow
new piece, and reconciling it honestly with FROST and with Bitcoin's actual
enforcement. Companions: `docs/layered-vault-legs-and-frost.md` (the ladder +
FROST + heartbeat loop), `docs/build-map-and-cut-lists.md` (risk register),
`docs/threat-model-and-fail-closed.md` (the fail-closed gate).

## What already exists (do NOT rebuild)

Grounded in the actual repo this session:

- **The decaying leaf ladder = Dynasty Bloc (shipped).** `db/migrations/023_bloc_vaults.sql`
  stores `bloc_policy` with the legs and their quorums + absolute timelocks:
  `parents_together_quorum`, `coparent_quorum`, `kids_with_parent_quorum`,
  `parent_solo_quorum`, `kids_decay_start_quorum`, `kids_decay_floor_quorum`,
  and the times `parent_solo_after`, `kids_decay_start_after`,
  `kids_decay_step_blocks`. The kids' quorum DECAYS from start to floor over
  time -- "fewer signers needed later" is already on-chain, as plain `multi_a`
  Taproot leaves (NOT FROST). The proposal `path` enum already includes
  `parents_now`, `coparent_kids`, `parent_solo`, `kids_decay`.
- **The red / duress state (shipped).** `vaults.duress` boolean + the fail-closed
  signing gate: when duress is set the gate denies (DURESS_HOLD) and funds fall to
  the timelock backstop -- the app stops helping, the chain's timelock is the only
  enforcement. That is exactly the operator's "red = a hard stop."
- **The heartbeat loop + the duress-vs-membership-loss split (designed).**
  `layered-vault-legs-and-frost.md` section 4: liveness heartbeat, reshare on
  membership loss behind a Bitcoin-confirmation objection window, duress dominates
  and aborts in-flight ceremonies, and "when ambiguous, read as duress."
- **FROST is a slot, not the everyday path (designed).** Sections 3 + 11g: plain
  per-signer `multi_a` is the everyday primitive; FROST is the slot you climb to
  for a large quorum or to rotate a roster without moving coins.

## What is NEW (the operator's contribution this session)

Today the gate is binary: `duress` true or false. The operator's idea
generalizes the negative-only flag into a **positive, three-state liveness tally
that selects which leaf the honest cohort completes**:

- **Green** -- a fresh, positive "I am calm, reachable, uncoerced" report.
- **Red** -- the existing duress/withdraw signal. Dominates everything; aborts
  the in-flight ceremony with fresh nonces; never just lowers a count.
- **No-report** -- silence / unreachable. Not green, not an abort; simply does
  not count toward a leaf's green requirement.

The family are the signalers, configured as an m-of-n, and (per the operator)
green and participation are unified: a member who is green is contributing; a
member who withdraws green or goes silent stops counting toward that leaf.

## How green selects a leaf (the honest mechanic)

The chain does not understand green. What the leaf enforces is its signature
quorum and its absolute-CLTV timelock. So "green selects the leaf" is precise:

1. For each leg, the ceremony computes a three-state tally over the family's
   currently-held, fresh liveness attestations.
2. The honest cohort completes the HIGHEST leg whose (a) timelock is already
   satisfiable AND (b) green count meets that leg's green requirement, with ZERO
   reds. The fail-closed gate refuses to help on any leg with insufficient green
   or any red present (a graduation of today's binary DURESS_HOLD).
3. If no leg currently clears, recovery decays down the ladder exactly as Bloc
   already does: a lower leg needs fewer signers but carries a longer timelock,
   so the family waits rather than failing. Green raises the bar on the fast legs;
   the timelock backstop underneath needs nobody.

Net: the green tally chooses WHICH already-existing Bloc leaf the honest cohort
drives and WHEN, and the fail-closed gate is what enforces "not enough green ->
do not help -> fall down the ladder." No new on-chain construct is required for
the family case.

## FROST reconciliation (small quorums first)

For a family of roughly eight, plain `multi_a` (what Bloc already compiles) is the
right primitive and NO FROST is needed -- the operator's "your FROST part" maps,
in the near term, to "your `multi_a` signature on the leg." FROST becomes the slot
only when a leg's quorum grows large (collapse many keys to one aggregate) or when
a roster must rotate without moving coins (section 4 resharing). The green tally is
identical either way: it gates whether your wallet contributes its part, be that a
`multi_a` signature today or a FROST signing-round share later. Build the green
ladder on plain multisig first; the FROST slot is a later, drop-in upgrade.

## Freshness, and "one signer, several secrets"

- **Fresh green only.** A green attestation carries a TTL (the heartbeat period).
  Past TTL it decays to no-report. Signing requires green that is fresh at
  ceremony time (re-attested), so a stale green can never be replayed to spend.
- **Red is sticky and dominates** until the person explicitly clears it;
  ambiguity reads as red/duress (existing rail).
- **One signer holding several secrets** maps naturally onto Bloc today: the same
  key already appears in several legs (a parent is in parents-together,
  coparent-kids, and parent-solo). Holding additional keys/shares mapped to later
  legs concentrates recovery onto fewer holders over time -- the deliberate
  inheritance decay. Honest line: a single key reused across legs can spend via
  ANY leg whose timelock has elapsed, so reuse-vs-distinct-keys per leg is a real
  security choice the founder should make with the teaching beside it.

## Worked example -- 8 family, "5 green, 0 red, 3 silent"

Two parents P, six kids K. Legs (green requirement, timelock): L1 parents-now
(both parents green, immediate); L2 coparent-kids (1 parent + 4 kids green,
immediate); L3 parent-solo (1 parent green, after T1); L4 kids-decay (kids quorum
decaying 4 -> 1 between T_start and floor). With 5 green / 0 red / 3 silent: if the
5 green include both parents, L1 completes now. If only one parent is green plus
three kids, L2 (needs 4 kids) does not clear now, so the family either waits for L4
where the decayed kids quorum is small enough, or waits for L3's parent-solo
timelock -- a longer wait, fewer people, exactly the graceful decay. A single red
anywhere holds the fast legs and pushes everything toward the timelock backstop.

## Honest lines (carry from the risk register)

- Bitcoin enforces only each leg's signature quorum and timelock; green is
  off-chain coordination enforced by honest wallets + the fail-closed gate.
- Security thins down the ladder by design; late legs MUST carry long timelocks
  and their few holders are the ultimate trust anchor -- past a long enough wait,
  the green gate no longer bites on a one-signer leg.
- Green vouchers count only from family the wallet holds verified attestations for
  (no rogue signing / matching attested trail).
- Red dominates and aborts the current ceremony, not just the next.

## Open decisions (the bounce-back list)

1. **Where green bites: wallet, app, or both?** Recommended both -- Tapit refuses
   to release its signing part unless the signer is green (defense at the key), AND
   DynastyTrust's gate refuses to drive a leg without the green quorum (defense at
   coordination). Confirm.
2. **Who can flip a member red** -- only the member (self-duress), any peer
   (peer-raised concern), a missed heartbeat (auto -> no-report, not red), or all
   three with different weights?
3. **Per-leg green requirement** -- is each leg's green quorum the same as its
   signature quorum, or a separate, possibly higher, liveness bar layered on top?
4. **Green attestation kind + transport** -- a new liveness attestation
   (green/heartbeat/red) on the Tapit encrypted inbox; define its fields, TTL, and
   how the tally is computed and shown.
5. **Dealer vs DKG** for any future FROST leg stays the teaching-gated founder
   choice already recorded in section 4 -- unaffected by the green layer.

## Resolved 2026-06-22 -- the green-state model (default-green, peers flip red)

Operator decision. Green is the RESTING state, not something re-vouched every
time:

- **You choose an indicate group** -- the circle of people around you, chosen
  deliberately (and they are exactly the attested-trail peers; a green/red signal
  is only counted from someone you hold a verified connection attestation for).
- **Green by default from the handshake.** When you add someone to your group the
  connection handshake establishes green; it stays green through further
  attestations. No constant "vouch I'm calm" ceremony -- frictionless by design.
- **Each peer is responsible for flipping RED.** Any member of your chosen group
  can raise red on you if they sense something wrong. Red is the active negative
  signal; green is the absence of red plus current freshness.
- **Freshness checks every so often (proof-of-life).** Periodically the group
  re-confirms you are alive/reachable -- a peer can prompt it ("daughter, check
  your wallet, prove I'm alive, it's been X since the last check"). If a freshness
  window lapses, your state DECAYS to no-report (not red): you simply stop counting
  until you prove alive again. This is the Layer-4 proof-of-life heartbeat made
  concrete and bidirectional.

So the three states resolve to: GREEN = fresh + no red; NO-REPORT = freshness
lapsed (absent/unreachable); RED = a chosen-group peer raised it (or you did, as
self-duress). This resolves open decision 2 (who flips red: any chosen-group peer,
plus self) and the green-source question (default-green + freshness, not
per-ceremony peer vouching).

### The honest gap, and the mitigation to decide

Default-green favors availability and friction-free living, but it has one honest
limitation that "don't trust, verify" demands we name: if you are alive but
COERCED and none of your peers notices to flip you red, you stay green and the
fast legs remain available. The freshness check defends the absent/incapacitated
case (no proof-of-life -> decay to no-report), and any alert peer defends the
visible-coercion case (flip red), and the timelock backstop is always underneath
-- but the "alive, coerced, unnoticed" case is the residual risk of a green-by-
default model.

The clean mitigation, and a real product fork to decide: a **duress code on the
proof-of-life check**. When prompted to prove you are alive, answering the normal
way keeps you green; answering with a pre-agreed duress variant proves you are
alive (so it does not look like absence) while SILENTLY flipping you red. That
closes the alive-but-coerced gap inside the same heartbeat the family already runs,
at the cost of a little teaching and a code to remember. It can be optional per
person. Recommended to include; flagged for the operator's call.

## Resolved 2026-06-22 -- the economics of duress (why it is cheap to click)

Operator reframe, and it is the keystone of the whole threat model: **duress is
meant to be easy to click because clicking it costs you almost nothing and costs
an attacker everything.** Belongs in `docs/threat-model-and-fail-closed.md`;
recorded here because it completes the green ladder.

- **Clicking duress = "fall to the timelock option + redo the signers."** A
  duress signal does not try to spend and does not hand anyone control. It aborts
  the current (possibly attacker-driven) ceremony and parks everything on the
  timelocked backstop leg -- the one that needs nobody -- while signalling that a
  fresh ceremony should redo the signers (a reshare to a clean roster). Per the
  existing rail you never reshare WHILE under the gun; the reshare is driven later,
  safely, by the unaffected quorum.
- **Timing is an independent hard gate.** A leg's signatures are only valid as a
  spend at the correct timing -- the absolute-CLTV timelock. Gathering signatures
  early buys nothing; the chain rejects the spend until the lock height. So an
  attacker who collects shares at the wrong time holds worthless paper.
- **Coercing at the wrong time yields only a re-ceremony.** Hack or coerce the
  family before the relevant timelock matures and all you achieve is forcing a new
  ceremony that rotates the signers out from under you -- you must then re-defeat a
  brand-new roster, and you still cannot spend until a timelock actually matures.
  Every duress click resets the board; the attacker can never get ahead of the
  clock.
- **The timelock fallback may never fire.** If the family keeps the upper, faster,
  more-signer legs healthy and reshares as people change (the heartbeat loop), the
  long-timelock backstop leg may never be needed at all -- it is the floor that is
  always there precisely so it rarely has to be used.

This is why duress should be one-tap and ubiquitous (the duress code above is one
such easy, covert trigger): making it cheap to fire is safe BECAUSE the worst case
is a re-ceremony plus a wait, never a loss. The honest dependency to keep in view:
this leans on resharing actually working (FROST resharing is frontier -- vetted
construction only) and on the family actually re-ceremonying after a duress event;
the absolute-CLTV timing gate, by contrast, is real on-chain consensus and needs
no one. Net: you cannot rush the timelock, and every coercion attempt only rotates
the signers, so coercion at the wrong time is economically futile.


