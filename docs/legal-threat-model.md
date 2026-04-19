# Legal threat model for the builder

Status: summary of publicly-reported cases and regulatory posture.
NOT LEGAL ADVICE. Talk to a crypto-specific attorney before acting
on any of it.

This doc is for the operator of DynastyTrust -- the person shipping
the cloud service, releasing the sovereign binary, and doing the
public-facing work. It is US-centric because US enforcement is the
most aggressive; similar analysis applies in other FATF
jurisdictions.

---

## Statutes in play

- **18 USC 1960 -- unlicensed money transmission.** The primary
  charge against Tornado Cash developers. Applies if a court reads
  the operation as a "money transmitting business." Mitigating
  facts for DynastyTrust: no custody, private keys stay with users,
  descriptors and signatures are produced client-side. Aggravating
  facts: a hosted server exists, the service may accept payment,
  the system coordinates trustee fees (if the trustee commons
  feature ships).
- **18 USC 1956 / 1957 -- money laundering.** Requires knowledge
  that funds derive from specified unlawful activity. Conspiracy
  charges under 1956(h) are the federal prosecutor's go-to when a
  1960 case is marginal.
- **IEEPA / OFAC sanctions violations.** Triggered if the service
  is used by a sanctioned entity (North Korea, Russia, Iran) and
  blocking controls are absent. Tornado Cash had this on top of
  1960.
- **FinCEN MSB registration.** Administrative first, criminal on
  continued violation. Non-custodial software's status is murky.
- **State money transmitter licenses.** 49 separate regimes. New
  York's BitLicense is the aggressive one; many states are
  permissive or silent.

---

## Recent case law (2022-2025)

- **Alexey Pertsev (Tornado Cash).** Convicted in the Netherlands
  2024. 5y4m for money laundering. "Code is speech" defense
  failed; court focused on active development and fee capture.
- **Roman Storm (Tornado Cash).** Charged SDNY 2023. Trial
  ongoing. Charges: conspiracy to launder, conspiracy to operate
  unlicensed money transmitter, conspiracy to violate IEEPA.
  Defense: no custody, no upgrade keys, pure open source.
- **OFAC sanctions on TC contracts.** 2022. Partially rolled back
  after Van Loon v Treasury (5th Cir 2024) held that immutable
  smart contracts are not "property" OFAC can sanction. Narrow
  ruling; doesn't immunize developers themselves.
- **Roman Semenov.** Individually sanctioned 2022. Living in
  Russia.
- **Samourai Wallet.** Founders arrested 2024 (US and Portugal).
  More custodial posture and more aggressive marketing than
  Tornado. Conviction looks likely.

---

## Defense posture -- concrete, prioritized

Listed in rough priority. Most are independent and can be done in
parallel.

### 1. Ship open source, release a spec, let others operate

The trustee commons network (and ideally the sovereign binary) runs
on commodity Nostr / Tor infrastructure that anybody can host. You
publish reference code and a protocol specification. If DOJ wants a
target, they are chasing a permissionless network, not you.

This is exactly what Bitcoin Core developers have relied on for
16 years. The legal theory is the same: the developer wrote code,
the users run it, the network operates without the developer. No
single person is "the operator."

### 2. Split the entities

- **Hosted compliant path.** `dynastytrust.family` as a Delaware
  C-corp or equivalent. Operates the onboarding-first product.
  Partner firms for KYC on legal-wrapper customers. FinCEN MSB
  registration filed if counsel recommends -- arguable either way
  given no custody, but paperwork is a good-faith signal. This
  entity does NOT ship the sovereign binary.

- **Sovereign path.** Released from a separate entity. Options in
  increasing order of protection:
  1. Anonymous pseudonym releases to GitHub + IPFS
  2. Foreign foundation (Swiss Stiftung, Swiss Verein, Cayman
     foundation, Panama)
  3. DAO-structured release process with a multi-sig maintainer
     key where no single person has unilateral release power

The two entities share no officers, no bank accounts, and
ideally no office space. Structural separation is not a
bulletproof defense but it is the starting point.

### 3. No custody, ever -- prove it in code

