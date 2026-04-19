# Trustee Commons -- design + threat note

Status: design note. Not implemented. Captures the thinking on an
anonymous-trustee network, with explicit attention to Sybil attacks
on the protocol and prosecution risk on the builder.

NOT LEGAL ADVICE. The legal sections summarize publicly available
case law and regulatory guidance. Talk to a crypto-specific
attorney before acting.

---

## The concept in one paragraph

A vault founder recruits N trustees from a global pool of anonymous
personas. Trustees hold the recovery / inheritance keys, earn a fee
on signings they participate in, and are bonded against misbehavior.
Matchmaking is cryptographically unbiased so neither side can pick
the other. Non-cooperating trustees are swapped out and their bond
slashed. The system replaces "trust a specific human" with "trust
the incentive structure."

Trustees never hold the founders-now key. They matter only when the
founders cannot act (recovery) or are deceased (inheritance). That
is what makes anonymity survivable -- everyday spending stays under
founder control.

---

## Sybil attack

**The attack.** An adversary runs M personas that appear independent
to the matchmake. If enough of those personas end up on the same
quorum, the adversary signs with itself, reaches quorum, and
unilaterally moves coins.

**The threshold.** For a quorum of Q trustees out of N seats, the
adversary needs Q colluding personas selected into the same vault.
A pool of size P, of which A are adversary personas, yields:

```
P(capture a quorum in one matchmake)
  = C(A, Q) / C(P, Q)         approx, ignoring independence
```

A concrete example: P = 1000, A = 50, Q = 3, N = 5. The adversary
controls 5 percent of the pool. Probability of capturing 3 of 5
seats in one matchmake is roughly (0.05)^3 * C(5,3) = 0.00125, or
~0.1%. Per vault. Over 1000 vaults the adversary lands one capture.

The attack is not zero-probability. It is a cost-curve problem.

---

## Sybil defenses (stacked; all cheap to implement together)

**1. Economic bonding (primary).**

Every persona must lock BTC into a slashing contract before being
eligible for matchmake. Bond is committed at persona-creation and
grows over time with reputation.

Required bond per persona B, vault value V, quorum Q. Adversary
cost to sybil a quorum:

```
C_sybil = Q * B
Upside   = min(V, V_recoverable)
```

Rule of thumb: if `Q * B > V / 2` the attack is net-negative after
accounting for rotation (see below) recovering half the funds. Set
the matchmake rule so vaults only recruit from persona tiers whose
bond satisfies this.

This is self-sorting. A 10 BTC vault can require 1 BTC persona bond
(10 BTC total cost to sybil 3-of-5, upside capped at 10, negative
EV after rotation). A 10,000 BTC vault requires bigger trustees.

**2. Verifiable random selection.**

Matchmake uses a VRF (or an onchain commit-reveal scheme) to pick
trustees from the eligible pool. Neither the founder nor the
trustees can bias the outcome. An adversary with A personas in a
pool of P cannot steer multiple of its own onto a single vault --
the probability math above applies.

**3. Reputation gates.**

Every signing a persona participates in is logged as a signed
event. Response SLA, correctness (did the PSBT match policy), and
slashing history aggregate into a public reputation score. Vaults
specify minimum reputation for eligibility.

New personas start at zero and earn reputation by participating in
lower-value vaults first. An adversary who wants to attack a large
vault must first operate legitimately across many small vaults for
months or years -- during which the opportunity cost of burning the
persona rises with every legitimate fee earned.

**4. Slashing conditions.**

Bond is slashed for:
- Failure to respond within SLA to a valid PSBT + policy-check
- Signing a PSBT that violates the trust doc's machine-readable
  rules (provable from on-chain data plus the policy JSON)
- Behavioral correlation with another persona on the same quorum
  (signing within milliseconds, identical PSBT-byte ordering,
  matching Nostr relay footprint)
- Bond-funding correlation (bond capital traces to a common source
  in the last N blocks on-chain)

The correlation slashes are the anti-sybil teeth. Perfect detection
is impossible but enough leakage exists at scale that a determined
adversary must invest heavily in operational hygiene across all
personas, which raises per-persona cost.

**5. Proof-of-unique-personhood (optional add-on).**

BrightID, Worldcoin, Gitcoin Passport, Proof-of-Humanity, or a
future ZK-iris attestation. Each adds a "this pubkey is provably
held by a unique human" credential. Weighted into reputation rather
than required -- some users will refuse these on privacy grounds.

Value: raises the cost of running parallel personas. Cost: each
scheme has its own centralization and failure modes, so none should
be a hard requirement.

**6. Bond-capital diversity requirement.**

Bond UTXOs in a single quorum must have no common ancestor in the
last 100 blocks. Crude but kills the most obvious sybil -- funding
5 personas from one wallet. Forces the adversary to either pay
mixing costs or expose funding correlation for the slashing rule.

**7. Persona-age spread requirement.**

