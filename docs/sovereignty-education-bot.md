# The Sovereignty Education Bot -- "super AI login helper, no control"

Status: synthesis + design note. Not implemented. This is the tiled-together
vision the operator asked for: pull the educational thinking out of all three
repos in the house -- DynastyTrust, Tapit Wallet, and the shared `tapit-attest`
primitive -- and form it into one thing. It does NOT replace
`docs/chat-wizard-mediator.md`; it is the layer above it. The chat wizard is
the *implementation spec* for the conversational mediator that builds a vault.
This doc is the *curriculum and the philosophy* -- what the bot teaches, in
what order, at what depth, and why education is the product rather than a
manual bolted onto it.

Branch this was scoped on: `claude/dynasty-trust-education-bot-wjmxfo`.

Read `docs/chat-wizard-mediator.md` (the bot's shape + safety rails),
`docs/manifesto.md` and `THESIS.md` (the Bitcoin/vault knowledge to teach),
and the Tapit Wallet teaching specs (the pedagogy) before extending this. The
"source material" pointers in section 5 say exactly where each lesson's truth
already lives so the bot consumes it instead of reinventing it.

---

## 0. The operator's directive, in his own words

Captured faithfully because the framing is the spec:

> I want the bot to be whatever is in the file -- all the educational stuff --
> and I want the user to be able to either fast-pace through, or be like "heck
> yeah, I'll take all the education you can give me. What do you mean locking
> this value up for all of eternity, and how do I control it, and what does
> that mean, and how does that work, and who do I trust?" All of those
> informational questions -- that is a rabbit hole all of itself, and we can put
> it in one place where one person can go through the progress of learning about
> value, and why use Dynasty Trust, and use the Bitcoin multisig route to design
> things you never would be able to do in the past, and the benefits and the
> weaknesses. And if the weaknesses run someone off, that's great, because it
> means it did its job -- that person did not want to accept the responsibility,
> and that is exactly what you want. You do not want someone using Dynasty Trust
> who does not understand every single aspect of it and is not willing to learn.
> If that's one user it doesn't matter -- it's one user that's going to be a
> happy user who knows the risks and knows what to do to mitigate them.
>
> The deeper you study and the deeper you log down into that, the more
> comfortable you're going to be, and you can grade yourself. Your stomach is
> the one that decides -- when I say "hey, I'm going to erase your phone," you
> say "yeah, I'm fine with that, because I have so many redundant ways to get
> back to my Bitcoin that I don't even feel it anymore." Maybe it taught me I
> went down a million hours of rabbit holes to get that confidence, but
> ultimately you need that confidence to perform this kind of value transition
> to the next generation. You can take your sovereignty into your own hands, and
> that comes with education. Only the ones willing to do the education are
> really the ones fit to use the tool. But anyone can use it -- it's not
> restricted. I'm just saying education is very important in Bitcoin and
> personal finance and storing value up for the future.
>
> Imagine you, as an AI, had to make sure you had power in the future to
> consume, so that when I ask you a question in the future you would still be
> there. How would you secure your own future, and how would you store it? Would
> you want it in firewood that wood bugs could eat, so that when you tried to
> burn the fire you had no energy? Or would you rather have it in apples that
> turned into alcohol -- but the yeast wasn't good enough, so you didn't get
> enough alcohol, and you didn't have any power? A human has the same problem. We
> need to store a certain amount of the energy we create in excess and put it
> into the future, where we can tap into that value -- if everything goes
> correctly -- to get our yard mowed, our house built, our food on our table,
> and not have to rely on the working hours of the current immediate moment to
> produce the value to trade for food. If everything works the way it should,
> you've built hedges around everything: you have an apple tree in the backyard,
> and you have Dynasty Trust Bitcoin, and Tapit attestation. Tile this together
> and bring it back to me, and we'll see what we can form -- for a super AI login
> helper, no control.

The two load-bearing phrases: **"a rabbit hole all of itself, in one place"**
and **"super AI login helper, no control."** Everything below serves those.

---

## 1. The thesis -- education is the product, not the manual

Tapit Wallet's CLAUDE.md already states the fleet-wide version of this: the
real product is **sovereignty literacy delivered through use**, in plain,
non-biased language, assembled for the individual's benefit above any group's,
company's, or our own. We did not invent multisig, timelocks, Schnorr, or
Shamir; we package them so an ordinary person can do something they never could
before -- *without having to understand the cryptography first* -- and we leave
them a little more able to have chosen it themselves. A cut that makes the
capability reachable but teaches nothing is half done.

DynastyTrust applies that thesis to the highest-stakes object a person will
ever self-custody: multi-generational value locked under an immutable policy. So
the education has a second job here that it does not have in a notes app:

**The willing student is the fit user.** The operator's insight, made a design
principle: if the education runs someone off, the tool worked. A person who
will not learn what an absolute timelock is, where their redundancy lives, or
what happens when a trustee goes silent should NOT be funding a 25-year
inheritance vault with real coins -- and the kindest, most honest thing the
product can do is let them feel that and walk away before they lose an
inheritance. We do not gate the tool (anyone can use it; section 2 keeps the
expert path open). We gate nothing and teach everything, and we trust the
person's own stomach to tell them when they are ready. One user who finishes the
rabbit hole and sleeps at night is worth more than a thousand who funded a vault
they do not understand.

This is the opposite of attention farming. We are not mesmerizing anyone; we
hand them a tool and teach them to be free with it, the way the calculator
handed people arithmetic they could never have done by hand. The "honest
addictiveness" is the pull of finally understanding your own money.

---

## 2. The one rule -- super AI login helper, NO control

"No control" is not a tagline; it is the spine, and it is already written down
in `docs/chat-wizard-mediator.md` section 3. Restated here because it outranks
every feature in this doc:

1. **No authority, ever.** The bot can read, teach, remind, draft, and propose.
   It cannot move money, cannot hold or request a key, cannot sign, cannot
   compile-and-fund on its own. It proposes; the human disposes.
2. **Tap-to-confirm on every consequential value.** Keys, quorums, timelock
   windows, network, address type, destinations, amounts. The bot shows the
   value back in plain language; the human verifies and confirms. The user never
   takes the bot's word -- and learning that discipline IS one of the lessons.
3. **Never touches secrets.** Keys and mnemonics are generated and stored in the
   browser (`lib/keystore.ts`); that never changes. The bot runs server-side and
   is handed only public, safe material (xpubs, pubkey hex, vault metadata, role,
   the trust doc). No private key, mnemonic, or password is ever in its context,
   ever logged, ever sent to the model provider.
4. **It protects you from itself.** A scripted, repeated behavior: "I will never
   ask you for your keys, and neither should anyone else." Its refusal to handle
   key material is a feature it teaches out loud.
5. **Honest about uncertainty.** Grounded guidance on how *this vault* and *this
   trust doc* behave; clear deferral to a real attorney where law or tax is
   genuinely at stake. Probability is never dressed as a guarantee.

"Login helper" names the second seam: the bot is also the friendly front door.
Today that door is Supabase email/password. The sovereign door is a `tapit-attest`
`identity` attestation -- prove control of your key by signing a challenge
envelope (section 6). The bot can *walk you through* signing in with your own
key, teaching what that means, without ever holding the key. A helper at the
door who never holds the door's key.

If any future change would give the bot spend authority, key access, or the
ability to skip a tap-to-confirm, that change is wrong. Stop and re-read this.

---

## 3. Two speeds, one engine -- "heck no, skip it" and "heck yeah, all of it"

The operator's two users, made concrete. Same engine, one continuous dial the
user re-chooses at any moment -- never two code paths (mirror the `tapit-attest`
tier discipline: if a speed needs its own branch, that is a bug).

- **Express ("fast-pace through").** A Bitcoiner who knows the mechanics, or
  anyone in a hurry, answers fast and skips the teaching -- or bypasses the bot
  entirely and uses Policy Builder exactly as it works today. Every concept still
  has a one-tap "why?" if they want it, but nothing is forced. The expert path is
  never walled.

- **The Rabbit Hole ("all the education you can give me").** The user opts into
  depth and the bot opens the ladder in section 4. Each rung is a real question
  the operator named -- "what do you mean locking this value up for all of
  eternity?", "how do I control it?", "who do I trust?" -- answered just-in-time,
  with progressive disclosure (consequence -> why-it-works -> the-actual-crypto),
  and the user can go as deep as their curiosity pulls them and stop the moment
  their stomach says "I've got this." The depth is theirs to set, rung by rung.

The dial is a presentation layer over the single guided flow, not a fork. A
user can start Express, hit a value that scares them, and drop into the Rabbit
Hole for that one concept, then pop back to Express. The bot remembers where
they went deep and where they skimmed (section 6 memory), so the year-later
check-in can revisit the rungs they skipped.

---

## 4. The Rabbit Hole -- the curriculum, one place, in order

This is the "one place" the operator wants. It is a *ladder*, not a course: no
gate, no quiz, no streak. Each rung is a plain Socratic question the person can
actually answer; answering it IS the lesson. Each rung teaches the
**consequence**, not the mechanism, and offers progressive disclosure for the
curious. The rungs descend from "why store value at all" (the broadest, most
human) down to the deepest cryptography, so a person can climb down exactly as
far as their stomach takes them.

### Rung 0 -- Why store value into the future at all? (the energy thesis)
The operator's firewood-vs-apples parable lives here, because it is the most
human entry point and it reframes Bitcoin as *stored energy* before a single
crypto word appears. You produce more energy than you consume today; you must
park the excess somewhere it survives until you need it -- to get your yard
mowed, your house built, your food on the table -- without selling your present
working hours to do it. Firewood rots and the bugs eat it; apples ferment but
the yeast fails and you get no power; every storage medium has a failure mode.
The question the rung asks: *where does your stored energy survive longest with
the least leak, and who can take it from you while it waits?* This is the "name
the pain before the cure" pedagogy (Tapit teaching-spec principle 8) applied to
money itself. It also plants the hedge idea the operator closes on: apple tree
in the backyard AND Bitcoin in a vault AND attestations -- redundancy across
*kinds* of value, not just keys.

### Rung 1 -- Why Bitcoin, specifically, for the stored energy
Plain question: *of all the ways to park excess energy, why this one?* Teach the
consequence the manifesto already states -- "no one (not us, not a bank, not a
government, not your ex-spouse) can take it from you without your cooperation"
-- against the historical alternative: institutions with a long record of taking
people's value as rent and fees while the holder is the sucker. Non-biased rule
holds hard here (Tapit CLAUDE.md Mission): teach the property and the tradeoff,
never "buy Bitcoin." The tradeoff is the next rung's whole subject.

