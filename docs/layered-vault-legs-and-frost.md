# Layered Vault Legs, FROST, and the Security Floor

Status: captured design note (operator refinement, 2026-06).
Not built. This is the matured frame behind the Dynasty Bloc and the
FROST climb -- the abstraction the rest of the build serves. It extends
`docs/sovereignty-education-bot.md` sections 11-11e and
`docs/build-map-and-cut-lists.md` (the honest lines, section 6). Nothing
here bends those rails; it organizes them.

---

## 0. Why this note exists

The operator's standing instruction: do not narrowly capture one feature
and rush to code it. Mature the idea fully first, keep it open-ended, and
find the frame that lets the most people be the most sovereign. This note
is that capture. The motto it serves, in the operator's words:

> "If you want strong Bitcoin security you need to know your weaknesses,
> and then you craft those weaknesses to be at least on par strength --
> to bring up the floor of the security model. If you don't know those
> weaknesses and you don't know they exist, then you can't protect
> yourself against them."

And the fence parable that frames the whole product: a vault is a fence
you build AND defend. Buying the materials and dropping them in the yard
keeps no wolves out. A fence with a gap they crawl under, or built too
low to stop a jump, is the wallet whose weaknesses you never mapped. The
work is real, it is yours, and the tool's job is to make the work
learnable -- "we do the work so anybody who trusts our work can use it,
but they still have to pick up the torch."

---

## 1. The one idea: a vault is a ladder of pluggable legs

Every spending path in a Taproot vault is a **leg**. A leg is exactly
three things:

- a **guard** -- when it is reachable: immediate, or after an absolute
  block height (`after(N)`);
- a **scheme** -- how its signature is produced: a single key, a plain
  `k-of-n` Miniscript `thresh`, or a FROST aggregate `pk(AGG)`;
- a **roster** -- who actually holds the key material behind the scheme.

The Bitcoin script only ever sees `guard` + a public key (or a small set
of them). It does not care how the signature behind that key was made.
That is the hinge the whole design turns on: **the scheme is pluggable
into any leg, independently, leg by leg.** One vault can carry a
single-hardware-key leg, a `thresh` multisig leg, and a FROST-aggregate
leg side by side -- each a separate tapscript leaf, each chosen for the
job that leaf does.

A vault, then, is an **ordered ladder of legs**, climbing by difficulty
and assurance. The operator named the shape exactly:

> "These different layers of leaves -- your first spend can be the easier
> one, which is not easy but is easier than the others, and then they
> progress up the leaves into structures that are either harder or easier
> depending on the circumstance you are trying to achieve."

The bottom rung is the everyday path: the one you reach for daily, made
as low-friction as is safe. Higher rungs are the backstops: harder to
convene, used rarely, and -- crucially -- gated behind timelocks so they
only become reachable when the easier rungs have failed or fallen silent.

This is not a new vault type. It is the lens that makes every vault type
(the three-path inheritance vault, the Dynasty Bloc, the self-sovereign +
social-recovery shape, a business treasury) one family: each is a
particular ladder of legs.

---

## 2. The security floor over time (the motto, made into a model)

Here is the synthesis that turns the motto into something you can see and
sculpt.

At any block height `h`, some subset of the vault's legs is **reachable**
(their timelocks have elapsed; immediate legs are always reachable). The
vault's **instantaneous security floor** is the assurance of the
*weakest reachable leg* at that height -- because an attacker attacks the
easiest reachable thing, never the hardest. Your security at time `h` is
not your strongest leg. It is your weakest reachable one. That is the
motto, stated precisely: **bring up the floor = raise the assurance of
the weakest leg that is reachable right now.**

Now plot the floor against time. It is a curve.

- **Inheritance is the deliberate lowering of the floor over time.** The
  whole point of a legacy vault is that eventually someone -- an heir, a
  surviving parent, a decayed kid quorum -- who is *weaker* than you must
  be able to claim. So later legs, by design, need fewer or weaker
  signers. The floor is *meant* to descend. The Dynasty Bloc's decaying
  kid ladder (4-of-4 -> 1-of-4 over years) is exactly a descending floor,
  drawn on purpose.

