# Long-Horizon Sovereign Vault + the Buried Social Backstop

Captured from a design conversation (2026-06-26). This is the operator's
WHY, written down so we do not lose it. It CONSOLIDATES and EXTENDS two
existing design docs -- the FROST social leg (`sovereignty-education-bot.md`
section 11a, logged 2026-06-15) and the layered-leg model
(`layered-vault-legs-and-frost.md`). Nothing here changes code yet.

## The thesis (operator)

Think in 5-10 year blocks, not months. Absolute timelocks are deep SAFETY
NETS, not short escalation windows. A short, low-quorum leaf is an attack
surface; the SAME low-quorum leaf placed a decade out is insurance. Your
everyday multisig is the path you actually use; the timelocked leaves are
ADDITIVE fallbacks you hope never to touch. "If you get locked out of your
Bitcoin multisig in under five years you weren't paying attention" -- the
nets belong far out.

Key correction baked in: a timelock here does NOT lock you out of your
coins. Leaf 0 (your real multisig) is open from block zero with no
timelock. The timelocked leaves only ADD ways to spend; they never remove
your primary path. You only ever "wait for a timelock" if you have already
lost enough keys that your primary quorum can no longer sign.

## The shape -- one Taproot address, layered leaves

- **Leaf 0 -- everyday:** your geographically-split multisig (e.g. 2-of-3 /
  3-of-5), no timelock. Takes effort to assemble for a big move; that
  friction is the point, not a bug.
- **Leaf 1..k -- decaying ladder (optional):** your own key set with the
  quorum DROPPING at successive far-out absolute heights (e.g. 3-of-5 now,
  2-of-5 at 5y, 1-of-5 at 10y). This already exists as the Bloc
  "decaying-multisig family tree" compiler (`policy_compiler.rs` Bloc
  section; `compile-bloc.js`). Each rung is its own leaf:
  `and(after(height), thresh(q, keys))`, q shrinking as height grows.
- **Leaf N -- the buried social backstop:** `and(after(10y), pk(FROST_AGG))`.
  The signer is a FROST t-of-n group of your people (30 / 50 / 100). They
  produce ONE Schnorr signature off-chain; on-chain it is a single key.

## The "buried bucket" mental model

The backstop key is something you deliberately make inconvenient and
unloseable -- a key in a concrete-filled 5-gallon bucket ten feet under the
yard, or split across many trusted people. Useless day-to-day, by design.
If life goes well you never dig it up. Because it is a SEPARATE leaf:

- You cannot "lose your Bitcoin" by losing your primary keys -- the backstop
  is independently recoverable on its own leaf.
- It never competes with or weakens your daily path.
- Taproot leaf privacy: an unused leaf never appears on-chain. If you never
  spend it, the world never learns it existed or who was in it. "Never dig
  the bucket up" is literally true at the protocol level.

## Why FROST for the social leg (grounded in the existing docs)

- **Collapses a big quorum to ONE on-chain key.** A 100-key `thresh` leaf is
  impractical (witness size, and it leaks the whole roster on spend). FROST
  lands the entire group on-chain as `pk(AGG)` -- small and private.
- **FROST-not-Shamir.** Each holder produces a signature SHARE; the private
  key never exists in one place, ever. Nobody reconstructs a secret. A
  "missing piece" is just a participant declining to join a signing round.
- **Native to Taproot.** AGG is a BIP340 x-only key; it drops into a leaf as
  `pk(AGG)` (or even the internal key).
- **Living membership via resharing (the linchpin for a 10-year net).** A
  FROST leg commits on-chain only to the AGGREGATE key. The set of
  share-holders and the threshold behind it can be rotated by a resharing
  ceremony WITHOUT changing the aggregate key -- so the address never
  changes even as people move, die, or are replaced over a decade. Without
  this, a 10-year social backstop would rot; with it, it survives.
  (`layered-vault-legs-and-frost.md` section 4.)

## The reciprocity -- the actual product

The bucket is "30 / 50 / 100 people you know," each carrying a piece. Many
eyes over your shoulder instead of one custodian who could steal. You hold
pieces for THEM; they hold pieces for YOU -- mutual, back-and-forth. This is
the web-of-trust / Mycelium / Heartwood layer: community insurance on
sovereign Bitcoin, where the network watches each member's back and the
worst single actor cannot move anyone's coins alone.

## Honest limits (do not sell past these)