Already true. Make it unmistakable in docs, audit reports, and
terms of service. "We cannot move your coins under any
circumstance" is the single most valuable technical claim you can
put before a jury.

### 4. Geographic hygiene

- Don't live in the US if avoidable. At minimum, don't conduct
  primary development from US soil. Candidates: Portugal (NHR has
  cooled but still tolerable), UAE (Dubai VARA registration),
  Switzerland (Crypto Valley), El Salvador (bitcoin-legal, no
  capital gains), Panama.
- If you must be in the US: do not officer-serve in any entity
  that operates the sovereign path. Use an LLC with a non-US
  member for the sovereign release; pay yourself only for work on
  the compliant hosted path.
- Minimize travel to adversarial jurisdictions. The Samourai
  founders were arrested during travel to Portugal after US
  charges.

### 5. Public-facing copy discipline

- The "sovereign FU mode for anarchists" framing plays great with
  friends but is a federal prosecutor's dream exhibit. Public
  copy should emphasize inheritance, family wealth preservation,
  generational sovereignty in the sense of "not dependent on a
  custodian for 50 years."
- Never publicly acknowledge or joke about specific illegal use
  cases. Every tweet, podcast, DM is discoverable.
- Remove "evasion," "anonymity for prohibited purposes,"
  "regulatory arbitrage." Frame privacy as a human right for
  law-abiding families who do not want to be advertised to or
  robbed.

### 6. Engage with regulators (compliant path only)

- File a FinCEN request for administrative guidance on whether
  the hosted product qualifies as an MSB given the non-custodial
  posture. Answer is likely "no" but filed paperwork documents
  good faith.
- Join Coin Center and the Blockchain Association. They file
  amicus briefs in relevant cases.
- If a state regulator asks, answer promptly. Silence on an
  inquiry becomes contempt.

### 7. Retain crypto-specific counsel before you need them

- Peter Van Valkenburgh (Coin Center), Jake Chervinsky, Miller &
  Chevalier, Steptoe, Anderson Kill have worked Bitcoin and DeFi
  defense cases. Budget $10-30k/year for ongoing advisory plus a
  war chest for a defense if needed. A retainer now is much
  cheaper than an emergency retainer later.
- Have counsel review the sovereign binary release before it
  ships: disclaimers, absence of support channel, release signing
  process.

### 8. Compliant-path controls

- Block known-sanctioned BTC addresses from being targets of
  spends on the hosted service. Screen via Chainalysis Oracle or
  similar. Imperfect but documented good faith.
- Keep server-side logs minimal but not zero. Zero logs looks
  like consciousness of guilt; minimal logs look like a normal
  SaaS.
- Standard terms of service: no illegal use, right to suspend,
  jurisdiction clause pointing to the Delaware incorporation.

### 9. No fee capture on the sovereign path

On the hosted path, charging subscription fees is fine. On the
sovereign path, if you take a fee cut of the trustee commons
network, the 1960 argument gets much stronger against you. Don't.
Let the network run, let trustees earn fees, let the open protocol
propagate. Fund the project via the hosted business or donations.

### 10. Document everything

Every design decision around non-custody, every security review,
every counsel consultation, every regulator communication. If it
becomes evidence, you want a paper trail of good faith.

---

## Residual risk

Even perfect posture does not immunize you. The US government has
charged developers of non-custodial tools before (Tornado Cash,
Samourai) and will again. The bet is:

1. Structural defenses (no custody, no upgrade keys, open source,
   separate entities, foreign jurisdiction) make the case hard to
   win.
2. Legal precedent is slowly moving in the developer-rights
   direction (Van Loon, amicus activity in Storm).
3. You make yourself an expensive and unattractive target.

The single most important piece of advice: **if the sovereign path
is what matters to you, build it so you personally are not
operationally necessary for it to keep running.** Release the code,
pin the binary on IPFS, document the protocol, and let the network
live without you. Your inability to take it down is your defense.

---

## Disclaimer

Engineering speculation and a summary of publicly-reported cases.
Not legal advice. No attorney-client relationship is created by
reading this file. The author is an AI assistant, not a lawyer.
The human operator should treat every statement as a starting
point for professional legal review, not a conclusion.