- **That descent is also the attack surface.** A patient adversary does
  not fight your strong everyday leg; they wait for the floor to drop and
  attack the cheap late leg. So the design lever is not "make every leg
  maximal" -- it is **shape the floor-over-time curve**: keep it high
  while you are present, and let it descend only as far as you must, only
  when you are genuinely gone, and never below a leg you would be
  unwilling to lose to.

- **Refresh keeps the floor high while you are alive (absolute-CLTV
  rail).** DynastyTrust timelocks are absolute `after(N)`, not
  self-resetting CSV (BIP 68 caps CSV at ~15 months -- too short, and the
  honest line in the risk register). The deadman *feeling* is built by
  **re-anchoring**: while active you periodically move the coins to a
  fresh output with a further-out timelock, pushing the weak late legs
  back out ahead of you. Stop refreshing and the floor finally descends
  on schedule. So the curve is not fixed at funding -- you walk it
  forward by tending it, exactly like checking the batteries in a smoke
  detector.

The teaching artifact this implies (section 7): a **timeline with a
floor line you can see move** as you set each leg's guard, scheme, and
roster. Drag the inheritance timelock and watch the descent shift. Add a
leg and watch a new step appear. That is the operator's "if I lift this
lever it does this, and these are the consequences" -- made literal,
without ever building "a timeline for the sake of a timeline."

---

## 3. FROST as a slot, not a product

FROST (Flexible Round-Optimized Schnorr Threshold signatures) is not a
separate vault. It is one of the schemes a leg's slot can hold. What it
buys, stated against the floor model:

- **It collapses a big quorum to one on-chain key.** A `t-of-n` ceremony
  happens entirely off-chain; the script sees a single `pk(AGG)`,
  indistinguishable from a normal single-key spend. The honest line: a
  100-key `thresh` in one leaf is impractical on-chain; the big quorum
  belongs off-chain, landing on-chain as one key. So FROST is how a leg's
  *roster* can be large without bloating the leaf or leaking the roster.

- **It never reconstructs the key.** Each member produces a signature
  *share*; the shares combine into one valid Schnorr signature while the
  full private key never exists anywhere, ever. (This is the one
  correction to the mental model: FROST is not Shamir-reconstruct. Shamir
  rebuilds the whole secret at one place and instant -- a single point of
  theft -- and stays the right tool for backing up a *static* secret, not
  for a *signing* leg.)

- **It fits Taproot natively.** The aggregate is a BIP340 x-only key, so
  it drops into a leaf as `pk(AGG)` or even as the internal/output key.
  Same secp256k1/BIP340 curve the vault already uses.

Which legs want FROST, and which do not, falls straight out of the
fast-path-vs-backstop wall:

- **Everyday legs want plain async PSBT, not FROST.** PSBT multisig is
  async-friendly -- each partial signature merges in whenever it arrives,
  nobody has to be online together. FROST is more session-bound (fresh
  nonces, a bounded coordinated round, must be abortable mid-session). So
  the daily path stays plain multisig.

- **Backstop / social / large-roster legs are where FROST earns its
  keep.** They are convened rarely, so a coordinated offline ceremony "is
  not that big of a deal" (the operator's exact read), and they are
  precisely the legs that want a large or rotating roster behind a single
  on-chain key. This is the operator's "slide in any kind of FROST
  wherever the aggregate signing fits -- office, business, family,
  anywhere -- as long as the main path is alive, the offline ceremony on
  the second path is fine."

---

## 4. Living membership: resharing and the heartbeat loop

This is the part that made the operator's idea sing, and it is the
strongest single reason to climb to FROST in a multi-generational vault.

**Fixed descriptor, rotating roster.** A leg whose scheme is a FROST
aggregate commits on-chain only to the *aggregate* public key. The set of
share-holders and the threshold behind it can be changed by a **resharing
ceremony** that re-deals shares to a new roster (or a new `t-of-n`) while
the aggregate key -- and therefore the descriptor and the funded address
-- stays identical. Contrast plain `thresh`: change one key and the
script changes, the leaf changes, the address changes, and you must
**move the coins on-chain** to rotate a single member. Over a 25-year
vault where people move, fall out, lose phones, and die, FROST turns
"migrate the whole vault on-chain to swap a member" into "run an
off-chain resharing ceremony; the coins never move."

