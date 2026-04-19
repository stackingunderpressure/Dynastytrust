# DynastyTrust

**Multi-generational Bitcoin vaults for people who do not trust custodians.**

---

## What it is

A platform for building Taproot multisig vaults with built-in
inheritance, recovery, and governance paths. Open source. Browser or
hardware signing. Keys never leave the signer. One day the app
goes offline and your coins still spend from Sparrow.

If you already know what `tr(internal, {and_v(v:after(H_i), thresh(Q_h, heirs)), {and_v(v:after(H_r), thresh(Q_f, founders)), thresh(Q_f, founders)}})` means, you can skip to the Stack section.

---

## Why it exists

Bitcoin already gives us self-custody. It does not give us:

- A way for three siblings to share one treasury without one of them
  running off with it
- A way for a parent to pass 6 figures of coins to a 15-year-old
  without handing them the keys today
- A way for a charity to hold endowment funds with rotating trustees
  and an auditable governance log
- A way for an anarchist with a wrench-attack concern to set up a
  vault that not even they can drain under duress

Multisig plus timelocks plus miniscript solves all of this. None of
it is usable today unless you can hand-write Miniscript policy,
compile it yourself, manually assemble PSBTs, and explain the whole
thing to four family members who just want to know what to click.

DynastyTrust is the usable form of that primitive. Nunchuk for the
coordination, Liana for the timelock idea, a trust-doc + attestation
+ governance layer on top that neither of them ship.

---

## What it enforces vs what it does not

**Bitcoin enforces.** Once a vault is compiled, no upgrade key, no
admin, no custodian, no DynastyTrust server can move the coins.
Spending requires a valid Schnorr signature from a quorum of the
keys defined in the script. Full stop. We cannot undo it. A court
cannot undo it. We cannot delete your vault.

**DynastyTrust coordinates.** The trust doc, member roster,
proposals, comments, attestations, and governance log live in a
database. We can be subpoenaed for metadata. We cannot forge a
signature. Compromising our server does not let an attacker move
coins; it lets them see who the members are and what proposals are
pending. In sovereign mode that database is on your laptop.

Keep this distinction clean in your head. Everything downstream
derives from it.

---

## The primitive: three paths compiled into one Taproot output

Every vault is an address with three Taproot leaves:

```
Path 1: thresh(Q_f, founders)
        Founders now. Available from the first confirmation.

Path 2: and(after(R), thresh(Q_f, founders))
        Recovery. Same founder quorum but with an absolute block
        height gate. Useful if one founder goes silent: after R,
        the remaining quorum can still move funds without them.

Path 3: and(after(I), thresh(Q_h, heirs))
        Inheritance. A heir quorum can spend unilaterally after
        absolute block height I. No founder cooperation required.
        This is how you pass coins to the next generation without
        handing them the keys today.
```

Optional fourth path for a **protector** key (single signer plus a
timelock) for cases where you want an outside arbiter.

Timelocks are absolute CLTV (`OP_CHECKLOCKTIMEVERIFY`), not relative
CSV. That matters because BIP 68 caps CSV at 65,535 blocks, about
15 months -- too short for any serious inheritance. The compiler
fetches the current chain tip and bakes `tip + offset` into the
leaf. A 25-year inheritance horizon is trivial.

The address type is `tr_multileaf`: each path goes in its own script
leaf under a single Taproot output. Cheap to receive, cheap to
spend on the happy path, no reveal of the other paths unless you
use them.

---

## The governance layer

Bitcoin does not know what a trust is. People do.

**Trust document.** Purpose, beneficiaries, distribution rules,
succession notes. A structured JSON object that travels with the
vault. Templates for Family Inheritance, Generational Trust,
Business Treasury, Charitable Endowment, and a few others.

**Attestations.** Every member Schnorr-signs the SHA-256 of the
canonical trust-doc JSON under a domain-separated tag. Change one
comma, all signatures invalidate and you see "0 of 5 attested"
until everyone re-signs. Uses the same Bitcoin key that moves the
coins. Court-admissible audit trail of who agreed to what version
and when.

