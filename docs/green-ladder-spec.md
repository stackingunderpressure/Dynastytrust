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

## Resolved 2026-06-22 -- concentric trust rings (a FROST circle per rung)

Operator extension: a rung does not have to be one group decaying; it can be a
WHOLE social circle, and you can stack circles -- "a FROST leaf with my family,
then a FROST leaf with my friends, etc." This is the case that makes FROST earn
its place (the family-of-eight case did not need it).

- **Each rung is one circle = one FROST aggregate key.** A circle (family,
  friends, colleagues, community) runs its own DKG-or-dealer ceremony and collapses
  to a single on-chain `pk(AGG_circle)` with its own m-of-n threshold. The Taproot
  tree gets one leaf per circle, so even a twenty-person friends circle is one key
  on-chain -- which is exactly why FROST: a big circle as a raw `thresh` would be
  impractical, but as an aggregate it is a single clean leaf.
- **Rings ordered by timelock = trust distance.** Innermost ring (family) opens
  first (short or no timelock); each outer ring (friends, then wider) opens at a
  LONGER absolute-CLTV. The longer you are silent or unable to act, the wider the
  ring that can recover. This is the inheritance/recovery cascade made literal:
  family first, and only after a long wait do friends gain the ability to bring the
  coins back.
- **Each circle runs its own green/red/proof-of-life loop and its own duress +
  reshare economics.** A circle stays current by resharing its own roster without
  moving coins (FROST resharing, fixed aggregate key), and its members keep each
  other green and can flip red within that circle.