**The heartbeat loop -- the vault as a living thing you tend.** The
operator's framing: do a sanity check every so often; everyone reports
back "we're good, we're good"; and if someone is not good -- a phone
lost, a person gone, a threshold of share-holders no longer reachable --
you run a new ceremony, deal a fresh threshold of people, and *nothing in
the chain of spending ever breaks.* This is a maintenance cycle:

```
   attest liveness  -->  all good?  --yes-->  keep tending (refresh anchor)
        ^                    |
        |                    no
        |                    v
   reshare to a new roster / new threshold  (descriptor unchanged)
```

**The coordination, warning, and communication layer is Tapit, wired to
DynastyTrust (operator decision, 2026-06 -- "best security fit").** This
whole loop -- the liveness heartbeat, the FROST signing and resharing
ceremonies, and the duress signal -- rides the Tapit attestation layer:
its encrypted Nostr inbox, its silent envelope-merge, and its
tap-to-confirm sign-request surface (education-bot doc 11b; largely built
on the Tapit side, not yet wired into DynastyTrust, which coordinates via
Supabase Realtime today -- so this is the *integration to build*, not a
new transport). DynastyTrust reads the family's attestation state to
*catch the state of the family* and raise the warnings; Tapit carries the
messages and collects the signatures behind the banners.

The duress-vs-reshare edge resolves through that layer by making the two
**distinct, explicit signals** -- never a guess the app makes:

- A **membership-loss** signal (a phone died, a person is unreachable) is
  a normal attestation that *permits* a reshare -- but only through the
  group's own quorum and behind an **objection window measured on a
  Bitcoin-confirmation clock** (not wall-clock), so a proposed reshare to
  a new roster can be challenged before it commits.
- A **duress** signal *dominates everything*: it withdraws participation,
  **aborts any in-flight signing or reshare session** (the abort rail --
  it cancels the *current* session, not merely the next), and **blocks new
  reshares**. You never reshare under duress; the coins simply fall to the
  timelocked backstop leg, which needs nobody. Bitcoin gives no "freeze"
  primitive -- the only real enforcement is that the fast/reshare path
  becomes unsatisfiable and the absolute-CLTV leg underneath is the
  guarantee.

The "best security fit" default: **when the signal is ambiguous, read it
as duress.** Refuse the reshare, hold position, let the timelock be the
guarantee -- a wrongly-blocked reshare costs a delay, while a
wrongly-permitted one under duress reshares the vault straight into the
attacker's roster. And the hardest honest line stays bright: these
attestations *coordinate* -- they decide whether a ceremony proceeds --
they are never themselves spend signatures and never move a coin alone.

Two consequences worth seeing:

- **The floor can be RE-LIFTED, not only descend.** Section 2 framed the
  floor as a curve that descends with time. Resharing breaks the
  one-directional assumption: a FROST leg's roster can be *re-provisioned
  and its threshold raised* without moving coins, so the heartbeat loop
  lets you push a weak leg back up. The fence does not just decay between
  inspections -- you walk the line and re-stake the posts.

- **It resolves the phone-durability trap directly.** The earlier worry:
  kids on phone wallets are the worst medium for multi-decade keys (lost,
  wiped, replaced every few years), and by the time their decay path
  matters the original phone is long dead. With a FROST kid leg, a kid
  who loses a phone is *re-shared back in* from the surviving threshold --
  no metal-seed archaeology, no on-chain move. The remaining backstop
  caveat (honest line): if too many shares vanish at once, below
  threshold, the group is lost -- which is exactly why the timelocked
  parent/trustee fallback leg beneath it carries the whole safety burden
  and must never itself be a single fragile thing.

**The "deterministic, from them to them" question -- left open on
purpose.** The operator's instinct was that the parents are the
initiators, a hierarchical, deterministic root from which the kid group
is dealt. There are two honest constructions and the choice is a real
fork, so this note records it as OPEN rather than closing it:

