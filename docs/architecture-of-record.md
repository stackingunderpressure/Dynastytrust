# Architecture of Record -- DynastyTrust as a Trust Operating System

Status: adopted 2026-07-19 (operator-set north star). This doc governs
direction. Where an older "rebuild the wallet" assumption conflicts with it,
this doc wins.

**2026-08-12 amendment (operator-set, supersedes section 2's custody split
below):** Section 2's "custody and signing is DELEGATED to Nunchuk, Sparrow,
Coldcard -- we do not compete here" is no longer the primary path. Enough
in-house signing now exists -- browser signing (`lib/psbt-signer.ts`), Tapit
cosigning, and SeedSigner integration with full tapleaf coverage across every
vault type -- that every spending path DynastyTrust offers is meant to go
through our own compiler and be signable end-to-end without leaving the app,
SeedSigner included as the primary hardware path. Descriptor and PSBT export
to third-party wallets (Sparrow, Nunchuk, Coldcard, etc.) still exists and
still matters, but only as the sovereignty exit hatch section 3's "descriptor
+ PSBT" seam was always meant to guarantee -- what a user reaches for if
DynastyTrust itself becomes unreachable, not a parallel or primary way to use
a live vault. The live app UI no longer names specific third-party wallets;
that detail now lives in the Learn curriculum (`lib/literacy.ts` rung 7) and
the downloadable recovery bundle (`lib/descriptor-backup.ts`), both of which
are written to stand alone if this app is gone. Section 3's descriptor/PSBT
seam, section 5's custody-independent audit trail, and section 6's Sage
doctrine are unaffected by this amendment -- only section 2's framing of
where signing should happen by default, and section 4's "dial" language
treating in-app and external signing as equally weighted defaults, are
superseded.

---

## 1. Why this exists / the north star

DynastyTrust is not a wallet and does not try to out-wallet anyone. It is a
**grounded teacher, a vault-designer, and a trust operating system** that sits
on top of the user's own battle-tested Bitcoin wallet. The original intent,
restated plainly by the operator: fill the gaps in Bitcoin **education** and
**long-term inheritance**, and help ordinary people stop being scared of
self-custody -- "once you get used to it, it's like riding a bike." The seed
idea was that a real US-legal trust (settlor, trustee, beneficiary, protector,
distributions) can be expressed on Bitcoin with consensus instead of a
courthouse. That is the thing we build. Everything else we borrow.

## 2. The core separation -- custody is delegated, governance is retained

There are two different jobs hiding inside "a Bitcoin vault." Keep them apart:

- **Custody and signing (DELEGATED).** Holding keys, producing a signature,
  driving a hardware device. Nunchuk, Sparrow, and Coldcard already do this
  better than we need to. We do not compete here. We give open credit and hand
  off.
- **Coordination and governance (RETAINED -- this is the wedge).** Designing
  the trust from a conversation, teaching it, the trustee portal, a beneficiary
  requesting a distribution (e.g. an education payout), trustee approval, the
  drip/distribution schedule, protector intervention, and the tamper-evident,
  Bitcoin-anchored audit trail. No competitor combines this.

**The load-bearing fact:** the governance layer never touches a private key. It
does not hold keys today (keys live in the browser only, per CLAUDE.md), so
moving a key out to a hardware wallet changes almost nothing about governance --
it only changes where a signature is produced. This is why delegating custody
does not cost us the wedge.

## 3. The seam -- descriptor + PSBT

The two layers connect through two open standards designed for exactly this
split:

- **Descriptor** -- says what the vault *is*. We already compile it (Miniscript
  -> Taproot `tr_multileaf`) and already export it in Nunchuk/Sparrow key-origin
  form. The user imports it into their wallet as watch-only or as a signer.
- **PSBT** -- a partially-signed transaction passed to a signer and returned. We
  build the unsigned PSBT in the governance layer; the signature is applied in
  the user's wallet; the signed PSBT returns to us for the audit trail and
  broadcast.

Canonical governed-spend flow (no office visit, no shared secret in transit):

1. Beneficiary requests a distribution in the portal, authenticated, from their
   phone.
2. Trustee sees it in their dashboard, mapped to the trust-doc clause it
   invokes.
3. The app builds the **unsigned PSBT** and hands it to the trustee's wallet.
4. Trustee signs in Nunchuk/Sparrow/Coldcard with their own (possibly hardware)
   key.
5. The signed PSBT returns to the app, which records it in the audit trail and
   broadcasts it.

Security lives in the signatures, not in the transport -- so the exchange is
safe over any channel. That is the concrete improvement over both "everyone flies
to the lawyer's office with keys" and "coordinate a million dollars over a group
text."

## 4. The signing spectrum -- a dial, not a bridge we burn

We already built browser signing (`lib/psbt-signer.ts`). Keep it. Offer both:

- **Sign-here (browser):** one-app convenience, for testnet, rehearsal, smaller
  amounts, and users who value simplicity.