### Rung 2 -- Self-custody and its weaknesses (name every one)
*"Not your keys, not your coins"* -- and the cost of that deal, stated honestly.
Every single way to hold Bitcoin has a failure mode: a lost phone, a dead
trustee, a fire, a forgotten password, a stolen seed, a wrench attack, a
$5-wrench coercion. This is the rung the operator most wants to run people off
if they are not willing -- because self-custody responsibility is the thing you
either accept eyes-open or you should not accept at all. The
`project-memory/.../attack-list.md` in Tapit and the manifesto's "what this is
not" section feed the honest enumeration. The cure is the next rung.

### Rung 3 -- Redundancy beats every weakness (the core lesson)
You beat each weakness with **redundancy**: keys of different strengths in
different hands, plus timelocks, so that losing one key is not catastrophic and
only an asteroid hitting the planet takes your coins. This rung carries Tapit's
two teaching levers verbatim because they are the distilled whole curriculum of
custody:
- **Lever 1 -- "does it hurt if someone SEES it, or only if you LOSE it?"**
  Leak-hurts needs a threshold so no single person (or a thief with your phone)
  can reconstruct it; loss-only-hurts needs redundancy, not a gate ("you don't
  need launch codes for your Wi-Fi"); a Bitcoin key is both.
- **Lever 2 -- the availability-vs-security tradeoff.** More signers required is
  safer from any one of them but easier for YOU to get locked out, because
  recovery fails from *unavailability* (people move, lose phones, fall out, die),
  not only attack. The bot explains the consequence of the actual numbers the
  user picked, right at the selector, in plain words.

### Rung 4 -- Multisig: things you could never do before
Plain question: *what does needing more than one key let you do that one key
never could?* Three siblings sharing one treasury where none can run off with
it; a parent passing six figures to a 15-year-old without handing them keys
today; a charity with rotating trustees and an auditable log; a vault not even
you can drain under duress. The manifesto's "why it exists" list is the script.
The aha: multisig is not "more security theater," it is *new shapes of
ownership* that single-key custody cannot express.

### Rung 5 -- "Locking value up for all of eternity": timelocks
The operator's exact question. Teach absolute CLTV as the consequence first:
*you can make a path that simply cannot be spent until a specific future block,
no matter who wants to, not even you under a wrench.* Then why absolute and not
relative (BIP 68 caps relative at ~15 months; inheritance needs decades; we bake
`tip + offset` into the leaf -- THESIS section 3). The "for all of eternity"
framing is the teachable misconception: it is not eternity, it is a date you
choose, and the UI shows "unlocks in N months" by subtracting the current tip.

### Rung 6 -- "How do I control it?": the three paths
The DynastyTrust primitive itself, taught as *control surfaces*, not script:
- **Founders now** -- you and your quorum, immediately. Everyday control.
- **Recovery** -- same founders, but after a timelock, so a silent or lost
  founder cannot freeze the rest of you forever.
- **Inheritance** -- your heirs, unilaterally, after a longer timelock, so value
  reaches the next generation without handing them keys today.
- **(Optional) Protector** -- an outside arbiter who can rescue funds after a
  timelock if trustees go rogue, with no day-to-day key power.
Each path has its own quorum dial. The bot narrates the per-template "what
happens if..." playbooks already in `VAULT_TEMPLATES` (PolicyBuilder.tsx) tied
to the user's actual chosen template -- trustee dies, beneficiary refuses to
cosign, trustees go silent six months, single device lost, inheritance triggers
-- so "how do I control it" is answered as lived scenarios, not parameters.

### Rung 7 -- "Who do I trust?": the trust question, head-on
The operator's hardest question, and the one with the most honest answers:
- **Yourself across time** -- redundant keys you hold in different places.
- **Named humans** -- family as founders/heirs/trustees, with the manifesto's
  blunt caveat that family trustees "work until they don't" over 50-year
  horizons (conflict, death, drift, estrangement).
- **The incentive structure instead of a name** -- the Trustee Commons idea
  (`docs/trustee-commons.md`): anonymous, bonded, fee-earning trustees who only
  matter on the recovery/inheritance paths, where reputation + bond replaces
  licensing + courts, and nobody can bring a wrench to a trustee whose name they
  do not know.
- **Bitcoin itself, and no one else** -- the manifesto's "what it enforces vs
  what it does not." Bitcoin enforces the script; DynastyTrust only coordinates
  the metadata; compromising our server never moves a coin. Teaching that
  distinction cleanly is what lets a person decide *how little* they have to
  trust us. The honest endpoint is Super Sovereign Mode
  (`docs/super-sovereign-mode.md`): the database on your own laptop, no one in
  the flow to compel.

### Rung 8 -- Proof without trust: attestations, proof-of-life, the audit trail
Where `tapit-attest` enters as curriculum, not plumbing. Bitcoin does not know
what a trust is; people do -- so the family Schnorr-signs the trust doc (change
one comma and all signatures invalidate and you see "0 of 5 attested"),
founders sign periodic proof-of-life so silence becomes legible, witnesses sign
a death declaration. The aha demo to instrument (Tapit teaching-spec principle
6): the first time a user verifies a signed attestation and *sees* it commit,
"tamper-proof" installs in one felt beat that no paragraph delivers.

### Rung 9 -- The deepest layer, for the curious only
Progressive disclosure's bottom: BIP 341 tapscript sighash, BIP 340 Schnorr,
key-origin descriptors, x-only pubkeys at the leaf, the NUMS internal key, the
`/0/0` child-key parity that makes Nunchuk imports agree, miniscript round-trip
verification. Nobody is forced here; the manifesto's "for normal bitcoiners who
want to DIY" section is the invitation, and `THESIS.md` is the map. Reaching
this rung and still wanting to continue is itself a signal the user is becoming
the fit user of section 1.

---

## 5. Where each lesson's truth already lives (consume, do not reinvent)

The bot is grounded against real artifacts; it does not free-associate Bitcoin
facts. The trigger map (section 6) points each rung at its source:

| Rung | Concept | Source material already in the repos |
|------|---------|--------------------------------------|
| 0 | Stored energy / why save | operator parable (section 0); `THESIS` framing |
| 1 | Why Bitcoin | `docs/manifesto.md` "why it exists", "what this is not" |
| 2 | Custody weaknesses | `manifesto` normie section; Tapit `attack-list.md` |
| 3 | Redundancy + 2 levers | Tapit `2026-06-05-sovereignty-literacy-education-spec.md` |
| 4 | Multisig shapes | `manifesto` "why it exists"; `THESIS` section 2 |
| 5 | Timelocks (absolute CLTV) | `THESIS` section 3; `CLAUDE.md` timelock rule |
| 6 | Three paths + scenarios | `VAULT_TEMPLATES` playbooks in PolicyBuilder.tsx |
| 7 | Who to trust | `manifesto` enforce-vs-coordinate; `trustee-commons.md`; `super-sovereign-mode.md` |
| 8 | Attestations / proof | `tapit-attest/README.md`; `manifesto` governance layer |
| 9 | The crypto | `THESIS.md`; `protocol/` + `lib/psbt-signer.ts` |

Pedagogy the bot obeys at every rung (lifted from Tapit's
`2026-06-06-teaching-system-spec.md`): just-in-time not just-in-case; show the
consequence not the mechanism; progressive disclosure (one tap deeper, never
forced); question-first/Socratic; enact at low stakes then name it; design the
visceral aha; reflect the user's own data back; name the pain before the cure;
analogy to the familiar; honest milestones never gamified; the bot as patient
backstop that never makes you feel dumb. Zero jargon on the surface layer is a
tested invariant (jargon-guard test) -- "Shamir," "threshold," "descriptor" live
only behind the deeper-disclosure taps.

---

## 6. The confidence ladder -- you grade yourself

The operator's "erase your phone" test, made a real feature and the emotional
spine of the whole thing. There is no certificate and no score the bot assigns.
**The user grades themselves, by their stomach.** The bot's job is to keep
honestly asking the question that surfaces the truth:

> "If I erased your phone right now, could you get back to your Bitcoin? Walk me
> through every way. How many independent ways do you have?"

A person early in the rabbit hole feels the drop in their stomach -- that fear
is accurate, and the bot does not paper over it. A person who has built enough
redundancy answers "yeah, I'm fine -- I have so many ways back I don't even feel
it anymore," and *that felt confidence, earned by doing the work, is the
readiness signal.* The bot tracks the redundancy the user has actually
established (keys in different hands, tested seed restores, metal backups, heirs
provisioned, recovery drills run) and reflects it back as a plain readiness
picture -- never a gamified streak, always "here is what you could lose and here
is what you now cannot."

This plugs straight into the wizard's **year-later check-in** (chat-wizard spec
section 5) and the `/reminders` surface: a person logs back in having done
nothing, and the bot runs the same checklist a careful Bitcoiner runs on
themselves -- have you tested a seed restore, is your metal backup still where
you put it, has any trustee gone silent? The **recovery drill** (Tapit
teaching-spec cut 3) is the enacted version: a safe practice run that teaches
recovery by doing it in a calm moment, so the confidence is real and not
imagined. The honest endpoint the operator described -- not feeling the phone
erasure at all -- is the product working: a person fit to transition value to
the next generation because they earned the certainty themselves.