- *Trusted-dealer (deterministic from a parent root).* Parents derive and
  deal the kids' shares from a parent master secret, so parents can always
  regenerate and reshare the group. Powerful -- parents are the durable
  recovery root -- but it makes the parents a single point of
  reconstruction for the kid leg. Coherent *here* precisely because the
  parents are already the senior trust anchor of the vault.
- *DKG (no dealer).* No one ever holds the whole secret; the group is born
  from a distributed ceremony. More trust-minimized, but the parents are
  no longer a deterministic root and cannot unilaterally rebuild a lost
  group.

Both are real. The family-vault flavor leans dealer; a business or
adversarial-roster flavor leans DKG. The product should let the founder
choose with eyes open, not hard-code one.

> **Operator decision (2026-06): offer both, teaching-gated.** Present
> dealer and DKG as a choice the founder makes *only with the
> understanding of what each means* -- the education layer explains the
> "parents are the recovery root vs no one ever holds the whole secret"
> tradeoff at the moment of choice, then the founder picks. Neither is
> hard-coded; the choice is never offered as a naked toggle without the
> teaching beside it.

---

## 5. The Dynasty Bloc as the first concrete rung

The Dynasty Bloc (shipped on this branch, compile + export; in-app spend
in progress) is the first instance of the ladder, built entirely on
today's primitive -- plain per-signer BIP340 multisig, `multi_a` in
Taproot leaves. Its legs:

- parents together (`multi_a(2, P)`), immediate;
- one parent + every kid (`and(multi_a(1,P), multi_a(n,K))`), immediate;
- one parent alone, after T1;
- kids alone, a decaying `multi_a` ladder, from T2 onward.

The FROST evolution, leg by leg, when the primitive exists:

- The **everyday legs stay plain multisig** (async PSBT, parents on
  hardware). No change -- this is correct as-is.
- The **kid set becomes a single FROST aggregate** `pk(KIDS_AGG)` in the
  legs where the kids appear. The big consequence to see clearly: **the
  on-chain decaying-threshold ladder partly collapses.** Today the kid
  threshold decay (4-of-4 -> 1-of-4) is expressed as separate on-chain
  leaves at successive timelocks. With one aggregate key, the threshold
  lives *inside* the FROST group, so "decay" becomes either (a) a
  **resharing decision** -- parents reshare the kid group to a lower `t`
  over time -- or (b) a few **coarse on-chain time gates**
  (`and(after(T2), pk(KIDS_AGG))`) with the fine-grained "how many kids"
  handled off-chain. Tradeoff, named honestly: far fewer leaves and total
  membership freedom, but the decay schedule is then governance-enforced
  (resharing) rather than consensus-enforced (script). Some families will
  want the schedule welded into the script; others will want the
  flexibility. The product should support both, and teach the difference.

So the Bloc is not a detour from the FROST vision -- it is the rung you
climb *from*. Same tree, same timelock legs; a leg's scheme swaps from
`multi_a(...)` to `pk(AGG)` and the threshold moves off-chain.

---

## 6. Worked use cases (the same primitive, many contexts -- kept open)

The leg/slot/roster model is deliberately open-ended: any scheme in any
slot, any number of legs, any context. Four worked instances prove the
generality without closing the set.

1. **Family Bloc (parents hardware, kids phone).** Everyday legs: parents'
   plain multisig on hardware (strong, async). Kid leg: a FROST aggregate
   of the children behind one parent, only reachable on the backstop
   timelocks. Phone keys sit where they belong -- gated behind a parent or
   a multi-year timelock, never the everyday floor -- and the heartbeat
   loop reshares around lost phones. Guardrail the UX should enforce:
   warn when a decay floor reaches 1-of-n on weak keys (a single
   compromised phone must never be sufficient, even at the bottom of the
   ladder).

2. **Business / office treasury.** Everyday leg: a `thresh` of officers on
   hardware. Backstop leg: a FROST aggregate of a department or a board
   committee, resharable as staff churn -- people quit, join, change
   devices -- without ever re-funding the treasury address. The
   fixed-descriptor property is worth more in a business (constant
   turnover) than almost anywhere.

