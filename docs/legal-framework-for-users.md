# Legal framework for DynastyTrust users

**Not legal or tax advice.** This is a plain-language map of where
DynastyTrust fits into US legal structures, what each role should
think about, and when to bring in a professional. Rules vary by
country and by US state. Treat this as a starting point, not a
conclusion.

---

## What DynastyTrust is, legally

DynastyTrust by itself is a **Bitcoin coordination tool**. A vault
is a Taproot multisig address with governance rules encoded in the
script. It is not a legal trust, not a legal entity, and not a
contract between the parties on its own.

It becomes different things depending on what you wrap around it:

| Wrapper                                    | Legal status                                                |
|--------------------------------------------|-------------------------------------------------------------|
| None (informal family use)                 | Joint custody of property; handshake among the parties      |
| Written family agreement                   | Contract under state law; enforceable if properly executed  |
| **Statutory trust instrument** (Wyoming DST, Delaware DAPT, Cayman STAR, Nevada, etc.) | **Legal trust.** Has a grantor, trustees, beneficiaries, and tax filing obligations |
| LLC or corporation holding the keys        | Business entity; vault is an asset of the company           |

**The Bitcoin script runs regardless.** Your keys, your coins. The
legal wrapper only affects how the law describes what is happening
and what reporting obligations attach. It does not change what the
Bitcoin network does.

---

## Two models for using it

### Model A: Informal family use (no legal wrapper)

You and your spouse or siblings set up a vault with shared rules.
There is no trust instrument. You are effectively joint holders of
Bitcoin under a cooperation agreement that only you honor.

**Where it works well.**
- Treasury you intend to spend down within a few years
- Small amounts (say, under the federal gift-tax annual exclusion
  per person per year, currently $19,000 for 2025)
- Family members with strong informal trust
- Purely defensive use: protecting coins from theft of a single
  device

**Where it starts to break down.**
- Large amounts where tax authorities need to see reporting
- Multigenerational wealth passing at the grantor's death
- Any situation where a beneficiary might need to compel
  distribution (no legal enforcement path)
- Any situation involving creditors, divorce, or probate
- Charitable distributions that need a deductible receipt

### Model B: Wrapped in a legal trust (recommended at scale)

You execute a real trust instrument in a suitable jurisdiction.
Wyoming, Nevada, Delaware, and a few offshore options (Cook
Islands, Cayman, Nevis) are common. The trust instrument names the
grantor, the trustees, the beneficiaries, and the distribution
rules. DynastyTrust enforces the Bitcoin mechanics; the trust
instrument is the legal document.

Cost: typically $500-5,000 for setup, $300-2,000/year for state
registered agent and annual filings. Much less than a traditional
bank-trustee fee.

**This is what we recommend for any vault holding more than a
year's worth of annual gift exclusion value per member.**

---

## Role-by-role legal map

Each role in a vault carries different legal considerations. The
roles are cryptographic (defined by which keys sign which leaf of
the Taproot script) but they map onto long-established trust-law
categories.

### Founder / Grantor / Settlor

**In plain terms:** the person funding the vault and setting the
rules.

**What you should think about.**
- **Gift tax.** Every time you move Bitcoin from your personal
  wallet into the vault and you do not retain full legal control
  over it, that may be a "completed gift" to the beneficiaries.
  The IRS annual exclusion ($19,000 per recipient for 2025) covers
  small transfers. Above that you file IRS Form 709 to report the
  gift. Big gifts count against your lifetime exclusion ($13.99M
  per person for 2025, set to drop substantially in 2026).
- **Grantor trust rules.** If you retain control, the IRS treats
  the trust's income as yours (you pay the taxes, not the trust).
  Sometimes this is intentional; sometimes it undoes the estate
  planning benefit. An attorney drafting the trust document
  decides this.
- **Estate inclusion.** If the trust is revocable or you retain
  certain powers, the Bitcoin stays in your estate for estate-tax
  purposes at your death. An irrevocable properly-structured
  trust removes it from your estate.
