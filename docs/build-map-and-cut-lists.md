# Build Map & Cut Lists -- DynastyTrust x Tapit Wallet x tapit-attest

Status: synthesis + build plan. Rolls the whole 2026-06-15 design conversation
into one map of the system across all three repos, plus an ordered, dependency-
aware cut list per repo. Companion to `docs/sovereignty-education-bot.md` (the
education-bot vision + sections 11-11e where each idea is grounded in code) and
to the Tapit brief `2026-06-15-dynastytrust-tapit-integration-cut-list.md` (the
Tapit-side cut lists, mirrored into that repo).

Every status tag is grounded in actual source read this session:
**EXISTS** (shipped today), **EXTEND** (a small change to existing code),
**NEW** (does not exist; standard to build), **FRONTIER** (advanced, least
battle-tested; needs a vetted construction and the most caution).

The spine rule the operator set and this plan obeys: **small quorums + small
amounts on the primitives that already exist first; climb to FROST, then
resharing, then Lightning witness payments only as trust and value grow.**

---

## 1. The map of everything

Read bottom-up: each layer rests on the one below. The three repos occupy
different layers, and the integration is mostly *wiring layers that already
exist* rather than inventing new ones.

### Layer 0 -- Curve & envelope substrate (tapit-attest)
The shared cryptographic floor under both apps. BIP340 Schnorr over secp256k1
via `@noble/curves`; the attestation envelope (six kinds, three tiers); the
two-step tagged-hash digest; OpenTimestamps anchoring (proof-of-when); NIP-44 /
NIP-17 encryption; the nonce-bearing recovery request/response. **EXISTS.** The
key shape is identical to a Bitcoin Taproot key, so the same key signs
attestations and (separately) PSBTs -- but an attestation digest is domain-
separated and can never be replayed as a BIP341 sighash.

### Layer 1 -- On-chain enforcement (DynastyTrust)
Taproot `tr_multileaf`; absolute CLTV (`after(N)`) timelock leaves; Miniscript
`thresh`; the `and(thresh, thresh)` consent gate (the "two legs tied together"
primitive); NUMS internal key; browser-first PSBT build / Schnorr sign /
finalize / broadcast; the stateless governance engine. **EXISTS.** This is the
only layer Bitcoin actually enforces; everything above it is coordination.

### Layer 2 -- Coordination & transport
How participants find each other and exchange envelopes/PSBTs.
- Tapit Nostr transport: encrypted inbox (NIP-44 envelopes on kind 9573, NIP-17
  gift-wrapped chat on 1059), auto-reconnect, dedupe, silent-absorb signature
  merge, the sign-request approval screen, cosigning. **EXISTS (Tapit).**
- DynastyTrust coordination: Supabase Realtime activity feed. **EXISTS (Dynasty).**
- The bridge: DynastyTrust vault ceremonies riding Tapit's encrypted Nostr inbox
  (the reserved NIP-46 app-to-wallet seam). **NEW.**

### Layer 3 -- Threshold signing (the social leg)
- FROST-Secp256k1 (RFC 9591) DKG + signing -- a large social quorum collapses to
  one on-chain `pk(AGG)`. **NEW** (operator-locked direction in the Tapit FROST
  roadmap; vendored Rust-via-WASM into tapit-attest).
- FROST resharing / proactive secret sharing -- rotate members + threshold while
  the aggregate key (and therefore the descriptor and address) stays fixed for
  the life of the vault. **FRONTIER.**

### Layer 4 -- Identity, login & liveness
- Sign-in by attestation (prove key control by signing a fresh challenge; keep
  the signed sign-in attestation in the wallet; OpenTimestamps for proof-of-when).
  **NEW (small)** -- reuses the Layer 0 recovery-nonce pattern.
- Proof-of-life / green-red liveness as attestations; duress/withdraw signal that
  aborts an in-flight ceremony. **NEW.**

### Layer 5 -- Incentive rail (paying witnesses)
- Bake payouts into the rescue transaction outputs (self-enforcing, but on-chain
  bloat + dust limits). **NEW (small).**