Matchmake refuses to fill a quorum from only recent-joiners. At
least 2 of every 5 trustees must have >12 months of clean history.
Slows down fast-sybil attacks where an adversary creates personas
just-in-time for a target vault.

**8. Watcher network.**

Independent watchers subscribe to all trustee events. They detect
anomalies (coordinated timing, failed-to-respond patterns, policy
violations) and publish signed dispute events. Successful disputes
earn a cut of the slashed bond. This creates an economic incentive
for third parties to police the network on behalf of vault owners
who don't want to do the monitoring themselves.

---

## Residual risk after defenses stack

Sybil is not eliminated. It is priced. A sufficiently wealthy,
operationally-disciplined adversary with a multi-year time horizon
can still accumulate a position in the pool large enough to get
lucky on a matchmake.

Vault-side mitigations:
- Rotation-on-demand. If trustees go quiet or behave oddly, the
  founder sweeps to a fresh vault before the attack completes. The
  recovery path timelock (R blocks, often months) gives real time
  to rotate. The attack only succeeds if the adversary can both
  sybil a quorum AND evade founder detection for R blocks.
- Split-quorum. Instead of 3-of-5 from one pool, use 2-of-3 from
  pool A plus 2-of-3 from pool B as a threshold-of-thresholds. An
  adversary must sybil both pools simultaneously.
- Floor on founder participation. Founders co-sign all spends
  except the inheritance-timelocked ones. Trustees alone cannot
  move coins -- they can only fail to cooperate, at which point
  rotation kicks in.

The combination makes the attack uneconomic at realistic vault
sizes. That is the best a protocol like this can do.

---

## Prosecution risk -- US-centric, similar risks elsewhere

The user is the builder / operator of the cloud-hosted service. The
sovereign binary is released as open source, ideally by a separate
or anonymous entity. This section is specifically about the builder.

### Statutes in play

- **18 USC 1960 -- unlicensed money transmission.** Primary charge
  against Tornado Cash developers. Applies if the government can
  argue you operated a money-transmitting business. Mitigating
  facts: you never hold funds, private keys stay with users,
  descriptors and signatures are produced client-side. Aggravating
  facts: you run a server, you accept payment for the service, you
  match trustees to founders (if the hosted build does this), you
  coordinate fees.
- **18 USC 1956 / 1957 -- money laundering.** Requires knowledge
  that funds derive from specified unlawful activity. Conspiracy
  charges (1956(h)) are the typical federal prosecutor's pick when
  1960 is marginal.
- **IEEPA / OFAC sanctions violations.** If the service is used by
  a sanctioned entity (North Korea, Russia, Iran) and you did not
  have adequate blocking controls. Tornado Cash had this on top of
  1960. Applies to anyone with US nexus.
- **FinCEN MSB registration.** Administrative rather than criminal
  on first violation. Registration required for money services
  businesses; guidance is murky on whether non-custodial software
  qualifies. Civil penalties; criminal referral possible.
- **State money transmitter licenses.** 49 separate regimes. Some
  states (NY BitLicense) are aggressive; others permissive.

### Tornado Cash lessons (2022-2025)

- Alexey Pertsev convicted in the Netherlands (2024). Sentenced 5y4m
  for money laundering. Defense argument that "code is speech"
  failed; court focused on active development and fee capture.
- Roman Storm charged in US (SDNY, 2023). Trial ongoing as of 2025.
  Charges: conspiracy to commit money laundering, conspiracy to
  operate unlicensed money transmitter, conspiracy to violate
  IEEPA. Defense: no custody, no upgrade keys, pure open source.
- OFAC sanctioned the smart contract addresses (2022). Later partly
  rolled back after a successful 5th Circuit challenge (Van Loon v
  Treasury, 2024) which held that immutable smart contracts are
  not "property" that OFAC can sanction. Narrow ruling; doesn't
  immunize developers.
- Roman Semenov sanctioned individually (2022). Living in Russia.
- Samourai Wallet founders arrested in US and Portugal (2024).
  Custodial posture, more aggressive marketing than Tornado.
  Conviction looks likely.

### Concrete defense posture for this project

Listed in order of priority. Most can be done concurrently.

1. **Ship open source. Release a specification. Let others
   operate.** The network effect that matters (trustee pool,
   matchmaking relays) runs on commodity Nostr / Tor infrastructure
   anybody can host. You publish reference code and a protocol
   spec. If DOJ wants to go after someone, they're chasing the
   permissionless network, not you. This is exactly what Bitcoin
   Core developers have relied on for 16 years.