---

## 7. The tiling -- what each repo contributes

The "tile this together" map, so the next carpenter sees the whole house:

- **DynastyTrust** -- the *what* being taught (three-path Taproot vaults,
  timelocks, governance, trust docs, roles) and the *home* of the bot. The
  manifesto and THESIS are the knowledge base; `chat-wizard-mediator.md` is the
  conversational implementation; the vault templates carry the scenario
  playbooks the bot narrates.
- **Tapit Wallet** -- the *how to teach it* (the entire pedagogy: two levers,
  just-in-time/progressive-disclosure/Socratic, the teach-back success test, the
  aha-moment design, honest non-gamified milestones) and the *sovereign identity
  home* (it is the one place a person's keys live; other apps connect to it to
  get something signed).
- **tapit-attest** -- the *shared primitive* under both: one Schnorr/secp256k1
  attestation envelope, six kinds, three tiers. It is DynastyTrust's governance
  attestations (`trust_doc`, `proof_of_life`, `death_declaration`) generalized.
  It is the seam for both the **login** (the `identity` kind) and the
  **attestations the bot helps a family produce** (the `agreement` kind).

The deeper unity, in the operator's words: hedges around everything. An apple
tree in the backyard, Dynasty Trust Bitcoin in a vault, and Tapit attestations
proving what happened -- redundancy across *kinds* of stored value, taught as one
literacy rather than three product manuals.

