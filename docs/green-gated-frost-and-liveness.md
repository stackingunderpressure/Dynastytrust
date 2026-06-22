# Green-gated FROST participation + peer-attested liveness

Status: captured design idea (operator, 2026-06-22). Composes three pieces the
build map already plans -- Layer 3 FROST signing, Layer 4 proof-of-life /
green-red liveness, and the no-rogue-signing rail (risk register) -- into one
model. Phase 2+ work; not built yet. Cross-references
`docs/build-map-and-cut-lists.md` (Layers 3-4 + risk register) and
`docs/layered-vault-legs-and-frost.md`.

## The operator's idea, in one line

You log into DynastyTrust with Tapit; Tapit itself is gated by your peers
agreeing you are in a calm state (green); you cannot contribute your FROST share
in DynastyTrust unless you are green in Tapit; and unless a proper threshold of
green FROST participants actually contribute, that Taproot leaf does not spend.

## How it composes

- **Login** is the sign-in-by-attestation cut (built): prove key control to
  DynastyTrust by signing a fresh challenge with your Tapit key.
- **Green / calm state** is a Layer-4 liveness attestation: your peers attest
  that you are alive, reachable, and uncoerced (not red / not under a duress or
  withdraw signal). It is fresh (time-boxed) and peer-cosigned.
- **FROST participation gate**: your wallet refuses to release your FROST
  signing-round share unless it holds a current green liveness attestation. A
  red / duress signal aborts the in-flight ceremony (the abortable-ceremony rail
  from the risk register), with fresh nonces always.
- **Threshold**: the FROST aggregate signature for the social leaf only forms
  when the required number of green participants contribute. Short of threshold,
  no `pk(AGG)` signature exists, so the leaf cannot be spent.

## The honest line -- what Bitcoin enforces vs what wallets coordinate

This is the on-chain/off-chain wall and it must stay honest. Bitcoin script does
NOT understand "green." What the Taproot leaf actually enforces is the FROST
threshold (a valid aggregate signature must exist) and, on the backstop leaf,
the absolute-CLTV timelock. The green gate is a COORDINATION rail: it is enforced
by honest wallets refusing to sign when not green and by the duress-abort, not by
consensus. A coerced or malicious share-holder's wallet could in principle ignore
the green rule. Therefore:

- The green gate hardens the fast/social path and defends the honest signer
  against duress and absence -- it is real, valuable safety.
- It is NOT a consensus guarantee. The guarantee underneath remains: enough
  honest shares are needed to reach threshold, and if the social path stalls or
  is compromised, the absolute-CLTV timelock leaf is the backstop that needs
  nobody. Coercing one person (turning them red, or removing them) should push
  recovery onto the timelock, not hand an attacker a fast spend.
- This is the same wall the education bot teaches: an attestation (green,
  sign-in) expresses intent/state and never moves a coin; only a tapscript
  signature -- here the FROST aggregate, or the timelocked leaf -- moves a coin.

## Why it is good for sovereignty

It means no single person can be squeezed into moving the family's Bitcoin on the
fast path: the spend needs a threshold of people who are each verified calm and
uncoerced, and if that cannot be assembled honestly, the money waits for the
timelock rather than flowing under duress. Duress defense and liveness become
first-class, not an afterthought.

## Open design questions (to mature before building)

1. Who vouches "green/calm" -- a separate liveness/guardian cohort distinct from
   the FROST signers (separation of duties), the FROST cohort itself, or a mix?
2. Freshness -- is a standing green status enough, or must green be re-attested
   by peers at signing time (per-ceremony), so a stale green cannot be replayed?
3. What exactly flips you red -- self-triggered duress/withdraw, peer-raised
   concern, a missed proof-of-life heartbeat, or any of these?
4. How does the green attestation tie to the no-rogue-signing trail -- presumably
   the same attested-trail check: the wallet only counts green vouchers from
   peers it already holds verified attestations for.