- **No self-resetting deadman over multi-year.** Relative timelocks
  (CSV / `older()`, BIP 68) cap at ~65,535 blocks (~15 months). The long
  horizons MUST be absolute (`after()` / CLTV), so the unlock date is FIXED
  and does not slide on activity. You "reset" by RE-ANCHORING -- sweeping to
  a fresh vault with new heights every few years. Reminders / watchtower
  exist to nudge this.
- **FROST is session-bound.** t participants must be reachable to sign. Fine
  for a rare backstop; everyday legs stay plain async PSBT multisig.
- **Transport security.** A FROST signing round can leak a share over a bad
  channel -- it must ride a vetted transport (Nostr).
- **Liveness is load-bearing.** When the timelocked FROST leaf is the only
  fallback, its reshare cadence, heartbeat, and share backups ARE the safety
  net. If the group rots, the net is gone.

## Build direction (when we cut -- not yet)

- Promote the Bloc decaying-ladder to a first-class "long-horizon sovereign"
  template; default rungs in YEARS, generalize past "parents/kids" to
  "you -> your reduced quorum -> your people."
- Add a FROST-aggregate leaf as a selectable leg type (FROST is "a slot, not
  a product").
- Demote the short-window protector / consent template to an explicit
  institutional opt-in, not the default.
- Make the absolute-reset-by-re-anchoring caveat a first-class teaching beat
  plus a reminder.

## The quorum-vs-time dial (refinement, 2026-06-26)

The social backstop is not one FROST leg -- it is a LADDER of FROST legs
where quorum size and timelock SUBSTITUTE for each other as proof of
legitimacy. Bigger crowd buys speed; smaller crowd pays in time. Example:

- Leaf @ 3 years: `and(after(3y), pk(FROST_AGG_75))` -- need 75 people
- Leaf @ 6 years: `and(after(6y), pk(FROST_AGG_30))` -- need 30 people
- Leaf @ 9 years: `and(after(9y), pk(FROST_AGG_10))` -- need 10 people

Each rung is its own tapscript leaf with its OWN FROST aggregate key -- a
75-of-n, a 30-of-n, and a 10-of-n are three different DKGs producing three
different aggregate keys, so each of your ~100 people holds three shares
and participates in three reshare cadences. (Real coordination cost; two
rungs may be plenty.)

**The recovery dynamic.** Your network is kept live by the heartbeat --
everyone was "green" the day before, already set up. The moment you lose
your everyday access you start rallying signatures immediately; you do NOT
cold-start. Whatever is the biggest crowd you can actually staff selects
which rung you reach. More people -> earlier rung -> in sooner. Few people
-> you fall to a later, lower-quorum rung -> you wait. "Ten signatures but
wait fifteen years, versus a hundred signatures and maybe wait two."

**The one nuance to internalize:** absolute timelocks anchor the wait to
VAULT CREATION (or the last re-anchor), NOT to the moment you lost access.
So the clock only stays short if you periodically re-anchor (sweep to a
fresh vault with new heights) -- which you are already doing for FROST
resharing. Re-anchoring is therefore load-bearing, not optional.

**Floor decay = a re-anchor deadline.** Once a rung's height passes it
stays open forever, so over time the security floor drops to the LOWEST
staffed rung. Either you re-anchor before the lowest rung's date arrives,
or you accept that lowest rung (e.g. 10 people, far out) as your permanent
floor. For INHERITANCE that decay is a feature, not a bug: prolonged
silence is itself evidence you are gone, so the protocol asks for fewer
people but more elapsed time. Crowd-size and time are both forms of "prove
this is legitimate," and they trade off cleanly.

**Attacker symmetry (the honest caveat).** An adversary gets the same dial.
Each rung must be safe on its own terms: the early/high-quorum rungs lean on
"you cannot coerce 75 independent people"; the late/low-quorum rungs lean on
"the timelock is far enough that the real owner or heirs would notice and
intervene/re-anchor first." The dangerous combination is a SMALL quorum at a
NEAR date -- never place a low rung early.

## Provenance

Operator's idea, recurring and maturing. First logged as the FROST social
leg (`sovereignty-education-bot.md` section 11a, 2026-06-15). This note adds
the long-horizon-as-default framing, the buried-bucket mental model, the
"timelocks are additive, not a lockout" correction, and the reciprocity
emphasis (2026-06-26).