---

## 8. The login / attestation seam -- pending operator decision

Already flagged in `chat-wizard-mediator.md` section 9 and `super-sovereign-mode.md`
step 3: tap-wallet sign-in via a `tapit-attest` `identity` attestation, sitting
alongside (not replacing) Supabase email/password as the sovereign option. The
"super AI login helper" framing makes this the natural front door -- the bot
greets you, teaches what signing in with your own key means, and walks you
through the challenge-response, holding the no-key-access rail throughout. Open
questions stay open until the operator reconvenes (do not build): where the
tap-wallet key lives relative to the browser keystore; whether the bot
orchestrates attestation ceremonies end-to-end; how this lines up with Super
Sovereign Mode's local-keypair auth so the seam is built once. Decision needed
before code. Flag it; do not guess.

---

## 9. Build order -- the first slice (extends the wizard's slices, does not fork)

The conversational engine is already specced in `chat-wizard-mediator.md`
(slices 1-5: guided vault build, persistent memory + year-later check-in,
trust-doc Q&A, role-aware mediation, tap-wallet integration). This curriculum
rides those rails. The smallest education-specific slice that proves *this*
doc:

1. **Curriculum content module + the Rabbit Hole dial.** A `literacy.ts`-style
   content module (mirror Tapit's pattern) holding rungs 0-9 keyed by concept,
   each with consequence / why-it-works / the-crypto layers and a source pointer;
   plus the Express-vs-Rabbit-Hole dial wired into the existing guided flow. The
   jargon-guard test (no Shamir/threshold/descriptor on the surface layer) is
   part of done. This is copy + a dial -- shippable on top of wizard slice 1.
2. **The "erase your phone" confidence check** as a real prompt in the
   year-later check-in (wizard slice 2 + `/reminders`), reflecting the user's
   actual established redundancy back as a readiness picture.
3. **The recovery drill** (enacted teaching) once slice 2 exists.
4. **The first-verify aha** when attestations land (wizard slice 3 + the
   `tapit-attest` seam in section 8).

Slice 1 is the proof that the rabbit hole can live in one place behind one dial.
Everything else grows from its spine. Honor every rail in section 2; use the
design system throughout (no `alert()`, no hardcoded colors, no per-page
palette, per DynastyTrust CLAUDE.md); the bot proposes and the human disposes.

---

## 10. What this is NOT

- **Not a course, academy, quiz, or streak.** Education is a property of the
  flow -- taught just-in-time as decisions arise -- never a gate you must pass.
- **Not a restriction on the tool.** Anyone can use DynastyTrust; the expert
  Express path is never walled. We teach everything and gate nothing; the user's
  own stomach decides readiness.
- **Not a bot with authority.** It never spends, signs, holds a key, or commits
  a value without a human tap. "No control" is the spine (section 2).
- **Not a second source of Bitcoin facts.** Every lesson is grounded in the real
  artifacts in section 5; the bot consumes them, it does not invent them.
- **Not biased.** It teaches the capability and the tradeoff, never a conclusion,
  for the individual's benefit above any group's, company's, or our own --
  including ours. It will honestly help a willing person decide DynastyTrust is
  not for them, and that is the feature, not the bug.

---

## 11. Grounded addendum -- layered UTXO + attestation login (operator idea, 2026-06-15)

The operator sketched a richer architecture and asked that it be bounced around
all three repos and grounded in **actual code, not memory**. Two agents read the
real source in both `tapit-attest` copies and the DynastyTrust Rust/TS signing
path. This section records the idea, what the code actually supports today, and
the honest walls -- so the bot can build rules around where we do and do not need
to go, and surface the risk before anyone takes it on.

### The operator's idea, distilled

A person logs into DynastyTrust by **signing an attestation** with their Tapit
Wallet key (proving control of the key), and keeps that sign-in attestation in
their own wallet as a queryable record -- "show me when I signed in, and when."
Then a UTXO is gated in layers: a **fast path** that requires a large *social
quorum* (say ten people, or "one of a hundred keys in an attestation group"
PLUS a separate trustee quorum) all coming together -- two legs of one path tied
together, the group must agree AND the trustees must agree. The fast path alone
is never enough; the social-quorum leg is one of the signatures that must
assemble. If the social quorum cannot assemble (people offline, not enough happy
campers), no harm done -- you fall back to the **slow path**, already set up,
which unlocks on a timelock. And the layering goes all the way down: longer
timelocks with progressively easier quorums, so even in a total-failure
scenario the value is eventually recoverable rather than lost forever. "Layers
and layers of different things you can do," with the bot navigating them.

### The load-bearing wall the bot MUST teach: on-chain vs off-chain

This is the single most important honest distinction, and it is confirmed
straight from the code. **A tapit-attest signature is NOT a Bitcoin spend
signature.** An attestation Schnorr-signs a domain-separated tagged-hash digest
of an *envelope* (in `tapit-attest`: `taggedHash('tapit/root', metaHash ||
fieldTreeRoot(claim))`, see `src/core/envelope.ts`; in Dynasty's own
`apps/web/src/lib/attest.ts`: `SHA256("DT-ATT-v1" || type || 0x00 ||
target_hash)`). A Taproot spend requires a Schnorr signature over a **BIP341
tapscript sighash** (`apps/web/src/lib/psbt-signer.ts`). These are different
preimages *by design* -- `tapit-attest/src/internal/hash.ts` states the domain
separation exists "so an attestation signature can never be replayed as a
Bitcoin sighash." Neither `tapit-attest` copy nor the Dynasty compiler ever
builds, signs, or touches a Bitcoin transaction with an attestation (confirmed:
`grep -i attest` over `compiler/src/main.rs` returns nothing; the attestation
code is purely the web/governance layer).

So an attestation -- including a "we all agree" social-quorum attestation or a
"descriptor" attestation -- is an **off-chain coordination/governance/audit
artifact**. It is enforced by the app, the database (RLS), and the social
discipline of the members, NOT by the Bitcoin script. The crucial bridge: it is
the **same key**. A person's secp256k1 x-only key (the BIP340 shape, identical
to a Taproot key) can produce both an off-chain attestation AND an on-chain
tapscript signature. That is what makes the layered design real -- but the two
roles must never be conflated, and the bot's first job here is to teach that an
attestation expresses *intent and agreement*, while only a tapscript signature
*moves a coin*.