**Proof of life.** Founders sign a fresh timestamped nonce
periodically. Heirs see "last heard from Dad: 47 days ago." Silence
becomes legible.

**Death declaration.** Witnesses sign a declaration of death for a
subject. Bitcoin timelocks are immutable, so this does not unlock
the inheritance path early -- but it gives trustees a signed,
multi-witness record so rotation and heir provisioning can start
before the on-chain timelock elapses.

**Role-aware dashboards.** A trustee sees the signing queue. A
beneficiary sees their distributions and timelock countdowns. A
protector sees activity they should know about. A successor sees
time-to-inheritance. Same vault, five different views.

**Attorney-grade PDF export.** Every signature, every vote, every
comment, every timestamped event, every attestation -- in a single
document that a judge or tax attorney can sit with.

**Event-level audit export.** Full JSON of the governance log with
Bitcoin block heights tagged to each event. For the people who want
the raw stream.

---

## The stack

| Layer                 | Tech                                                 |
|-----------------------|------------------------------------------------------|
| Script compiler       | rust-miniscript (round-trip verified on every build) |
| Vault script          | Taproot multileaf, absolute CLTV                     |
| Signing               | Schnorr, BIP 341 sighash, BIP 371 PSBT v2            |
| Key material          | BIP 32 / BIP 39, stored in the browser or HW wallet  |
| Air-gap signing       | UR-encoded QR (crypto-psbt, crypto-output)           |
| Address monitoring    | mempool.space (swappable for your own node)          |
| E2E messaging         | X25519 + HKDF-SHA256 + ChaCha20-Poly1305             |
| Attestations          | BIP 340 Schnorr under domain-separated tag           |
| Database              | Postgres (hosted) or SQLite (sovereign mode)         |
| Frontend              | React + Vite, no framework lock-in                   |

Descriptors import cleanly into Sparrow. Every compiled vault
produces a plaintext backup with the full descriptor, miniscript
policy, xpubs, quorums, timelocks, and step-by-step Sparrow import
instructions. Also a scannable QR of the raw descriptor for metal
backup. If DynastyTrust vanishes tomorrow, you spend from Sparrow
with your backup file and one seed phrase.

---

## Two modes, one codebase

**Hosted.** Sign up with email, click buttons, have a functioning
multisig family trust in 20 minutes. Optional legal wrapper through
a partner law firm (Wyoming Statutory Trust, Nevada DAPT, Cayman
STAR). Annual attestation reminders. Support that responds. For
families who want a working vault and a human to ask questions to.

**Sovereign.** Download a single binary. Local SQLite, local policy
compiler, local keypair identity (no email), Tor by default, Nostr
relays for peer sync. No telemetry, no accounts, no ability for
anyone to compel us because we are not in the flow. Ships as open
source. Signed releases, hash-pinned on IPFS. Supported only by the
source code.

You can migrate either direction. Export the descriptor, import it
in the other mode, same vault, different shell. The Bitcoin side is
identical because there is no other Bitcoin side.

---

## What you need

- A modern browser, or the desktop binary (sovereign mode)
- 1 to 5 seed phrases (more if you want heir keys separate from
  founder keys). Generated in the app or on hardware wallets.
- An agreement among the humans involved about who is a founder,
  who is an heir, how long the timelocks are, and what the trust
  doc says
- Optionally: a Wyoming / Delaware / Cayman trust instrument if you
  want the legal layer on top

That is the whole requirement list. No KYC, no accredited-investor
gate, no minimum balance, no geographic restriction.

---

## What this is not

- **Not a wallet.** It is the coordination layer that sits on top of
  wallet-grade signing. Your wallet stays your wallet.
- **Not a custodian.** We never see a private key. Ever. We cannot
  move your coins under any circumstance. This is not a marketing
  claim; it is a property of the code.