- **Export-to-hardware:** cold-key security for the large, long-horizon vault.

The governance layer sits **identically** on top of both. Which one a user takes
is their choice, not a bridge we force. The PSBT-to-hardware round trip is a
couple more taps -- the same friction Nunchuk's own collaborative custody has,
and the honest price of cold-key security. We minimize it with good UX (QR /
secure link / notification); we never pretend it away.

## 5. The audit trail and attestations are custody-independent

The tamper-evident record is built from **attestations** -- Schnorr signatures
over the hash of the trust doc and each event, anchorable into Bitcoin via
OpenTimestamps (see literacy.ts rung 8, `lib/attest.ts`, tapit-attest). These do
not depend on which wallet holds the coins. Change one comma in the trust doc and
every signature breaks and the screen still shows "0 of 5 agreed," no matter that
the signing happened in Nunchuk. **An attestation is never a Bitcoin spend
signature** (different, domain-separated preimage by design; it can never be
replayed as a sighash). The audit trail survives the custody handoff intact --
this is why we can delegate custody without losing the protective machinery.

## 6. Sage -- grounded-or-abstain (architecture of record for the bot)

The AI teacher is the front door, and its discipline is the deepest form of the
wedge: in Bitcoin, the price of a confident wrong answer is someone's
inheritance, so Sage must be **constitutionally incapable of making things up.**

Provenance: this pattern is already proven by the operator on two other apps --
a Missouri-DOT engineering assistant that advises only from the actual DOT
manuals and cites only sources it walked through, and a highway-patrol narrative
checker that catches errors against vetted crash data and abstains rather than
inventing, tested heavily and passing clean. That is the architecture of record
for Sage:

- **Ground every claim** in the vetted corpus: the rung curriculum
  (`literacy.ts`), the repo docs, and the actual BIPs.
- **Cite the source** each claim came from.
- **Abstain** when a question leaves the grounded ground: "I'd rather not guess;
  let's verify that together." Never free-associate Bitcoin facts.

Progress (2026-07-19): Sage's deeper rung layers (`whyItWorks` + `theCrypto`)
are now folded into her context verbatim and strictly gated (surfaced only on an
explicit go-deeper), and `scripts/test-rung-digest.mjs` binds every deep string
to `literacy.ts` char-for-char so the digest cannot silently drift. Next cut: the
hard grounded-or-abstain + cite-the-source rail.

## 7. The wedge, and what we deliberately do NOT build

Build (the wedge, where craft goes):
- The grounded, cite-or-abstain AI teacher.
- Descriptor-from-conversation (tell it your family situation; it designs the
  vault and tells you exactly what to import into your wallet).
- The trust operating system: trustee portal, payout requests, distributions,
  protector paths, role-aware dashboards, and the Bitcoin-anchored audit trail
  an attorney could review.

Do NOT build (commodity / a dime tomorrow -- borrow and credit):
- The wallet core, hardware signing UX, sync, fee-bumping. Delegate to
  Nunchuk / Sparrow / Coldcard; consider embedding BDK (MIT/Apache) if in-app
  wallet features are ever genuinely needed. Threshold-Schnorr (FROST /
  Frostsnap) is the frontier for the signing side -- interoperate, don't rebuild.
- Give open credit. Liana, Nunchuk, and BDK were the inspiration and are the
  shoulders this stands on.

## 8. What this closes (the delegated "holes")

The old open gaps that were really *wallet* gaps are closed by delegation, not by
grinding: finished hardware-signing flow, multi-member co-signing coordination,
and mainnet-spend credibility all become the wallet's job. We stop owning those
problems. What remains ours is the governance/education layer -- which is exactly
where we want the remaining work to be.

## 9. Open work / next cuts (in wedge order)

1. Sage: grounded-or-abstain + cite-the-source rail (the proven pattern).
2. The governed-spend PSBT hand-off made explicit end to end: request -> approve
   -> unsigned PSBT -> external sign -> return -> audit -> broadcast, with the
   audit trail spanning the handoff.
3. Trust-operationalization surface: role-aware dashboards, trust-doc templates,
   scenario playbooks, event-to-action guides, attorney-format audit export.
4. In-app credit + "recommended companion wallet" guidance (what to import into
   Nunchuk/Sparrow and how).

## 10. Incoming repos -- evaluate for reuse vs custom

The operator will bring in additional repos. For each, decide deliberately:
reuse what is genuinely the smartest piece of the puzzle (and credit it), or
build custom only where we hold the wedge. Do not import commodity we would only
be maintaining; do not rebuild what an existing piece already does well. Same
discipline as the wallet decision above.

---

Give credit where credit is due. Use the smartest pieces of the puzzle. Spend the
craft only on the parts that are genuinely ours: teaching Bitcoin until it feels
like riding a bike, and operationalizing long-term inheritance so a family can
actually run it.