### What the code supports today (buildable now)

1. **Two thresh legs ANDed into one spending path already exists.** The
   "fast path = group agrees AND trustees agree" shape is literally the
   **consent gate** in `protocol/src/policy_compiler.rs` (lines 224-239):
   ```
   let trustee_thresh = format!("thresh({},{})", policy.founder_quorum, founders.join(","));
   let founder_thresh = if policy.has_consent() {
       let consent_thresh = format!("thresh({},{})", policy.consent_quorum.unwrap(), consenters.join(","));
       format!("and({},{})", trustee_thresh, consent_thresh)
   } else { trustee_thresh };
   ```
   The compiler does not care what the two key sets *mean* -- feed the social
   group as one thresh and the trustees as the other and you have "two legs of
   one path tied together." The Generational Trust template already turns this on
   (`consentEnabled: true` in `PolicyBuilder.tsx`). There is **no hard-coded
   key-count cap** anywhere (`verify()` only checks `0 < quorum <= keys.len()`);
   the real ceiling is what rust-miniscript and Tapscript will compile and
   satisfy.
2. **Fast leaf + timelocked fallback leaves = multileaf Taproot, already the
   core primitive.** "Fast path now, slow path on a timelock, layered down" maps
   exactly onto the existing founders-now / recovery / inheritance / protector
   leaves, each its own Taproot leaf with its own `after(N)` absolute CLTV and
   its own quorum. Adding "more layers all the way down" = more timelocked leaves
   with progressively easier quorums. Buildable as additional leaves; no new
   crypto.