3. **Self-sovereign + social recovery (the operator's own worked
   example, 11d).** Everyday leg: his two hardware keys + one software key
   (only he can spend). Backstop leg: a timelocked social-recovery leg --
   a large peer quorum as a FROST aggregate that can rescue him after he
   has been silent a set time, with the open sub-choice of peers-spend-
   alone (true rescue) vs peers-assist-with-his-backup-key (cartel-proof).
   Refresh re-anchors to keep the floor high while he is present.

4. **Trustee Commons leg.** The backstop roster is not named friends but
   bonded, fee-earning, reputation-tracked anonymous personas drawn from a
   pool, behind a FROST aggregate. Witnesses are paid for being present --
   baked into the rescue tx today, off-chain via Lightning preimage/PTLC
   later -- and slashed for misbehavior. The standing-market version of
   "pay the people who show up."

The point of four is to show it is not four products. It is one ladder,
re-rostered for four lives.

---

## 7. The teaching UX -- never leave you in the dark

The rail (chat-wizard / education-bot): consequence first, mechanism
second, cryptography only behind a deeper-disclosure tap; tap-to-confirm
shows the *meaning* in plain language, never the hex; the assistant
proposes, the human disposes, no key ever enters its context. Applied to
the ladder:

- **The leg composer (read AND write).** This is the surface the operator
  chose for question 2: the tree's leaves are the founder's to tweak,
  fully configurable and fully visible, so they make it fit *them*. Each
  leaf is an editable cell -- pick its guard (immediate / `after(N)`), its
  scheme (single key / `k-of-n` multisig / FROST aggregate), and its
  roster (a named group: the kids, the grandparents, trustees, peers).
  One leaf can be a FROST of the kids, another a FROST of the
  grandparents, maybe both, plus the parents' own plain keys on the
  everyday legs -- as many groups and leaves as the family wants. Every
  leg shows, in plain language: who can spend, when it unlocks, and -- the
  motto made visible -- *the new weakness this leg opens and how the
  design answers it.* Lift the timelock lever and the screen says what
  changed and what it costs; choose FROST for a leaf and it explains the
  offline-ceremony tradeoff and the resharing superpower in one breath.
- **Templates are pre-composed ladders -- the on-ramp, never the ceiling.**
  The other half of the operator's answer: most people should "just pick
  the easy template that fits best." A template is a ready-made ladder
  (the Dynasty Bloc, Family Inheritance, Business Treasury, Self-Sovereign
  + Social Recovery) that drops in with sane legs already composed. The
  composer is what you open when you want to tweak one -- swap a leaf's
  roster to a FROST group, add a grandparent leg, push a timelock. Express
  users start from a template and never have to open the composer; power
  users compose from scratch. Same engine, presentation dial over it.

- **The floor-over-time view.** The section 2 curve, drawn: a timeline
  where you watch the security floor descend (and, with FROST resharing,
  where you can re-lift it). Drag a lever, see the curve move. This is the
  visual the operator wants -- grounded in a real model, not decoration.
  And it is the composer's guardrail (Q3): the stance is **educate them
  out of bad decisions -- we do not offer a regular bad choice.** The
  curve is not passive wallpaper and not a nanny block; it teaches,
  consequence-first, the moment a chosen shape would drop the floor
  somewhere indefensible, and makes the founder prove they understand
  before proceeding (no naked toggle). Hard refusal is reserved for the
  genuinely *broken* -- a timelock already in the past, or a sole reachable
  leg that is one weak key with no backstop -- not for the merely unusual.

- **The heartbeat surface.** "Everyone report back: we're good." A
  liveness/attestation panel that is honest -- proof-of-life is an
  attestation, never a spend signature (the hardest honest line) -- and
  that turns a failed check into a clear "time to reshare" prompt, not a
  silent rot. This panel is the DynastyTrust face of the Tapit attestation
  inbox (section 4): green/red liveness that catches the state of the
  family, the warning when that state slips, and a duress channel that
  *aborts* a ceremony rather than advancing it.

- **Two speeds, one engine.** Express (click-through for bitcoiners who
  know the mechanics; the expert path is never walled) over Guided (one
  decision at a time, teaching woven in). A presentation dial over one
  flow, not two code paths.