2. **Split the entities.**
   - `dynastytrust.family` -- a Delaware C-corp or equivalent.
     Operates the hosted compliant path. Partner firms for KYC on
     legal-wrapper customers. FinCEN MSB registration filed if
     counsel recommends (arguable either way given no custody).
     This entity does not ship the sovereign binary.
   - Sovereign binary -- released from a separate entity. Options
     in increasing order of protection:
     a) Anonymous pseudonym releases to GitHub + IPFS
     b) A foreign foundation (Switzerland Stiftung, Swiss Verein,
        Cayman foundation)
     c) A DAO-structured release process with a multi-sig
        maintainer key where no single person has release power
   The two entities share no officers and no bank accounts. Dual-
   use is not a defense by itself, but structural separation is.

3. **No custody, ever. Prove it in code.** Everything about this is
   already true in the current codebase. Make it unmistakable in
   the docs, the audit report, and the terms of service. "We
   cannot move your coins" is the single most important technical
   claim you can make in a courtroom.

4. **Geographic hygiene.**
   - Don't live in the US if you can avoid it. At minimum, don't
     conduct development from US soil if you have options. Portugal
     (NHR regime, crypto-friendly until recently), UAE (Dubai VARA
     registration), Switzerland (Crypto Valley), El Salvador
     (bitcoin-legal, no capital gains), Panama.
   - If you must be in the US: don't officer-serve in a company
     that operates the sovereign path. Use an LLC with a non-US
     member for that path and pay yourself only for the compliant
     path work.
   - Minimize travel to adversarial jurisdictions. The Samourai
     founders were arrested during travel to Portugal after US
     charges.

5. **Public-facing copy discipline.**
   - The manifesto's "sovereign FU mode for anarchists" framing
     plays great in private but is a federal prosecutor's dream
     exhibit. Public-facing copy should emphasize inheritance,
     family wealth preservation, generational sovereignty in the
     sense of "not dependent on a custodian for 50 years."
   - Never publicly acknowledge or joke about specific illegal use
     cases. Every tweet, podcast, and DM is discoverable.
   - Remove any mention of "evasion," "anonymity for prohibited
     purposes," "regulatory arbitrage," etc. Frame privacy as a
     human right for law-abiding families who want to not be
     advertised to or robbed.

6. **Engage with regulators early (compliant path only).**
   - Submit a FinCEN request for administrative guidance on whether
     the hosted product qualifies as an MSB given the non-custodial
     posture. Answer is likely "no" but filed paperwork documents
     good faith.
   - Join Coin Center and the Blockchain Association. They file
     amicus briefs in relevant cases.
   - If a state regulator asks, answer promptly. Silence on an
     inquiry becomes contempt.

7. **Retain crypto-specific counsel before you need them.**
   - Jake Chervinsky, Peter Van Valkenburgh (Coin Center), Miller &
     Chevalier, Steptoe, Anderson Kill have worked Bitcoin and DeFi
     defense cases. Budget $10-30k/year for ongoing advisory plus a
     war chest for a defense if needed. A retainer now is cheaper
     than an emergency later.
   - Have counsel review the sovereign binary release before it
     ships, specifically the disclaimers, the lack of support
     channel, and the release signing process.

8. **Compliant-path controls.**
   - On the hosted service, block known-sanctioned BTC addresses
     from being targets of spends. Screen via Chainalysis Oracle
     or similar. Imperfect but it's a documented good-faith effort.
   - Keep server-side logs minimal but not zero. Zero logs looks
     like consciousness of guilt; minimal logs (IP address, user
     ID, action) look like a normal SaaS.
   - Standard terms of service: no use for illegal activity, right
     to suspend accounts, jurisdiction clause pointing to the
     Delaware incorp.

9. **No fee capture on the sovereign path.**
   - On the hosted path, charging subscription fees is fine.
   - On the sovereign path, if you take a fee cut of the trustee
     commons network, the 1960 argument gets much stronger against
     you. Don't. Let the network run, let trustees earn fees, let
     the open protocol propagate. Fund the project via the hosted
     business or donations.

10. **Document everything.**
    - Every design decision around non-custody, every security
      review, every counsel consultation, every regulator
      communication. If it becomes evidence, you want a paper
      trail of good faith.

### Residual risk

Even perfect posture does not immunize you. The US government has
charged developers of non-custodial tools before (Tornado Cash,
Samourai) and will again. The bet is that the structural defenses
(no custody, no upgrade keys, open source, separate entities,
foreign jurisdiction) plus the legal precedent being slowly built
in the crypto-developer-rights direction (Van Loon, amicus briefs
in Storm, etc.) make you an expensive and unattractive target.

The best single piece of advice: **if the sovereign path is what
matters to you, build it in a way where you personally are not
operationally necessary for it to keep running.** Release the code,
pin the binary on IPFS, document the protocol, and let the network
live without you. Your inability to take it down is your defense.

---

## Disclaimer

This document is engineering speculation and a summary of
publicly-reported cases. It is not legal advice. It does not create
an attorney-client relationship. Do not act on it without consulting
a qualified attorney in your jurisdiction.

The author of this file is an AI assistant, not a lawyer. The human
operator should treat every statement here as a starting point for
professional legal review, not a conclusion.
