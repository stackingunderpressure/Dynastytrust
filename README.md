# DynastyTrust

Bitcoin multi-generational vault platform. Families and organizations create
Bitcoin vaults with governed spending policies across multiple signers --
structured inheritance and recovery for Bitcoin, without custodians.

## What it is

Every vault compiles up to three spending paths into one Taproot output:
founders can spend now, a recovery group can spend after a timelock if a
founder goes quiet, and heirs inherit unilaterally after a longer timelock,
with an optional outside-protector path on top. Bitcoin enforces the rules;
DynastyTrust only coordinates the paperwork around them -- compromising our
servers never moves a coin. See `docs/manifesto.md` for the full pitch and
`docs/sovereignty-education-bot.md` for the plain-language curriculum this
app teaches on the way, one rung at a time, as deep as you want to go.

## Addresses & privacy -- read this before you fund a vault

DynastyTrust is **not** an HD/deterministic wallet in the sense most Bitcoin
software is. A typical wallet -- Sparrow, Electrum, most mobile wallets --
hands you a fresh receive address for every transaction, derived from a
ranged xpub, specifically so a casual chain-watcher can't trivially link
your deposits and spends together.

A DynastyTrust vault does the opposite, on purpose: **one vault, one fixed
address, for its entire life.** Every deposit into a vault, every spend from
it, and any change left over from a partial spend all land on that exact
same address. This is not an oversight. The compiler bakes a vault's
specific founder and heir keys into its Taproot leaves once, at creation,
and only ever knows how to build a spend for that one fixed child key
(`pk([fp/path]xpub/0/0)`, never a wildcard `/0/*` range) -- a "fresh address
every time" design would mean advertising receive addresses the vault's own
compiler has no ability to actually spend from.

Why accept that tradeoff? Because a vault is not a spending wallet cycling
through addresses in private -- it is meant to be a durable, auditable
structure that several people (co-trustees, heirs, sometimes an attorney)
need to be able to point at and verify for themselves, the way a company
treasury address is often deliberately kept public. The cost is real:
address reuse is Bitcoin's best-known chain-analysis foothold, and anyone
who ever learns a vault's address, today or in twenty years, can see its
entire balance and transaction history.

**If you want a new, unlinked address, the answer is a new vault, not a new
address from this one.** Creating a new vault is a fresh compile and a
genuinely new Taproot output with no on-chain link to the old one. One
nuance worth knowing rather than glossing over: reusing the same founder or
heir keys across multiple vaults can still let sophisticated chain analysis
correlate those vaults with each other, even with different addresses, if
they are ever funded from or spent to the same place in the same
transaction -- a new vault buys you a new address, but a genuinely unlinked
one also wants independent keys standing behind it.

See `docs/sovereignty-education-bot.md` (rung 6) and `docs/manifesto.md`
("What this is not") for the full teach, and `CLAUDE.md` ("Address type:
always tr_multileaf") for the engineering rule all of this traces back to.

## Getting started, tests, deployment

See [`docs/README.md`](docs/README.md).