- Lightning preimage payment off-chain; the atomic "signing reveals the payment
  secret" via adaptor signatures + PTLCs; on-chain HTLC/PTLC settlement as the
  backstop. **FRONTIER.**
- Trustee Commons: bonded, fee-earning, reputation-tracked rescuers -- the
  standing market version. **NEW.**

### Layer 6 -- The education bot ("super AI login helper, no control")
The curriculum (rungs 0-9), two speeds (Express / Rabbit Hole), the self-graded
confidence ladder, the no-authority + tap-to-confirm + never-touch-secrets rails,
the banner-shows-meaning rule, grounded Q&A. **NEW.** Rides the existing
chat-wizard-mediator spec.

### The two walls that cut across every layer (the bot's core teaching)
1. **On-chain vs off-chain enforcement.** Bitcoin script (Layer 1) enforces;
   attestations, social quorums, Nostr coordination, and app state (Layers 0,2,4)
   coordinate. An attestation expresses intent; only a tapscript signature moves a
   coin.
2. **Convenience fast path vs guaranteed timelock backstop.** The social/FROST
   leg and the Lightning rail are fast paths that depend on people and liquidity;
   the absolute-CLTV timelock leaf is the guarantee underneath that needs nobody.

---

## 2. Cross-repo sequencing spine

Each phase is shippable and is proven with small real amounts before the next.

- **Phase 0 -- Ground (mostly EXISTS).** The operator's everyday multisig (two
  hardware keys + one software key, founders-now leaf) plus ONE moderate
  timelocked peer-recovery leaf `and(after(N), thresh(Q, peers))`, small amounts.
  Uses today's primitives end to end.
- **Phase 1 -- Bot + bridge + login.** Education-bot slice 1 (curriculum + dial);
  DynastyTrust cosigning over Tapit's encrypted Nostr inbox; sign-in by
  attestation. Layers 2,4,6.
- **Phase 2 -- FROST signing.** FROST-Secp256k1 in tapit-attest; the social leg
  becomes one on-chain `pk(AGG)`; DKG ceremony surfaces in the inbox. Layer 3.
- **Phase 3 -- FROST resharing.** Rotate membership behind a fixed descriptor.
  Layer 3 frontier.
- **Phase 4 -- Paid witnesses.** Start with payouts baked into the rescue tx /
  plain Lightning invoices; climb to adaptor-signature + PTLC atomic witness
  payments; optional Trustee Commons market. Layer 5.

---

## 3. Cut list -- tapit-attest (the substrate; lives vendored in both repos)

- **TA-1 -- Sign-in challenge attestation builder.** EXTEND. A `challenge` /
  `sign-in` helper reusing the existing recovery-nonce pattern (random nonce,
  Schnorr-sign a tagged digest, verify echo + sig). Deps: Layer 0. Files:
  `src/core/recovery.ts` pattern -> a `signIn`/`challenge` builder + verify.
- **TA-2 -- FROST-Secp256k1 (RFC 9591) DKG + signing.** NEW. Vendor a vetted
  Rust-via-WASM FROST build; expose DKG round messages + signing-round shares as
  typed objects that can ride the envelope/inbox. Deps: Layer 0. The single
  biggest new primitive; gates the whole social-leg story.
- **TA-3 -- FROST resharing / proactive secret sharing.** FRONTIER. Re-deal shares
  to a new roster/threshold preserving the aggregate pubkey. Deps: TA-2. Use a
  vetted construction; this is the fixed-descriptor-rotating-membership engine.
- **TA-4 -- Adaptor signatures + PTLC point primitives.** FRONTIER. Schnorr
  adaptor sign/verify/extract so completing a signature reveals a secret scalar;
  PTLC point math. Deps: Layer 0. Gates atomic Lightning witness payment.
- **TA-5 -- (carry-through) anchoring already EXISTS** -- proof-of-when for any
  sign-in or liveness attestation needs no new work beyond TA-1 calling it.

## 4. Cut list -- tapit-wallet (the sovereign identity + transport + UX)