The test the bot keeps asking, applied to a ladder: *"If I erased your
phone right now, could you get back to your Bitcoin? Walk me through every
independent way."* The ladder's answer should be visible at a glance.

---

## 8. Honest lines this frame must never cross (rails, restated for legs)

Straight from the risk register; nothing here bends them. The full threat
model -- where the app adds real security vs. where only consensus
enforces, and the fail-closed invariants -- lives in
`docs/threat-model-and-fail-closed.md`. The one invariant that governs
every cut: the platform must never be a SHORTCUT around the script (never
let anyone assemble a valid spend with fewer pieces than the script
requires).

1. **Attestations are not spend signatures.** A heartbeat "we're good" is
   a domain-separated attestation, never a BIP341 sighash. Off-chain
   agreement never moves a coin on its own.
2. **Timelocks are absolute, refreshed -- not a self-resetting countdown.**
   The deadman is re-anchoring, not an on-chain timer that resets when you
   touch the coins.
3. **Big quorums belong off-chain (FROST), not in the raw script.**
4. **Resharing and PTLC/adaptor payments are frontier.** Real and known,
   but the least battle-tested layer; vetted, audited constructions only,
   never hand-rolled. Nonce reuse in a FROST round leaks a share.
5. **The fast path can stall; the timelock leg is the guarantee.** The
   FROST/social/Lightning legs depend on people and liquidity; the
   absolute-CLTV leg beneath needs nobody. If the FROST group is ever
   permanently lost, that fallback is the only backstop, so its design
   carries the whole safety burden.
6. **In-flight ceremonies must be abortable.** A duress/withdraw signal
   cancels the current session, not merely the next one.
7. **The banner shows the meaning, not the hex.** Hiding cryptography is
   good; hiding what you are agreeing to turns a verification into a blind
   tap.
8. **No control.** No key ever enters the assistant's context; no value
   commits without a human tap; keys never leave the browser unencrypted
   -- the rule that outranks every other.
9. **Pay with value, not control.** A Lightning preimage moves money; a
   key share moves spending authority -- never substitute one for the
   other.

---

## 9. The maturity ladder -- what to build, in what order

The operator's sequencing rule is the law here: small quorums and small
amounts on the primitives that already exist first; climb only as trust
and value grow. Mapped to this frame:

1. **Plain-multisig legs (now).** The three-path vault and the Dynasty
   Bloc -- shipped / in progress. Prove the ladder on `multi_a`. This is
   the trustworthy floor everyone starts on.
2. **The leg-inspector + floor-over-time UX (near).** Teach the ladder
   visually on the primitive that already exists. No new cryptography --
   this is pure clarity, and it is where the most people are reached.
3. **Vanilla FROST signing (climb).** A FROST aggregate as a leg's
   scheme, fixed `t-of-n`, on a vetted RFC 9591 library. Wire it to the
   existing Nostr transport / sign-request surface (largely solved on the
   Tapit side) so the ceremony rides "behind the banners."
4. **FROST resharing + the heartbeat loop (frontier).** Fixed descriptor,
   rotating roster; the living-membership maintenance cycle. The most
   powerful and the most caution-demanding -- the part that most needs a
   vetted construction.
5. **Paid witnesses, off-chain (furthest).** Baked-in tx outputs first,
   then Lightning preimage / PTLC + adaptor-signature atomic payments and
   the Trustee Commons fee market, once the rails beneath exist.

Each rung is independently shippable and independently useful. You never
have to reach rung 5 to benefit from rung 1; you climb as far as your
value and your comfort justify.

---

## 10. Open questions to resolve (the bounce-back list)

Deliberately left open so the frame is not prematurely closed:

1. **Dealer vs DKG for family FROST legs** (section 4). RESOLVED
   (2026-06): offer both, teaching-gated -- the founder chooses with the
   tradeoff explained beside the choice. Residual: per-template *default*
   (family -> dealer, business -> DKG) as the starting point a template
   pre-selects.
