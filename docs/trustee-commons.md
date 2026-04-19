# Trustee Commons -- idea + plan

Status: design note. Not implemented. Captures the concept of an
anonymous, bonded, fee-earning trustee network that sits on top of
the DynastyTrust vault primitive.

---

## The concept in one paragraph

A vault founder recruits N trustees from a global pool of anonymous
personas instead of naming specific humans. Trustees hold the
recovery / inheritance keys, earn a fee on signings they
participate in, and are bonded against misbehavior. Matchmaking is
cryptographically unbiased, so neither side picks the other.
Non-cooperating trustees get swapped out and their bond slashed.
The system replaces "trust a specific human fiduciary" with "trust
the incentive structure."

Trustees do not hold the founders-now key. They only matter when
founders cannot act (recovery path) or are deceased (inheritance
path). That is what makes anonymity safe -- everyday spending stays
under founder control.

---

## Why this is interesting

- Traditional trustees are expensive ($5-50k/year minimum) and
  bring regulatory baggage (bonding, licensing, disclosure).
- Family members serving as trustees work until they don't.
  Conflicts, death, drift, estrangement all happen over 50-year
  horizons.
- An anonymous networked pool commoditizes fiduciary labor. Price
  falls, availability rises, conflicts disappear, identity-based
  coercion becomes impossible (nobody can bring a wrench to a
  trustee whose name they don't know).
- Reputation + bond replaces licensing + courts. Same function,
  different enforcement.

---

## Architecture (five layers)

### 1. Vault layer -- already shipped

Taproot multileaf, absolute CLTV, Miniscript policy. No change.
Trustees slot into the recovery + inheritance paths as anonymous
keyholders; founders keep the founders-now path.

### 2. Persona layer

Each trustee is a persistent secp256k1 pubkey with no IRL tie.

Per persona:
- BTC bond locked in a slashing contract (see layer 5)
- Reputation ledger: signed history of every job -- response time,
  correctness, slashing events
- Nostr-style identity: a pubkey used to sign all the persona's
  events across the network

A human can run multiple personas. That's the Sybil problem (see
"About Sybil" below).

### 3. Matchmaking layer

Founder publishes a vault-request event to Nostr relays:

```
"I need 5 trustees, 3-of-5 quorum, paying 0.1% per signing event,
minimum persona reputation score X, minimum bond Y, signing SLA
24h."
```

Eligible personas bid by posting a signed commitment. A VRF
(verifiable random function) picks N winners from the bidders. The
randomness is provable and nobody can bias it.

Picked personas return xpubs. Vault compiles. Founder never learns
who the trustees are as humans; trustees never learn which founder
they serve or even which other vaults they sit on for the same
network-level user.

### 4. Signing + verification layer

When a spend is needed, the PSBT flows through Nostr / Tor onion
relays to the trustees' persona pubkeys. Each trustee:

- Runs a policy-compliance check (does this match the trust doc's
  machine-readable rules?)
- If compliant: signs within SLA, earns fee
- If not compliant: publishes a signed dispute event within SLA,
  earns no fee, but is NOT slashed because they had cause
- If silent past SLA: slash timer starts

Disputes are visible to the network. They pause the slash timer and
summon a watcher review.

### 5. Bond + slashing layer

Bond is held in a Taproot vault the trustee does not fully control.
The slashing contract releases bond when:

- The trustee exits the network cleanly after N days of no active
  jobs (full bond returned)
- The trustee is slashed by a proven condition:
  - Failure to respond within SLA to a compliant PSBT
  - Signed a PSBT that violates the trust doc's machine rules
  - Provable behavioral correlation with another persona on the
    same quorum (coordinated-signing fingerprint)
  - Provable bond-funding correlation (UTXO ancestry overlap)

Watchers who successfully prove a slashing condition earn a cut of
the slashed bond. Creates market incentive to police the network.

---

## How this fits what we already have

Surprisingly well. Most components already exist:

| Needed for Trustee Commons            | Existing in DynastyTrust     |
|---------------------------------------|------------------------------|
| Vault rotation (swap out trustees)    | Shipped                      |
| Governance engine (policy check)      | Shipped                      |
| Attestations (dispute events)         | Shipped                      |
| Trust doc as machine rules            | Shipped                      |
| Sovereign mode w/ Nostr               | Designed, not built          |
| VRF matchmake                         | New                          |
| Bond + slashing contract              | New (Bitcoin vault variant)  |
| Reputation ledger                     | New (event-sourced)          |