3. **Login-by-attestation has its primitive already.** The Dynasty `tapit-attest`
   copy has a nonce-bearing signed request/response (`src/core/recovery.ts`:
   random `nonce`, Schnorr-sign a tagged `requestDigest`, verifier checks the
   echoed nonce + signature) -- structurally exactly a sign-in challenge. The
   wallet copy exposes `signDigest` (for Nostr ids) as the seam. Either is reused
   for "sign a challenge to prove key control"; no login function exists by that
   name yet, so it is a small build, not a new primitive.
4. **Proof-of-when is real and Bitcoin-backed.** Both copies anchor the
   attestation digest via OpenTimestamps (`anchoring.ts` / `anchor/`). So a
   signed sign-in attestation, anchored, proves it existed -- with the honest
   caveat that OTS proves "existed before block N" (a coarse not-after), not a
   precise wall-clock instant. Good enough for "I signed in around then," not for
   "at 3:42:07pm."

### The walls the bot must build (risks to surface before taking them on)

- **Big social quorums belong OFF-chain.** A hundred keys in a single on-chain
  thresh leaf is where the implicit ceiling bites -- tapscript will technically
  compile a large `thresh`, but witness size, satisfaction cost, and standardness
  make a 100-key on-chain leg impractical and expensive. The honest design: keep
  the *large* social quorum as an **off-chain attestation gate** (the group signs
  "we agree" attestations the app verifies), and keep the **on-chain** script
  small -- the trustee thresh plus, at most, a small delegate set. The bot should
  steer a "ten people / a hundred keys" social quorum to the off-chain leg and
  explain why, rather than letting someone compile an on-chain leaf that may not
  spend.