- **TW-1 -- Education content module + ExplainChip + dial.** NEW. `literacy.ts`-
  style content (rungs 0-9, consequence/why/crypto layers, jargon-guard test) and
  the `ExplainChip`/`WhyThis` inline explainer, mounted at the highest-value
  decision points; the Express/Rabbit-Hole dial. Deps: none. (This is the Tapit
  half of the education thesis; the Dynasty bot consumes the same curriculum.)
- **TW-2 -- DynastyTrust as a sign-request requester over Nostr (NIP-46 seam).**
  EXTEND. The reserved app-to-wallet sign transport so an external app (Dynasty)
  shoots a sign-request/PSBT to the wallet over the existing encrypted inbox and
  collects the signed envelope back; the approval screen already renders the
  plain-English banner. Deps: transport (EXISTS), sign-request (EXISTS). Files:
  `src/features/sign-request/*`, `src/features/transport/*`.
- **TW-3 -- FROST ceremony UX (DKG + signing in the inbox).** NEW. Surface DKG
  rounds and signing-round taps as inbox envelopes (the operator-locked pattern);
  OTS-block-anchored deadlines; abortable session on a duress/withdraw signal.
  Deps: TA-2, transport. Files: `src/features/transport/*`, a new `frost` feature.
- **TW-4 -- FROST resharing UX.** FRONTIER. The rotate-a-member ceremony surfaced
  as taps; reflect "membership changed, address unchanged" plainly. Deps: TA-3, TW-3.
- **TW-5 -- Lightning preimage release on signing.** FRONTIER. On a verified
  witness signature, release the bearer secret that pays them (invoice first;
  adaptor/PTLC atomic later). Deps: TA-4 (for the atomic form). Aligns with the
  parked `2026-06-04-sovereign-conditional-release-inheritance-roadmap.md`.
- **TW-6 -- Sign-in attestation in the wallet + queryable history.** EXTEND. Keep
  each signed sign-in attestation; let the user show when they signed in. Deps: TA-1.

## 5. Cut list -- DynastyTrust (the vault + governance + the bot's home)

- **DT-1 -- Social-recovery vault template + the peer leg.** EXTEND. A new
  `VAULT_TEMPLATES` entry: founders-now multisig + `and(after(N), thresh(Q,
  peers))`, with the explicit peers-alone vs peers-assist-his-key choice surfaced.
  The `and(thresh, thresh)` consent gate already compiles two legs; this reuses
  it. Deps: Layer 1 (EXISTS). Files: `apps/web/src/pages/PolicyBuilder.tsx`,
  `protocol/src/policy_compiler.rs` (already supports the shape).