2. **Decay: script-enforced vs reshare-enforced** (section 5). RESOLVED
   (2026-06): neither is hard-coded -- the **leg composer** (section 7)
   lets the founder build it either way, per leaf, fully visible: a leaf
   can be a script-enforced timelock decay, or a FROST aggregate whose
   decay is reshare-governed, or both in one tree (e.g. a FROST-of-kids
   leaf beside a FROST-of-grandparents leaf). Templates pre-compose the
   common shapes; the composer is there to tweak. Residual: how far down
   to let the composer go for a first cut without overwhelming a beginner
   (the express/guided dial answers most of this).
3. **Floor model: teaching visual, warning, or hard block?** (sections 2,
   7). RESOLVED (2026-06): **educate them out of bad decisions -- we do
   not offer a regular bad choice.** The stance is neither a passive
   visual nor a nanny hard-block: the menu itself is curated so a bad
   shape is never a one-click default, and if a founder steers toward one,
   the floor model *teaches them out of it* -- consequence-first, in plain
   language, with the weakness named -- and makes them prove they
   understand before proceeding (the same "no naked toggle" rule as Q1).
   Hard-block is reserved narrowly for the genuinely *broken*, not the
   merely suboptimal: a timelock already in the past (unlocks at funding),
   or a sole reachable leg that is a single weak key with no backstop above
   it -- footguns with no legitimate use. Everything defensible-but-unusual
   stays buildable behind the education gate. Residual: the exact line
   between "teach + gate" and "refuse," drawn per shape.
4. **Heartbeat / duress / reshare authority** (section 4). RESOLVED
   (2026-06): the coordination, warning, and communication layer is
   **Tapit wired to DynastyTrust** -- attestation inbox + encrypted Nostr
   + sign-request surface. Membership-loss and duress are *distinct
   explicit signals*: loss permits a reshare behind a Bitcoin-clock
   objection window; duress dominates -- aborts in-flight sessions, blocks
   reshare, falls to the timelock backstop. Ambiguity defaults to duress
   ("best security fit"). Attestations coordinate, never sign. Residual:
   heartbeat cadence, objection-window length, and who in the family roster
   is authorized to raise each signal.
5. **Where the ceremony lives.** DynastyTrust on Supabase Realtime today;
   the FROST/Nostr sign-request surface is on the Tapit side. The wedge is
   wiring the two, not building a transport.
6. **The simplest honest bottom rung for non-experts** (section 11).
   RESOLVED (2026-06): **one user, but with an intelligent timelock schema
   -- not a bare hardware device.** The beginner's vault is still a ladder,
   just with a roster of one: an everyday leg (their key/device) plus a
   timelocked self-recovery backstop leg (a second device or backup key
   that can recover after `N`), so it is strictly safer and more redundant
   than a plain single-sig -- without needing any other person. It ships
   wrapped in the info + warning layer: the importance of backups, ongoing
   security concerns, and a maintenance schedule (refresh/re-anchor
   reminders, seed-restore drills, the "if I erased your phone right now"
   test). This is the on-ramp that teaches the ladder with zero other
   people involved -- proving the frame from the very bottom: *everyone is
   on the ladder from day one; the beginner's ladder just has a roster of
   one and good hygiene beside it.* See section 11.
7. **Residual sub-questions** carried from the above: per-template
   dealer/DKG defaults (Q1); composer depth for a first cut (Q2); the exact
   teach-vs-refuse line (Q3); heartbeat cadence + objection-window length +
   who may raise each signal (Q4); the Supabase->Nostr wiring (Q5).

---

## 11. The single-user starter ladder (the bottom rung, from Q5)

The product has no "non-ladder" mode. The simplest possible vault is still
composed of legs -- it just carries a roster of one, so a complete beginner
who is not yet comfortable with multisig starts on the same frame everyone
else climbs.

- **Everyday leg:** the user's own key (a hardware device, or a hardware +
  software pair if they want a small multisig of their own). Immediate, no
  timelock. Behaves exactly like the single-sig or self-multisig they
  already understand.
