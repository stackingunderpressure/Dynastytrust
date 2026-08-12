# Elder guardian review: notify vs. gate for a vulnerable adult's own vault

Status: captured design idea (operator, 2026-08-12). Not yet built. Composes
with the existing protector-leaf concept already documented in
`apps/web/src/lib/vault-templates.ts`'s template playbooks and
`apps/web/src/lib/literacy.ts` rung 6, with `NotifyCircleViaNostr` and the
circle-phrase delivery system already shipped this session, and with
`docs/2026-08-callback-verification-and-amount-tiers.md`'s amount-tiered
threshold mechanism, which this idea can reuse directly rather than invent a
second version of. Cross-references `docs/architecture-of-record.md` section
2 (custody stays with the vault owner; DynastyTrust coordinates, never signs).

## The operator's idea, in one line

Today, being "on an elderly parent's bank account" usually means the adult
child becomes a co-signer or the sole signer, and the parent's own agency is
just gone. If that parent held Bitcoin instead, the operator doesn't want the
same trade: dad keeps his own key and can still spend for himself, but there's
an easy Nostr check back to the adult child, so a scam ("sign all the money
away to someone") gets a chance to be caught -- "is dad really spending it for
something good, does that transaction look right" -- without adding real
custody friction to ordinary life.

## Two shapes, two different guarantees

These read as the same feature from the outside ("a check-in happens") but
have very different security properties, and the design has to pick one on
purpose rather than let the UI imply the stronger one while only building the
weaker one.

- **Notify-only.** Dad's own key builds and broadcasts the transaction alone,
  no other signature required. A description of the pending or just-sent
  transaction lands in the adult child's Tapit inbox over Nostr, the same
  shape `NotifyCircleViaNostr` and the circle-phrase delivery system already
  send today -- this half is close to free to build. Gives visibility and a
  pattern-of-behavior record (useful for catching a second or third fraudulent
  transaction, for a difficult conversation afterward, for peace of mind) but
  **no power to stop the first one** if dad has sole signing authority and
  already broadcast before the child sees the alert.
- **Threshold-gated.** Everyday spending under some amount (or to a
  destination dad has paid before) stays exactly as frictionless as
  notify-only. Above the threshold, or to a new/unrecognized destination, the
  leaf that's actually spendable requires either a short mandatory wait the
  child can act within, or the child's own cosignature alongside dad's --
  real teeth, not just an alert. This is not new cryptography: it is the
  existing protector-leaf pattern ("a neutral party who can rescue the funds
  after a wait if things go wrong, but who has no everyday power") retargeted
  at a new real-world trigger -- an unusual or large spend, chosen by dad
  himself while he was thinking clearly -- instead of the recovery-after-
  silence framing it has today. Composes directly with the amount-tiered
  threshold already designed in `2026-08-callback-verification-and-amount-
  tiers.md`: same "below X, no ceremony; at or above X, an extra check"
  shape, just the extra check here is a family member reviewing the
  destination and amount, not a phone-call identity check.

## What this closes, and what it does not

- **Closes (threshold-gated version only)**: a scam that tries to move a
  large sum, or move money to a destination that's never been paid before,
  while it's still in progress -- the family gets a real chance to intervene
  before the funds are gone, not just a record after the fact.
- **Does NOT close (notify-only version)**: nothing, by itself, for the first
  large fraudulent transaction, if dad's key alone is sufficient to broadcast.
  It closes the SECOND one, if the family reacts to the pattern in time.
  Worth being honest about this in the product itself -- a "we'll let you
  know" feature that reads to a family as "we'll stop it" is a dangerous gap
  between promise and guarantee, exactly the kind of confused-deputy problem
  this whole platform exists to avoid elsewhere (see the hardware-wallet
  `tap_key_origins` story: strict verification over convenience, on purpose).
- **Does NOT close, in either version**: coercion of dad himself into
  approving a legitimate-looking, guardian-reviewed spend -- a scammer
  patient enough to coach him through what to say to his own family defeats a
  review step the same way it defeats a bank's "are you sure" dialog. This is
  the same class of gap `2026-08-callback-verification-and-amount-tiers.md`
  names for its own callback ritual and solves with a duress-variant
  passphrase; an elder-guardian template would want the same escape hatch,
  not a fresh one.

## The autonomy-preserving design principle (the actual differentiator)

The value of building this at all, instead of pointing an elderly parent at
existing elder-fraud tooling (EverSafe, True Link, or a bank's own "trusted
contact" designation), is that none of those preserve the elder's own agency
-- they all resolve to someone else holding more control, which is also the
classic failure mode that sometimes enables the abuse instead of preventing
it (a "helpful" family member who becomes the sole controller). A vault where
dad keeps his own key, spends freely for everyday life, and only pulls in a
reviewing circle above a line he set for himself is a genuinely different
shape than anything a bank offers today, and it is squarely inside this
platform's actual thesis -- not a departure from it.

## How this would fit the existing architecture

No new signing primitive is needed. This is a new vault TEMPLATE (same move
as the "Gift Locker" idea in the SeedSigner roadmap turning out to be a
template on the existing `tr_multileaf` compiler rather than a new miniscript
engine), built from parts that already exist:

- The protector-leaf pattern, retargeted with an amount/destination trigger
  instead of a silence-timeout trigger.
- `NotifyCircleViaNostr` / the Tapit inbox, for the notify-only half, which
  should ship regardless of whether the threshold-gated half ever gets built
  -- it is real, honest, low-cost value on its own as long as it is labeled
  as an alert, not a gate.
- The amount-tiered threshold mechanism from
  `2026-08-callback-verification-and-amount-tiers.md`, reused rather than
  redesigned.
- A duress/coercion escape hatch, matching that same doc's callback ritual,
  if the threshold-gated version is ever built for real.

Not scheduled. Parked here so it doesn't evaporate, per the same discipline
this session already applied to `2026-08-callback-verification-and-amount-
tiers.md`.
