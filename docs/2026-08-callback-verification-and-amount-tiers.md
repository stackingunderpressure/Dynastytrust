# Amount-tiered red alerts + out-of-band callback verification

Status: captured design idea (operator, 2026-08). Two refinements produced in
the same conversation that derived `docs/architecture-of-record.md`,
`docs/threat-model-and-fail-closed.md`, and
`docs/green-gated-frost-and-liveness.md`, but not yet written down anywhere
until now. Composes with the existing green-gated liveness model rather than
replacing it. Phase 2+ design; Cut B (`docs/integration-phase1-signin-and-bridge.md`
B1) is the first stage that consumes it in code. Cross-references
`docs/build-map-and-cut-lists.md` section 5 (cut list) and section 6 (risk
register), and `docs/green-gated-frost-and-liveness.md`.

## The operator's idea, in one line

My brother gets a spend request from me over Nostr into Tapit. It's over
$10,000, so it's a red alert -- he calls me on speed dial, the way he always
does, and says "it's not about work, it's about your red request, are you
good?" I say yes, I'm buying my daughter a car, thanks for watching for me.
He green-lights it. Nobody in my quorum knows or cares what the transaction
actually is -- they only ever agree to my predetermined contract with each of
them: is the requester alive, well, and acting as themselves, not "should this
spend happen." That's not a gate on whether to spend. It's a gate on whether
I've been compromised.

## Two refinements

### 1. Amount-tiered red-alert threshold

Not every spend deserves the same ceremony. A vault owner sets a threshold
amount (per vault, editable, defaulting to something conservative) that splits
spending into two tiers:

- **Below the threshold**: the existing attested-trail check (risk register,
  section 6, "no rogue signing") is sufficient on its own. The signer proceeds
  once the request ties to a matching attestation trail it already holds and
  has verified -- no extra ceremony, no friction for routine spends.
- **At or above the threshold**: the requester's own wallet must additionally
  pass the out-of-band verification below (refinement 2) before it releases its
  signature. This is a gate on the REQUESTER's own device, not a permission a
  remote party grants -- the requester is proving to their own wallet, and
  through it to their quorum, that the identity making the request is really
  them, before their key ever signs.

The threshold is a coordination-layer setting, the same honest category as the
green liveness gate in `green-gated-frost-and-liveness.md`: Bitcoin script does
not know about dollar amounts or thresholds, and never will. What enforces the
spend amount on-chain is the PSBT's actual output value, which the signer
already confirms via tap-to-confirm (risk register: "the banner shows the
meaning, not the hex"). The tier is what decides whether that confirm step is
preceded by the callback ritual or not.

### 2. Predetermined, out-of-band, message-immutable verification

The ritual, precisely:

- **Predetermined** -- the contact channel (a phone number, a specific speed-dial
  entry) is established once, at setup time, by the two humans, never supplied
  inside the spend request itself. A request that *claims* "call me at this
  number" is worthless as verification -- an attacker who has stolen the
  requester's Nostr identity key can put any number they like in the message.
  The channel has to already live in the verifier's own head or phone, outside
  anything the protocol carries.
- **Out-of-band** -- a real phone call (or any channel independent of the Nostr
  transport the spend request arrived on), not a reply inside the same app or
  thread. If the requester's identity key is compromised, the same compromise
  cannot also compromise a separately-established phone number.
- **Message-immutable** -- the callback is not "read back the PSBT and confirm
  it looks right." It is closer to a PIN or passphrase check: a memorized word
  or phrase, kept off the device that could itself be compromised, optionally
  with a distinct duress variant (a different word that means "I am being
  forced to say this, everything looks fine on the surface, but I am not
  actually OK"). The verifier isn't reviewing the transaction -- nobody in the
  quorum ever needs to know what the transaction is. They are verifying the
  PERSON.

This is a second, independent authentication factor that sits ALONGSIDE the
existing attested-trail check from the risk register -- it does not replace it.
Both must hold: the request must trace to attestations the wallet already
accepted (no rogue signing), AND, above the amount threshold, the requester
must pass the live callback check.

## What this closes, and what it does not

- **Closes**: remote credential theft of the requester's identity key. An
  attacker who has stolen or forged the requester's signing key still cannot
  produce a live phone call answered with the correct predetermined word,
  because that word was never transmitted over any channel the stolen key
  could have exposed.
- **Does NOT close**: physical coercion of the requester themselves. If an
  attacker has the actual person, not just their key, the person can be forced
  to answer the phone and even (absent a duress variant) forced to speak the
  correct word. This is exactly why the duress-variant PIN matters, and exactly
  why this refinement composes with, rather than substitutes for,
  `green-gated-frost-and-liveness.md`'s peer-attested liveness gate -- a
  duress-tagged callback and a red liveness signal are two independent signals
  of the same underlying fact (this human is not acting freely), and either one
  alone should be enough to abort the ceremony (risk register: "an in-flight
  ceremony must be abortable").

## How this fits Cut B

`docs/integration-phase1-signin-and-bridge.md`'s B1 (the new Tapit `sign-psbt`
intent) is where this becomes code, not just design. The plain-English
amount/destination/fee banner B1 already calls "the single most safety-critical
new UI in the whole plan" is exactly where the amount-tier check belongs: read
the vault's threshold, compare against the PSBT's real output value (never a
value asserted by the request), and when the tier requires it, block
`approveRequest`'s call to `wallet.signDigest` behind a UI step that requires
the operator to confirm the out-of-band callback happened -- a plain
acknowledgment ("I verified this by phone"), not something the wallet can
verify cryptographically, because the whole point is that the verification
happens on a channel the wallet cannot see. Vault owner configuration (setting
the threshold amount, and the predetermined channel/word -- which the wallet
never transmits, only records that the human has one) is Settings-surface work
that can land independently of B1's signing-path change.