- **Fraudulent conveyance.** You cannot fund a trust to escape
  known creditors. State law typically has a 2-4 year lookback.
  Doing this can result in the trust being unwound.

**When to file.**
- Form 709 in years you make gifts above the annual exclusion
- Form 1040 Schedule B reporting any foreign accounts if using an
  offshore wrapper
- State-specific fraudulent-transfer exposure disclosures if
  required in your state

**When you cross the line.**
- Hiding known creditors from a funded trust: fraudulent
  conveyance
- Not reporting large gifts: gift tax evasion
- Using the trust to continue controlling assets you claimed to
  have given away: IRS may collapse the trust under substance-
  over-form doctrine

### Trustee

**In plain terms:** the person who can sign to move coins from the
vault. In DynastyTrust, "founders" (founders-now path) and anyone
in the recovery quorum are trustees for legal purposes.

**What you should think about.**
- **Fiduciary duty.** If this is a legal trust, you owe duties of
  loyalty, care, and impartiality to the beneficiaries under
  state law. Not optional. Violating can result in personal
  liability.
- **Compensation.** Trustees can be paid. State law or the trust
  instrument sets the standard. Compensation is ordinary income
  to you and must be reported on your 1040.
- **Recordkeeping.** Every transaction should have a memo, every
  distribution should match a trust-doc rule, and you should be
  able to explain any spend. The attorney-grade PDF export is
  your recordkeeping tool.
- **State registration.** Some states require trustees to
  register or file annual statements. Wyoming and Delaware, the
  friendly jurisdictions, generally do not.

**When to file.**
- Form 1041 (fiduciary income tax return) if the trust generates
  taxable income and is non-grantor
- Schedule K-1 to each beneficiary receiving distributions
- State fiduciary returns per the jurisdiction's rules
- Form 1099 if compensating third parties from trust funds

**When you cross the line.**
- Self-dealing: signing a spend that benefits you personally when
  you should be acting for beneficiaries
- Commingling: using the vault as your own spending account
- Ignoring the trust doc's rules when it suits you
- Failing to file 1041 on a non-grantor trust with reportable
  income

### Beneficiary

**In plain terms:** the person who receives distributions from the
vault. Can be a passive recipient or one whose consent is required
before spending (consent quorum).

**What you should think about.**
- **Income tax on distributions.** Depends on whether the trust is
  a grantor trust (grantor pays; you do not) or a non-grantor
  trust (you pay on distributed income, receive a K-1). Capital
  gains and income pass differently under the rules.
- **Basis.** Bitcoin distributed to you from a trust has a basis
  that depends on the trust type and the date of distribution.
  Your future capital-gains calculation starts from that basis.
  If you later sell what you received, you owe tax on the gain
  from that basis.
- **Foreign account reporting.** If the trust is foreign, you may
  need to file Form 3520 (transactions with foreign trusts) and
  possibly FBAR if the aggregate value crossed $10k at any point
  in the year.
- **Estate planning chain reaction.** Receiving large trust
  distributions can affect your own estate, creditor exposure,
  and means-testing for benefits.

**When to file.**
- Form 1040 including K-1 income from non-grantor trusts
- Schedule D for capital-gains reporting if you sell received BTC
- Form 3520 for foreign trust distributions
- FBAR / Form 8938 for foreign accounts if thresholds met

**When you cross the line.**
- Not reporting distributions as income
- Using distributions from a trust meant for specific purposes
  (education, healthcare) for other things, if the trust required
  verified use
- Representing yourself as a different beneficiary to get a
  distribution you weren't entitled to

### Protector

**In plain terms:** a third party (often outside the family) with
power to do limited things: remove a trustee, unlock an inheritance
path early, veto a spend.

**What you should think about.**
- **Limited fiduciary status.** Most jurisdictions treat a
  protector as a fiduciary only to a limited degree, which is
  why lawyers sometimes serve. Still, your actions can be
  reviewed by a court.
- **Compensation.** If paid, ordinary income. If uncompensated
  and you're doing a favor for family, no filing.