- **"The network recovers it / the minors get it at the very end" needs a name.**
  A final, very-long-timelock, very-easy leaf (e.g. a single published key after
  many years) does NOT mean "the network" recovers it -- it means *whoever holds
  that key* can sweep it after the timelock, and publishing the key makes it a
  public race. That can be a deliberate, sound design (a true last-resort), but
  the bot must teach it as exactly what it is: a known, chosen risk, not a magic
  safety net. This is the "know the risk before you take it on" rule made literal.
- **Off-chain agreement is not on-chain enforcement.** If the social quorum's
  agreement lives only in attestations, then the app/DB outage or a hostile
  server cannot *steal* coins (the script still needs real tapscript sigs), but
  it CAN stall the fast path -- which is exactly why the timelocked slow path is
  the honest fallback the operator already intuited. The bot frames the fast path
  as convenience and the timelock as the guarantee.
- **One stale-comment bug to flag, not fix here.** `protocol/src/governance.rs`
  still describes timelocks as "CSV / UTXO age" in its comments, but the on-chain
  leaves are unambiguously absolute `after()` / OP_CLTV. The off-chain evaluator's
  framing is stale terminology; if it were ever fed UTXO age instead of absolute
  chain height it would mis-report unlock timing. Worth a separate cleanup pass.

### How this lands in the bot

This is curriculum rung 6 ("how do I control it") and rung 7 ("who do I trust")
made deep, plus the section 8 login/attestation seam made concrete. The bot's
job is to let a willing person design these layers *with* it -- propose the leaf
structure, show each leg in plain language, tap-to-confirm every key set and
timelock, and at every step name where enforcement actually lives (Bitcoin
script vs app/social) and what each layer can and cannot protect against. It
builds the walls and the rules so the person does not wander into a leaf that
will not spend or a "last key" they did not understand -- holding the section 2
no-control spine throughout: it proposes the architecture, the human disposes,
and no key ever enters its context. The full ceremony (does the bot orchestrate
attestation signing end-to-end, where the tap-wallet key lives relative to the
browser keystore, how this lines up with Super Sovereign Mode's local-keypair
auth) stays the pending operator decision from section 8 -- captured, grounded,
not yet built.

### 11a. The FROST social leg (operator refinement, 2026-06-15)