The genuinely new work is the bond contract, the VRF matchmake, and
the reputation ledger. Maybe 3-4 weeks of implementation once
sovereign mode and the Nostr transport layer are in place.

---

## About Sybil -- short version

The attack: one human runs 5 personas that look independent, gets
them onto the same vault's quorum, and signs with themselves to
reach quorum alone.

Primary defense is economic. Every persona locks a BTC bond. To
Sybil a 3-of-5 quorum, the adversary must lock 3x the bond. If the
required bond per persona is calibrated against the vault's value,
the attack is net-negative expected value.

Secondary defenses stack cheap:
- VRF selection so you can't pick which personas land on which
  vault (randomness is forced)
- Reputation gates so fresh personas can only work small vaults
- Slashing for behavioral correlation (coordinated signing timing,
  matching relay footprint, same Nostr client fingerprint)
- Slashing for funding correlation (bond UTXOs with common recent
  ancestry)
- Persona-age spread required in every quorum
- Optional proof-of-humanity credentials (BrightID, Worldcoin) as
  weighted reputation bonus -- not required, for users who opt in
- Watcher network that earns a cut of slashed bonds for catching
  sybils

Residual risk: Sybil is never eliminated, it is priced. A wealthy
operationally-disciplined adversary with a multi-year horizon can
eventually get lucky. The mitigation is that the VRF randomness and
the reputation-building time make this attack expensive relative to
any single vault's upside, and the rotation mechanism lets the
founder sweep funds if trustees start behaving suspiciously before
the attack completes.

See the chat conversation for deeper walk-through of the math; not
rebuilt here to keep this doc focused on the idea plan rather than
the defensive details.

---

## Open questions (to work through later)

1. **Bond asset.** BTC is the natural choice (same asset as the
   vault, same on-chain verification, no bridge risk). Downside:
   bond value correlates with vault value, so a drop in BTC price
   reduces the security margin in real terms across all vaults at
   once.

2. **Fee structure.** Per-signing-event percentage is simplest.
   Alternatives: flat fee, subscription-style retainer, event-
   weighted (emergency > routine). Needs modeling to balance
   trustee income against spam attacks.

3. **Cross-vault persona leverage.** A trustee with 50 active vaults
   is de facto custodying the recovery path of a lot of money. Is
   there a per-persona vault-count cap? Or does the bond-per-vault
   requirement naturally self-limit it?

4. **Dispute resolution.** Machine rules handle the clean cases.
   What about "beneficiary submitted a claim with a PDF of a
   hospital bill, is the claim legitimate?" Trust doc can't
   mechanically verify PDFs. Fallback: human-in-the-loop via the
   protector role, or beneficiary attestations, or multi-witness
   votes. This is where the protocol has to decide how much human
   judgment is inside vs outside.

5. **Regulatory framing.** The network as a whole starts to look
   like an unregistered money transmitter or virtual asset service
   provider in FATF countries. Out of scope for this idea-plan
   document; threat model and defensive posture live in chat with
   the operator, not in the repo.

6. **Identity reuse across jobs.** Does a trustee persona serve
   many vaults with the same pubkey (efficient, more reputation
   accumulated) or a fresh pubkey per vault (better unlinkability,
   weaker reputation aggregation)? Probably a hybrid: long-lived
   persona pubkey for reputation, plus per-vault derivation for
   actual signing key material.

---

## Name

"Trustee Commons" is a working title. Alternatives: "Fiduciary
Pool", "Witness Guild", "Trust Mesh". The "commons" frame captures
the open-access, collectively-maintained nature. Decide once the
idea matures.

---

## Phasing

Do not build this until the following are stable:

1. Sovereign mode binary (so trustees can run locally)
2. Nostr transport layer (the matchmake + signing channel)
3. Governance engine hardened for fully deterministic PSBT validation
4. Rotation flow battle-tested in production

Then:

1. Bond contract + slashing (2 weeks)
2. VRF matchmake + Nostr discovery (1 week)
3. Reputation ledger + watcher protocol (1 week)
4. Trustee CLI + persona management (1 week)

Rough total: 5-6 weeks from stable sovereign base.

---

## What it is not

- Not a replacement for the named-trustee model. Families who want
  a human relationship with their fiduciary should have that. This
  is a parallel track.
- Not a DAO. No governance token, no voting on protocol changes.
  Just a market for cryptographic cooperation.
- Not a custodian. Trustees hold signing keys, not funds. Funds
  stay in the founder's vault the entire time.
- Not an oracle network. Chainlink-style jobs feed data in; trustee
  commons jobs produce signatures out. Different primitive.