- **Conflicts.** Protector cannot also be the grantor or a
  beneficiary without undoing the trust's asset protection.

**When to file.**
- Form 1040 if you receive compensation
- 1099-MISC issued by the trustee to you if compensated

**When you cross the line.**
- Using protector powers to benefit yourself rather than to
  preserve the trust's purpose
- Accepting "off-book" payments from any party

### Successor / Heir

**In plain terms:** named in the inheritance path. Holds keys that
only work after the inheritance timelock elapses.

**What you should think about.**
- **No tax obligation until you receive distributions.** Holding
  an inactive key creates no tax event.
- **Step-up in basis at grantor death.** Under current US law,
  inherited property generally gets a basis reset to the
  fair-market value at the grantor's date of death. Bitcoin in a
  properly-structured trust usually benefits from this, but the
  trust structure matters. Confirm with a CPA.
- **Estate tax** on the grantor's side, not yours. You receive
  the net-of-estate-tax amount.
- **Reporting when you exercise the inheritance path.** Receiving
  Bitcoin from the vault after timelock elapse is a distribution
  for tax purposes. Same rules as any beneficiary distribution.

**When to file.**
- Nothing until you receive a distribution
- At receipt: the same rules as any beneficiary (Form 1040 with
  K-1 if non-grantor trust)

**When you cross the line.**
- Moving to claim distributions before the trust legally matures
  (e.g. forging a death certificate)
- Not reporting the received distribution

---

## International considerations

If any party is outside the US or the trust is formed outside the
US, additional rules apply:

- **FBAR (FinCEN Form 114).** US persons with signing authority
  over foreign financial accounts aggregating over $10,000 at any
  point in the year must file. Whether a non-custodial Bitcoin
  vault counts as a "foreign account" is unsettled; the
  conservative approach is to treat offshore-wrapped vaults as
  reportable.
- **FATCA (Form 8938).** Higher thresholds than FBAR but similar
  reporting posture.
- **Form 3520 / 3520-A.** Foreign trust reporting. Required for
  contributions to, and distributions from, non-US trusts.
- **Non-US grantors.** Different country's tax rules apply; almost
  always need local counsel.

If your wrapper is in the US (Wyoming, Delaware) and all parties
are US persons, none of this applies.

---

## When to bring in a professional

Pretty much always, above a certain threshold. Specifically:

- **Attorney** (trust and estates, crypto-literate) to draft the
  wrapper instrument. Budget $2-10k for a standard dynasty trust
  in a friendly US jurisdiction. More for offshore or novel
  structures.
- **CPA** (again, crypto-literate) for annual trust tax filings
  if the trust is non-grantor. Budget $500-3,000 per year per
  trust, depending on complexity.
- **Both** whenever you: fund a new vault with a taxable gift, add
  or remove a trustee, amend the trust doc in a material way,
  distribute significant value, or rotate the vault.

You can run a small family vault informally without either of
these. Once the value and the time horizon get serious, cheap
professional help is leverage.

---

## The minimum-compliance posture

If you want the least paperwork while staying safe:

1. **Keep individual transfers under the annual gift exclusion**
   ($19,000 per recipient per year as of 2025). No Form 709
   required. No taxable gifts.
2. **Don't touch estate tax brackets.** Under the current $13.99M
   lifetime exclusion, most families never trigger it. Beyond
   that, the wrapper becomes mandatory for planning reasons.
3. **Document every distribution.** Memo, recipient, rule
   citation. The governance engine plus the audit PDF handle
   this automatically if you use the app's workflow.
4. **File the 709 or 1041 when required.** Don't skip a year
   hoping it won't be noticed. Back-filing costs more than
   filing on time.
5. **Talk to a CPA at tax time** if the vault did anything during
   the year beyond holding. A 45-minute consult pays for itself.

---

## Disclaimer

This document is generated educational content, not legal or tax
advice. It does not create an attorney-client relationship. Tax
rules change annually and vary by state and country. The author
of this document is an AI assistant, not an attorney or CPA.
Before acting on any of this, consult a licensed professional in
your jurisdiction.
