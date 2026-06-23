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

## Maturation 2026-06-22 -- the green-weighted decaying-timelock ladder

The operator refined the model into a ladder, which is a generalization of the
already-shipped Dynasty Bloc decaying-multisig vault with peer liveness as the
participation axis. The shape:

- **Immediate family are the green signalers, configured as an m-of-n.** Each
  family member who is set up is one of the n. Green and participation are
  unified per person: a member who is green is contributing; a member who
  withdraws green (or goes silent) is not counted toward that leaf's threshold.
- **Three states, not two.** Green (positive, fresh report), red (a flag / duress
  -- a HARD stop), and no-report (silence / unreachable -- simply does not count,
  but is not itself an abort). Example: 5 of 8 reporting green, zero reds, three
  no-reports. Whether 5 clears a given leaf depends on that leaf's m.
- **A ladder of leaves trading green-count against time.** The first leaf needs
  the most green participants and can spend soonest (short or no timelock). Each
  later leaf needs fewer green participants but carries a longer absolute-CLTV
  timelock. If the calm-and-uncoerced cohort you can assemble now does not clear
  the top leaf, recovery decays gracefully down the ladder: fewer people, but a
  longer wait. This is exactly the Bloc decaying-multisig pattern, now keyed to
  liveness.
- **One signer can hold more than one secret.** A signer can hold additional
  shares that map to later (longer-timelock, fewer-signer) leaves, so the ability
  to recover concentrates over time onto fewer holders -- the deliberate
  inheritance/recovery decay.
- **The ceremony coordinates in the background.** The green polling, the
  three-state tally per leaf, and the FROST rounds run quietly; the human only
  sees the meaning and the tap.

### Honest lines for the ladder (do not bend)

- The chain still only enforces, per leaf, the signature threshold (FROST
  aggregate or k-of-n keys) and the absolute-CLTV timelock. Green/red/no-report
  is off-chain: it decides WHICH leaf the honest cohort completes and WHEN, by
  honest wallets refusing to contribute unless green and aborting on red. The
  chain never sees "green."
- Security degrades down the ladder BY DESIGN: later leaves need fewer signers,
  so they trust fewer people. The green gate only really bites while a leaf needs
  multiple honest wallets; the final fewest-signer leaf can be spent by its
  holder(s) after its timelock regardless of green. Therefore the late leaves
  MUST carry long timelocks (long enough that duress cannot cheaply wait them
  out) and their shareholders are the ultimate trust anchor -- choose them as
  carefully as the inheritance leaf.
- Reds must abort the in-flight ceremony with fresh nonces, never just lower a
  count for next time (the abortable-ceremony rail).
- Green vouchers count only from family/peers the wallet holds verified
  attestations for (the no-rogue-signing trail). A green report from an
  unattested source is ignored, never silently trusted.