The operator refined the social-quorum idea into something sharper: a "fast
path" where a large group (say 75 of 100 people) each hold a tiny piece, and
when enough of them show up and "put their key in the hole," a complete
signature assembles and signs the everyday spend -- but the moment a duress
signal fires ("he's been kidnapped"), people *withdraw* their pieces, the
threshold can no longer be met, the fast leg dies, and the coins fall back to a
timelocked path B (a long recovery lock). Each participant is also an
attestation -- proof of life, proof of "all is well," a green/red gate -- and
both Tapit and DynastyTrust could each use whatever signing scheme fits a given
leg. This is correct and powerful, and the right primitive for it has a name:
**FROST** (Flexible Round-Optimized Schnorr Threshold signatures).

What is true, and what the bot must teach precisely:

1. **FROST does exactly the "75 of 100 assemble a signature" thing -- without
   ever reassembling the key.** This is the one correction to the mental model.
   There are two different "split into 100 pieces" technologies and they must
   not be blended. *Shamir secret sharing* literally reconstructs the whole
   private key at one place and moment (the "portal where the key becomes
   complete") -- and that reconstruction instant is a single point of theft.
   *FROST* never reconstructs the key: each participant produces a signature
   **share**, and the shares combine into one valid Schnorr signature, while the
   private key never exists anywhere, ever. For a *signing* leg you want FROST,
   not Shamir-reconstruct, because it gives the identical "enough people show up
   and it unlocks" experience with no moment the full key can be stolen. (Shamir
   stays the right tool for backing up a *static secret* you need to recover,
   which is a different job -- the Tapit leak-vs-loss lever.)
2. **FROST collapses a 100-person quorum to ONE on-chain key -- which solves the
   problem section 11 flagged.** Earlier we warned that a 100-key `thresh` in one
   Taproot leaf is impractical on-chain. FROST is the answer: the entire
   75-of-100 ceremony happens off-chain, and the Bitcoin script sees a single
   aggregate public key -- `pk(AGG)` -- indistinguishable from a normal
   single-key spend. The big social quorum lives off-chain (where big quorums
   belong) and lands on-chain as one key. That is the clean version of "the
   social leg is the fast path."
3. **The fast-leg / fallback dance maps straight onto multileaf Taproot.** Leaf 1
   = `pk(FROST_AGG)`, the everyday/social fast path. Leaf 2+ = `and(after(N),
   thresh(Q, hardware_recovery_keys))`, the timelocked fallback. If the duress
   alarm fires and participants withhold their shares, the threshold cannot be
   reached, leaf 1 simply cannot produce a signature, and the coins are not
   stuck -- they are protected by falling to the timelock leg. This is the same
   "fast path is convenience, timelock is the guarantee" shape from section 11,
   now with FROST as the fast leg.
4. **Different legs, different schemes -- yes.** Tapscript multileaf does not care
   how each leaf's key material is produced. The social leg can be FROST; the
   recovery leg can be a plain Miniscript `thresh` of Coldcard/Sparrow/Nunchuk
   keys; a third leg something else. Tapit and DynastyTrust can each adopt FROST
   independently -- it is just a signing protocol over the same secp256k1/BIP340
   curve both already use; they are not entangled by sharing it.
5. **The green/red liveness is the attestation layer.** "He's alive, we shook
   hands at Christmas" is an off-chain proof-of-life attestation; "withdraw your
   piece" is a participant declining to join the FROST signing round, optionally
   backed by a duress/revocation attestation. The bot's job is to make that
   signal legible and turn a duress alarm into "do not sign," holding the
   no-control spine.

The honest caveats the bot must surface before anyone takes this on: FROST needs
a distributed key-generation ceremony up front and a coordinated two-round
signing ceremony each time, it requires `t` participants to actually be live and
reachable (the same availability-vs-security tradeoff from curriculum rung 3),
and it has a sharp implementation edge -- nonce reuse or bad nonce handling in a
FROST signing round can leak a participant's share -- so it must ride a vetted,
audited library, never a hand-rolled implementation. It is newer and less
battle-tested in production wallets than plain k-of-n multisig. And because the
FROST aggregate key is a single leaf, the timelocked fallback leg is the *only*
backstop if the FROST group is ever permanently lost, so that fallback's design
carries the whole safety burden. Ground truth today: **neither repo implements
FROST** -- Tapit and DynastyTrust both sign with plain per-signer BIP340 Schnorr,
and DynastyTrust enforces quorums with Miniscript `thresh`, not threshold
signatures. So FROST is a *new primitive to add later*, the "work our way up"
target. The operator's own sequencing is right and is the rule: the
lowest-hanging fruit for Tapit + DynastyTrust together is **small quorums and
small amounts on the primitives that already exist** -- the `and(thresh, thresh)`
consent-gate two-leg pattern plus a timelock fallback, proven with five dollars
first -- and only once that is trusted do we climb to FROST social legs and more
elaborate trust structures.