- **DT-2 -- The education bot (assistant) -- slice 1.** NEW. Server-side
  `netlify/functions/assistant.js` (JWT-auth'd, SAFE context only -- never keys),
  the `ChatWizard` panel, `assistant_threads`/`assistant_messages` tables; consumes
  the TW-1 curriculum; every consequential value tap-to-confirm; commits through
  the existing compile + save path only. Deps: chat-wizard-mediator spec. The
  "super AI login helper, no control."
- **DT-3 -- Timelock-refresh ("deadman") UX.** NEW (small). Teach + nudge the
  absolute-CLTV refresh: while active, periodically re-anchor to a fresh further-
  out timelock; if silent, the social leg unlocks. Correct the "resets when I
  touch it" misconception in the bot. Deps: Layer 1. Files: PolicyBuilder /
  Reminders / the bot.
- **DT-4 -- Coordination bridge to Tapit (Nostr) for multi-member signing.**
  EXTEND/NEW. Let a DynastyTrust proposal be signed via TW-2 (Tapit inbox) in
  addition to the current Supabase-Realtime flow; this is the Layer-2 bridge.
  Deps: TW-2. Ties into the existing "multi-member vault flow" open gap. The
  B1 signing UI (`docs/integration-phase1-signin-and-bridge.md`) also gates
  high-value spends behind the amount-tiered red alert + out-of-band callback
  ritual captured in `docs/2026-08-callback-verification-and-amount-tiers.md`.
- **DT-5 -- FROST aggregate key as a leaf participant.** EXTEND. Accept a FROST
  `pk(AGG)` in a leaf slot (social leg, or one trustee seat inside a `thresh`);
  the compiler already treats it as a single pubkey, so the work is plumbing the
  aggregate key in and routing signing to the FROST ceremony. Deps: TA-2, TW-3.
- **DT-6 -- Paid-witness payouts in the rescue tx.** NEW (small). Optionally add
  per-signer outputs to the rescue PSBT (self-enforcing; respect dust + fee).
  Deps: Layer 1. Climbs to TW-5 Lightning later.
- **DT-7 -- Governance.rs cleanup (DONE this session).** The stale CSV/UTXO-age
  terminology was corrected to absolute chain-tip height across the engine, its
  JS mirror, and the request structs. No further action; noted for completeness.

---

## 6. Risk register -- the honest lines the bot must hold

- **An attestation is not a spend signature.** Domain-separated digest; never a
  BIP341 sighash. Off-chain agreement never moves a coin on its own.
- **Timelocks are absolute, not self-resetting.** The deadman is built by
  refresh/re-anchor, not an on-chain countdown.
- **Big social quorums belong off-chain (FROST), not in the raw script.** A
  100-key on-chain `thresh` is impractical; collapse it to `pk(AGG)`.
- **FROST resharing and PTLC/adaptor payments are frontier.** Real and known, but
  least battle-tested; vetted constructions only, never hand-rolled.
- **The fast path can stall; the timelock is the guarantee.** Social leg and
  Lightning depend on people + liquidity; the absolute-CLTV leaf needs nobody.
- **An in-flight ceremony must be abortable.** A duress/withdraw signal cancels
  the current FROST/PSBT session, not just future ones, with fresh nonces always.
- **The banner shows the meaning, not the hex.** Hiding cryptography is good;
  hiding what you are agreeing to turns tap-to-confirm into a blind tap.
- **No control.** The bot proposes; the human disposes; no key ever enters its
  context; no value commits without a human tap.
- **Pay with value, not control.** A Lightning preimage moves money; a key share
  moves spending authority -- never substitute one for the other.
- **No rogue signing -- every signature ties to a matching attested trail.** Tapit
  is never a blind signing oracle. Before it signs anything an external app hands
  it, the wallet must verify the request connects to an attestation trail it
  already holds and has verified: a spend (PSBT cosign) is REFUSED unless the
  wallet holds a verified attested trail for that exact vault / membership /
  agreement -- the key, the co-signers, and the policy must trace to attestations
  the wallet already accepted, not to claims inside the incoming request. For
  identity/sign-in the wallet surfaces attested-vs-unknown plainly so a first-time
  login is a conscious choice, never a blind tap, and an unknown counterparty is
  flagged, never silently trusted. The human tap is the last gate, not the only
  gate; the wallet does its own verification first. (Operator directive,
  2026-06-22: "Tapit shouldn't sign if not a matching attested trail. No rogue
  signing anything.")
- **A high-value request needs a live human check, not just a valid signature.**
  Above a vault's configured amount threshold, a matching attested trail is
  necessary but not sufficient -- the requester's own wallet also gates its
  signature on a predetermined, out-of-band callback (never a channel supplied
  inside the request itself), matching a memorized word rather than reviewing
  the transaction, since no quorum member needs to know what the spend is. See
  `docs/2026-08-callback-verification-and-amount-tiers.md`. This closes remote
  key theft; it does not close physical coercion of the requester, which is why
  it composes with the green liveness gate (`docs/green-gated-frost-and-liveness.md`),
  not instead of it.

---

## 7. What is already built vs what this plan adds (one glance)

EXISTS today: the on-chain vault primitive (multileaf, absolute CLTV, consent-gate
two-leg, browser PSBT signing, governance engine) in DynastyTrust; the attestation
substrate + OpenTimestamps + NIP-44/17 + recovery-nonce in tapit-attest; the
encrypted Nostr transport + silent-absorb inbox + sign-request approval screen +
cosigning in tapit-wallet. NEW/FRONTIER this plan adds, in order: the education bot
and curriculum, the Dynasty-over-Nostr signing bridge, sign-in by attestation,
FROST signing, FROST resharing, paid witnesses (tx outputs then Lightning/PTLC).
The wedge is the integration and the education -- most of the cryptographic floor
is already poured.