- **The timelock ordering is the real enforcement of "family before friends."**
  On-chain the chain only knows: each circle-leaf needs a valid aggregate signature
  (which requires that circle's threshold off-chain) AND its timelock height. So
  the sequence of who-can-recover-when is enforced by the ladder of timelocks, not
  by green; green coordinates within each ring. Honest consequence: once a friends
  ring's timelock matures, that circle CAN recover whether or not the family acted
  -- which is the intended cascade, so set each ring's timelock to match how long
  the inner rings should have exclusively, and choose outer rings knowing they
  become a real recovery path after their wait.

Honest lines for the rings: every added circle is another aggregate key and
another ceremony (DKG or dealer, teaching-gated per section 4) -- start with one or
two rings and climb, per the small-quorums-first spine. Outer, less-intimate rings
MUST carry longer timelocks (you do not want a broad, lightly-trusted circle moving
funds fast). And the bottom of the ladder remains a backstop that needs nobody, so
the cascade always terminates in something that cannot deadlock.

## Resolved 2026-06-22 -- 10 future-dated single-key leaves, provisioned later

Operator question: what stops me having 10 keys, each with a successive-year
timelock, each leaf one key, where that key can be a FROST aggregate set up later,
then revoked / reshared into a different ceremony or the next ring? The honest
answer turns on ONE Bitcoin rule, and within it the design works.

**Nothing stops the structure itself.** A Taproot tree with ten leaves, each
`and(after(year_k), pk(K_k))`, is fine -- Taproot holds many leaves; the control
block grows only with log(depth), negligible at ten. Each `K_k` can be a FROST
aggregate `pk(AGG_k)`. That part is exactly the ladder.

**The one hard rule: a Taproot address commits to ALL leaf pubkeys at funding
time.** The output key is `Q = P + taggedHash(TapTweak, P || merkle_root)*G`, and
`merkle_root` commits to every leaf script, each of which contains the literal
pubkey. So all ten `K_k` must be FIXED and KNOWN the moment you generate the
funding address. You cannot fund first and decide `K_5` later -- the address has
already committed to `K_5`. Change any leaf's pubkey and the merkle root changes,
the address changes, and the only way to "switch" is to MOVE THE COINS on-chain to
the new address. There is no on-chain "revoke this leaf" primitive; a committed
leaf is immutable until the coins move.

**How you still get "set it up / change it later" without moving coins: FROST
resharing.** Resharing (proactive secret sharing) redistributes the shares of the
SAME secret to a new roster or a new threshold while the aggregate pubkey
`pk(AGG_k)` stays identical -- so the leaf, the merkle root, and the address are
unchanged. That is precisely "use a different ceremony later / hand a leaf to the
next ring" done in place. What it does NOT let you do is swap to a genuinely
DIFFERENT key; the aggregate key is preserved by construction.

**So "provision year-10's circle later" has two honest paths:**

1. **Placeholder-then-reshare (no coins move).** Fix `K_10 = pk(AGG_10)` now -- even
   as a trivial 1-of-1 you alone control -- so the address can commit to it today,
   then RESHARE it into the real friends circle as year 10 approaches. The
   aggregate key never changes, so the address stays valid. Caveat: until you
   reshare, that leaf is recoverable only by the placeholder holder (you), which is
   fine for a far-future ring while you are alive -- but you MUST reshare it into
   its real circle before its timelock matures, or the placeholder is the only
   signer when the leaf opens.
2. **Re-vault (coins move).** Periodically spend to a freshly-committed tree with
   the newly-decided leaves. This is the plain-multisig path when you are not using
   FROST: every change to a future leaf is an on-chain move. Simpler crypto, costs
   a transaction and a re-commit each time.

**"Revoke" has three distinct meanings here, keep them separate.** On-chain: you
cannot revoke a committed leaf, but you can simply never USE it and let a different
leaf or a re-vault supersede it. Aggregate key: reshare it to a new circle (the
next ring) -- same key, new people, address unchanged. Attestation: tapit-attest
`revocation.ts` can revoke the OFF-CHAIN attestation that binds a circle to a leaf
as a coordination signal -- it records intent, it does not alter the on-chain leaf.

**Recommended shape:** commit all the future-dated aggregate keys up front
(placeholder 1-of-1 for the far rings you have not gathered yet), then reshare each
ring into place as its year approaches, keeping outer rings on longer timelocks and
a needs-nobody backstop at the floor. That gives you the ten-year ladder you
described, the freedom to decide and re-decide the people behind each rung over
time, and a fixed address that never has to move while you do it -- with the single
discipline that the aggregate KEY of each rung is chosen once, at the start, and
only its ROSTER changes thereafter.

## Mental model -- how a leaf "is timelocked to a FROST circle" (the unsticking)

The trap: imagining each leaf bound to a private key that someone holds. With
FROST there is NO single private key sitting anywhere. Hold these three frames:

- **One vault address, many doors.** All the leaves live in ONE Taproot tree, so
  there is ONE address and ONE pile of coins. Each leaf is a separate DOOR into
  that same pile. A door has two locks ANDed together: a TIME lock (`after(T_k)` --
  earliest height the door can open) and a SIGNATURE lock (`pk(AGG_k)` -- whose
  signature opens it). Your floor leaf is the door with no time lock and your own
  key -- always open to you, so you can always move the coins. The higher doors are
  the same pile, openable later, by other circles.
- **`pk(AGG_k)` is a PUBLIC key; the matching private key never exists in one
  place.** Circle k ran its own DKG, which produced one aggregate public key
  AGG_k (the only thing that goes in the leaf, on-chain) and gave each member a
  SHARE -- a private piece. There is no moment where the whole private key for
  AGG_k is assembled. To open door k, a threshold of circle k's members run a
  signing ceremony that jointly produces ONE ordinary Schnorr signature valid
  under AGG_k, without ever reconstructing the full key. The chain just checks
  "is this a valid signature for AGG_k, and is the height past T_k" -- it cannot
  tell a FROST-aggregated signature from a plain one.
- **Each circle is its own independent set of shares.** Family is one DKG ->
  AGG_1 + the family's shares. Friends is a SEPARATE DKG -> AGG_2 + the friends'
  shares. The family's shares can ONLY sign for AGG_1; the friends' only for
  AGG_2. So "different sets of FROST aggregation keys" means different circles,
  each with its own public key in its own leaf and its own scattered shares --
  cryptographically unrelated to the others and to your floor key. Reshuffling or
  red-flagging one circle touches only that circle's door.

Spending semantics that make the ladder work: whoever satisfies a door FIRST moves
the coins. While you are active you just use your floor door and none of the others
ever matter. If you go dark, the family door becomes openable at T_1, then the
friends door at T_2, and so on -- the timelocks are what sequence the circles, each
door waiting its turn, all opening the same pile.

## Resolved 2026-06-22 -- you cannot "shut" a matured door; you advance by re-vaulting

Operator question: once block height passes a door's timelock, that door is
openable -- how do you shut it in favor of the next period? Honest Bitcoin answer,
and it corrects a tempting mental model:

- **Absolute CLTV (`after(T)`) is "earliest", never "latest".** It sets a lower
  bound -- you cannot spend the leaf BEFORE height T -- and there is no opcode for
  an upper bound. Once height passes T, that door stays openable FOREVER while the
  coins sit at that address. Bitcoin can make you wait; it cannot forbid you from
  acting later. So you cannot script a window [T_k, T_{k+1}) that auto-closes.
- **Doors therefore ACCUMULATE, they do not hand off.** At year 3 the family door
  (year 1) and the friends door (year 2) are BOTH still open, plus year 3. The
  ladder is not a single moving window; it is more-and-more doors open as time
  passes. This is the honest shape and the design must respect it.
- **The only way to "shut" a door is to MOVE THE COINS.** All the doors guard the
  same one UTXO. Spend that UTXO through ANY door -- usually your floor door -- and
  every door on that address instantly dies, because the room behind them is now
  empty. The coins now live at a NEW address whose tree you rebuild with the
  windows pushed further out. That re-vault IS "advance to the next period." It is
  the heartbeat / refresh loop, and it is exactly why CLAUDE.md says the deadman is
  built by refresh/re-anchor, not an on-chain countdown.
- **So the cascade is kept honest by acting first + refreshing.** The soonest
  doors belong to the people you trust MOST precisely so they (or you via the
  floor) move the coins before the outer, less-intimate doors ever open. If you
  re-vault on a healthy cadence, an outer door's height arrives onto an address
  that is already empty.
- **The honest risk if you do NOT refresh:** a far door, once its height passes,
  leaves that circle permanently able to spend until the coins move -- stale open
  doors pile up as standing risk. Mitigation is the refresh cadence: re-vault to a
  fresh, advanced structure before (or as) each outer door matures, so matured
  doors never sit open over funds.
- **No covenant today can force this.** Bitcoin has no active covenant opcode
  (CTV/CCV not deployed), so you cannot make spending an inner door REQUIRE
  re-vaulting, nor make a door auto-expire. Advancing the ladder is a voluntary,
  coordinated refresh -- driven by your floor key or the active inner circle -- not
  something the script enforces. If covenants ever activate they could enforce
  auto-advance; do not design as if they exist.

Plain version: you do not close the old door, you empty the room. Your floor door
lets you re-vault any time, and that refresh is how the whole ladder steps forward
and stale doors stop mattering.

## Resolved 2026-06-22 -- the control model: present-only signing + burn-by-deletion

Operator framing: I am in control; the people holding my little secrets can only
sign what I PRESENT to them, never something they or anyone else created; I request
a signature only if needed; if not needed I can burn a door by deleting its secrets
past the timelock from where they live (my peer group and my wallet); the wallet
deletes the old only when not needed and moves on to the next future timelock;
otherwise I use the floor I control or wait for a later recovery path my groups can
reach. This is sound, with two honest refinements.

**Present-only signing -- correct, and this is the no-rogue-signing rail.** A
peer's honest wallet signs only the exact request you present through the attested
channel, showing its real meaning, and refuses anything not tied to a vault it
already holds a verified attestation for. So "they sign for me, not something they
or someone else made" is enforced at the honest-wallet + attested-trail + tap-to-
confirm-meaning level. The honest limit: that is coordination-layer enforcement,
not consensus. The HARD guarantee against a malicious threshold colluding off your
rails is the threshold itself (they still need t-of-n), the timelock (they still
cannot spend before the height), and your power to burn or re-vault. Keep both in
view: honest wallets enforce present-only; threshold + timelock + your floor are
the backstop if a circle goes rogue.

**Burn-by-deletion -- real, and it is the OFF-CHAIN way to shut a door.** Earlier
section: you cannot shut a matured door on-chain (timelock is earliest-not-latest).
But destroying the shares behind a door so the circle can no longer reach its
threshold makes that door permanently unopenable -- the leaf stays in the tree but
no valid signature for its key can ever be formed again. So deletion is exactly the
"shut it" mechanism. Two refinements that decide whether a burn is GUARANTEED:

- It only burns if enough shares are destroyed to drop BELOW threshold AND no
  recoverable copy survives anywhere -- every relevant peer must truly destroy
  theirs (backups, cloud sync, a forgotten export are the leak). For a circle of
  independent peers you cannot, by yourself, guarantee they deleted theirs. For a
  GUARANTEED unilateral burn, structure the door so YOU hold a share that is
  necessary to its threshold: then your deletion alone kills it, no trust required.
- Deletion disables a DOOR, not "the address." Coins still sitting there remain
  reachable by any OTHER live door and by your floor. To actually relocate funds
  you re-vault (move the coins); deletion and re-vault are complementary -- delete
  to neutralize a stale door, re-vault to move and reset the structure.

**Safety discipline (the line that protects against stranding funds).** Never
delete the shares of a door the coins still DEPEND ON as a needed path. This is
safe in your model precisely because your floor door is always yours -- you can
always move the coins yourself -- so pruning outer-ring shares can never lock you
out as long as the floor stays sacrosanct. The wallet's auto-GC must be
conservative: delete a share only after it has VERIFIED the coins no longer rely on
that door (e.g. after a confirmed re-vault to the new structure), never on a timer
alone -- don't-trust-verify before you destroy key material.

**A real upside: forward security.** Pruning retired shares means a LATER
compromise of a peer cannot resurrect a dead ring -- the secret is gone, so a door
you have moved past can never be reopened against you. Deliberate deletion of old
rings is good hygiene, not just housekeeping.

Net: you in control = floor door always yours; peers sign only what you present
(rails) with threshold + timelock as the collusion backstop; you shut a door by
destroying its shares below threshold (guaranteed only if you hold a blocking share
or all holders truly delete), you move money by re-vaulting, and you never prune a
door the funds still need -- the floor is what makes aggressive pruning safe.