- **Not a legal trust.** It is the mechanism of a trust. Pairing it
  with a statutory trust instrument in a crypto-friendly
  jurisdiction is what makes it a legal trust. Wyoming DST costs
  around $500 and takes a day. We can refer.
- **Not a replacement for cold storage for small amounts.** If you
  have 0.05 BTC, use Sparrow + a single seed. This is for amounts
  and time horizons where the cost of losing one key outweighs the
  cost of coordinating three.
- **Not beginner-friendly yet.** We are working on it. A bitcoiner
  who has done at least one multisig setup will have no trouble. A
  normie will want help.

---

## For bitcoiners

You already know:
- Why self-custody matters
- Why multisig is the right answer for significant holdings
- Why keeping keys across devices and locations beats any single-
  device solution
- Why a 25-year Taproot inheritance leaf beats "tell my wife the
  seed is behind the furnace"

What DynastyTrust adds:
- The miniscript compilation you would otherwise write by hand
- The coordination UI your spouse and kids can actually use
- The Taproot multileaf descriptor that imports into Sparrow
- The attestation layer that turns "we talked about it" into "we
  signed it"
- The PDF export your attorney understands

The hard Bitcoin work is done correctly. BIP 341 sighash, BIP 371
PSBT encoding, key-origin descriptors, x-only pubkeys at the leaf,
domain-separated tag for governance sigs. You can read the code and
verify all of it before you trust an sat to it. We encourage that.

---

## For normal bitcoiners who want to DIY

You can. It will take weeks and you will get it wrong at least
three times. The first time we fixed the BIP 341 sighash it took
two days of staring at hex. The control block verification error
cost a weekend. The sha_prevouts omission cost half a Sunday. The
/0/0 child-key mismatch cost another day. All of these are bugs we
found and fixed so you do not have to.

If you want the bragging rights: clone the repo, read
`protocol/src/policy_compiler.rs` and `apps/web/src/lib/psbt-signer.ts`,
and do it yourself. We will not be offended.

If you just want the outcome: use the app.

---

## For normies (the hardest sell)

A multisig vault is like having three keys to a safe deposit box
instead of one. Two of the three keys are needed to open it. Lose
one key and you can still get in. Someone steals one key and they
cannot do anything with it.

DynastyTrust lets you set one of those keys up so that after some
number of years, your kids can open the box by themselves, without
needing your permission. That is the inheritance.

We do not hold any of the keys. We provide the tool. Your money
stays yours the whole time. If we shut down, your money is still
yours.

The cost is that you and the other people in your vault have to
keep track of your keys. If all three keys are lost, the money is
unrecoverable. That is the deal with self-custody. The upside is
that no one -- not us, not a bank, not a government, not your
ex-spouse -- can take it from you without your cooperation.

---

## Getting started

**Signet testnet first.** Set up a vault with play money, walk
through a transaction, see how the parts fit. An evening.

**Mainnet, small amount.** A fraction of a coin, one real-world
transaction. Test the recovery path. Test the inheritance path (set
a 24-hour timelock for this exercise). Spend a weekend.

**Real deployment.** When you trust your setup more than you trust
your bank, fund the vault at scale and archive the setup vault.

---

## The bet

Bitcoin is 16 years old. In 16 more years it will either be
irrelevant or the default store of value for families that care
about generations. If the second one happens, the families who set
this up correctly right now will pass wealth across a century
without ever touching a bank, a custodian, or a regulator. That is
the generational-sovereignty bet.

We built DynastyTrust because nobody else is building the trust
layer for Bitcoin. Wallets are solved. Custodians are solved. The
part where five family members coordinate around an immutable
policy for the next fifty years -- that is not solved. This is
our solution.

---

## Links

- Source: github.com/stackingunderpressure/dynastytrust
- Hosted: dynastytrust.family
- License: [open source]
- Support: GitHub issues, community chat

**Not your keys, not your coins. And now, finally, not your
trustees' problem either.**