- **Self-recovery backstop leg:** `and(after(N), backup_key)` -- a second
  device or a metal-backed backup key they alone hold, reachable after an
  absolute height. If the everyday device is lost, the backstop recovers
  the funds without anyone else, and without the bare-single-sig failure
  mode where one lost seed is total loss. This is the existing
  Lost-Device-Insurance shape, taught as the *default floor* rather than an
  advanced option.
- **The info + maintenance layer is part of the rung, not an add-on.**
  Backups matter, security is ongoing, and the schema must be tended: the
  refresh/re-anchor reminder (absolute timelocks do not self-reset -- you
  walk the floor forward), periodic seed-restore drills, and the
  plain-language "could you get back to your Bitcoin if this device died
  right now -- walk me through every independent way" check. This is the
  confidence-ladder / Reminders surface the roadmap already wants, pointed
  at the solo user.

Why this is the right bottom rung: it is strictly safer than "just a
standard hardware device," it needs no second person (the lowest possible
social friction), and it introduces the ladder, the timelock, and the
maintenance habit at the gentlest scale -- so when the user later adds an
heir leg, a FROST-of-kids leg, or a social-recovery leg, they are not
learning a new tool, only adding rungs to the one they already trust.

---

All six bounce-back questions are now resolved (section 10); the frame is
matured. The Dynasty Bloc proved the bottom rung is real and buildable on
today's primitive. FROST-as-a-slot, the resharing heartbeat, the
floor-over-time UX, the leg composer, and the single-user starter ladder
are the climb -- captured here so the build serves the idea instead of
narrowing it.

---

## 12. Build status / resume marker (2026-06-22)

WHERE WE ARE. Shipped to `main` (merge `affaea7`), which fired the
Netlify production build and the Fly.io compiler auto-deploy:

- Dynasty Bloc COMPILE: `/compile-bloc` (Rust + netlify), descriptor
  round-trip, `/policy/bloc` builder UI with the decay-ladder preview,
  hardware-wallet export. DONE + on main.
- Dynasty Bloc SPEND (build + export only): `build_bloc_spend_psbt` +
  `/psbt-binary-bloc` (Rust + netlify proxy) + the BlocBuilder "Spend
  from this vault" panel that builds a PSBT for a chosen path/rung and
  exports it for hardware-wallet signing. DONE + on main. Audited (no
  blocker); dust-floor + prevout-fetch fixes landed. 28 cargo tests.

VERIFICATION GATE (operator-run, after Fly deploy finishes):
1. `curl https://dynastytrust-compiler.fly.dev/health` -> "endpoints"
   must list `/compile-bloc` and `/psbt-binary-bloc`.
2. In-app: `/policy/bloc` -> pick keys -> Compile gives an address.
3. Fund on signet/testnet -> the spend panel builds a PSBT.

SECURITY MODEL captured (2026-06-22): `docs/threat-model-and-fail-closed.md`
(added security on a consensus floor; the never-a-shortcut invariant) and
`docs/watchtower-spec.md` (the on-chain tripwire).

DONE since:
- The fail-closed signing GATE -- `evaluateSigningGate` in
  `packages/policy-engine` -- default-DENY, pure, fully unit-tested.
- The gate WIRED into in-app Bloc signing (`BlocBuilder`): after building
  a PSBT, "Sign with my software keys" binds the exact PSBT (sha256),
  runs the gate as a hard pre-condition, and only on allow signs (reusing
  the proven ProposalDetail pattern) -> merge -> finalize -> broadcast.
  `@dynastytrust/policy-engine` is now a web dependency. lint/typecheck/
  build green; on-chain confirmation pending Fly deploy + signet test.

NEXT, in order (resume here):
1. Real multi-party ceremony + persistence: a `bloc_policy` jsonb vault +
   a proposal/approval record + the broadcast (sanctioned) txid set, so
   the gate is fed a genuine multi-approver ceremony (not the client-built
   solo one) and proposals surface across members. (Quarterback owns the
   money-signing.)
2. The watchtower diff core + poller (watchtower-spec rungs 1-2 first --
   pure, testable).
3. The leg composer + floor-over-time visual (frame rung 2): the
   educate-out-of-bad-choices guardrail made visible. No new cryptography.
Then the FROST climb (sections 3-4) as a later, vetted-library phase.
