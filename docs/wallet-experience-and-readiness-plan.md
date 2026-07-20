# Wallet experience + readiness plan (reasoned in Bitcoin standards)

Status: plan, 2026-07-20. Grounded in the actual repo (compiler, browser signer,
PSBT functions, attestations, legal/audit) and in current wallet support. This
is the execution + readiness map before real-world signet tests.

## 0. Thesis (the decision already adopted)

We do not build a wallet. Custody and signing are delegated; the trust operating
system and the grounded education are retained (docs/architecture-of-record.md).
Two sharpenings from this session: (a) delegate to the open **standards**
(descriptor + PSBT), not to any one vendor, so we stay wallet-agnostic and route
around any single wallet's roadmap gaps (e.g. Nunchuk's Taproot-hardware
timeline); (b) keep in-app browser signing as the frictionless **on-ramp /
rehearsal / small-amount** tier, with export-to-hardware as the serious tier --
a dial, not a burned bridge.

---

## 1. The wallet experience, stage by stage

Each stage names the Bitcoin standard it rests on and its current status.

### Stage 1 -- Design the vault (produce a descriptor)
- **What:** Sage / the builder turn a family situation into a vault shape, and
  the Rust compiler produces a Taproot multi-leaf descriptor with a NUMS
  internal key (script-path only), each spending path its own tapleaf.
- **Standards:** BIP 341/342 (Taproot/Tapscript), BIP 386 (`tr()` descriptors),
  BIP 379 (Miniscript), BIP 65 (`after(N)` = OP_CHECKLOCKTIMEVERIFY, absolute
  height), BIP 350 (bech32m addresses). Key material as BIP 32 xpubs with
  key-origin `[fp/path]xpub/0/*`.
- **Status:** BUILT. `compile_dynasty_policy_tr_multileaf` round-trips the
  descriptor through rust-miniscript so a malformed tree fails at compile, not
  at spend. `wsh` (P2WSH) is also compilable (`compile_dynasty_policy`).

### Stage 2 -- Choose the signer and register the policy
- **What:** The user picks the wallet they'll actually sign with, and registers
  the vault's descriptor/policy on that device so it will recognize and sign it.
- **Standards:** BIP 380-386 (descriptors), BIP 129 (BSMS, the secure multisig
  setup exchange), BIP 388 (Ledger wallet policies), device-native miniscript
  registration (Coldcard imports the descriptor / miniscript config).
- **Status:** PARTIAL. We export the descriptor + a Sparrow import QR + BSMS,
  but there is no guided, per-device "register your vault on your Coldcard /
  Ledger" step yet. See section 4.

### Stage 3 -- Fund and watch
- **What:** Import the descriptor as a watch-only wallet; receive to vault
  addresses; see balance.
- **Standards:** descriptors (BIP 380+), bech32m (BIP 350). Balances/UTXOs/fees
  from mempool.space.
- **Status:** BUILT. Descriptor + animated QR export; live balances.

### Stage 4 -- Propose a spend, build the PSBT
- **What:** Choose destination/amount/path; the server fetches UTXOs, does coin
  selection + fee estimation, and the Fly compiler builds a binary PSBT with the
  `tap_leaf_script` attached (so a device can verify the leaf) and `nLockTime`
  set to match the chosen leaf's `after(N)`.
- **Standards:** BIP 174 (PSBT), BIP 371 (Taproot PSBT fields --
  `PSBT_IN_TAP_LEAF_SCRIPT` 0x15, `PSBT_IN_TAP_SCRIPT_SIG` 0x14,
  `PSBT_IN_TAP_INTERNAL_KEY` 0x17), BIP 65 (nLockTime must equal the leaf height
  for a CLTV-gated path).
- **Status:** BUILT (`netlify/functions/psbt-binary.js` + Fly `/psbt-binary`).

### Stage 5 -- Sign (two tiers)
- **Browser tier (on-ramp):** derive the `/0/0` child key from the mnemonic,
  compute the BIP 341 tapscript sighash, Schnorr-sign (BIP 340), attach a
  `PSBT_IN_TAP_SCRIPT_SIG`.
- **Hardware tier (serious):** export the PSBT as an animated UR `crypto-psbt`
  QR (BCR-2020-005/006 -- Coldcard Q, Jade, Passport, Foundation read it) or as
  a PSBT file / USB; sign on the device; read the signed PSBT back via the UR
  scanner or paste.
- **Standards:** BIP 340/341/342 (sign), BIP 174/371 (PSBT), BCR-2020 UR
  (`crypto-psbt`).
- **Status:** BUILT but the browser signer is **hand-rolled and Taproot-only**.
  See section 2 -- this is the piece to harden.

### Stage 6 -- Collect and merge signatures
- **What:** Gather partial signatures from the quorum; merge into one PSBT;
  count signatures against quorum.
- **Standards:** BIP 174 (Combiner role).
- **Status:** BUILT (`mergePsbts`, `countSignatures`).

### Stage 7 -- Finalize and broadcast
- **What:** rust-miniscript satisfies the script and produces the final witness;
  broadcast the raw tx.
- **Standards:** BIP 174 (Finalizer), miniscript satisfaction, BIP 341 witness.
- **Status:** BUILT (`/psbt-finalize` on Fly; broadcast from browser to
  mempool.space).

### Stage 8 -- Record and prove
- **What:** Every consequential action is written to the vault event log; an
  attorney-format audit PDF can be exported; trust-doc and lifecycle facts can
  be cryptographically attested, and (target) Bitcoin-anchored.
- **Standards:** BIP 340 Schnorr (attestations, domain-separated so never a
  spend sighash), OpenTimestamps (Bitcoin anchoring).
- **Status:** Event log + attorney PDF + Schnorr attestations BUILT; Bitcoin
  anchoring DESIGNED + MOCKED only. See section 5.

---

## 2. Browser signing compatible with all vaults (concrete change)

**Current:** `apps/web/src/lib/psbt-signer.ts` is a hand-rolled PSBT parser +
BIP 341 tapscript sighash + BIP 340 Schnorr signer. Because it iterates every
tapleaf and signs whichever holds the key, it already signs every path of every
Taproot vault we ship (founders-now, recovery, inheritance, protector, the
consent-gated path) and the Bloc/tranche shapes. It cannot sign `wsh` (P2WSH),
and it is hand-maintained money-critical crypto -- the one thing the delegation
thesis says to stop owning.

**Plan:** replace the hand-rolled parser + sighash + serializer with
**`@scure/btc-signer`** -- the audited signing library from the same author as
`@noble/curves`, `@scure/bip32`, `@scure/bip39`, which are ALREADY dependencies.
It provides Taproot script-path AND P2WSH signing behind one reviewed API.

- **Why it satisfies "compatible with all vaults":** it signs both Taproot
  miniscript and P2WSH miniscript, so any shape the compiler can emit becomes
  browser-signable.
- **Why it fits the thesis:** we stop hand-rolling sighash math on money code
  and lean on the vetted primitive -- delegation applied to the one bit of
  wallet we keep.
- **Scope guard:** the browser's job stays "parse + sighash + sign + serialize";
  **finalization stays server-side in rust-miniscript** (`/psbt-finalize`),
  which already works, so we don't take on miniscript satisfaction in JS.
- **Verification:** a signet round-trip test per path (founders / recovery /
  inheritance / protector / consent / wsh): build -> sign in-lib -> finalize via
  rust-miniscript -> assert a valid witness. This becomes a permanent gate.

---

## 3. The DynastyTrust -> wallet -> signed -> back flow

```
DynastyTrust (governance)                 Signer (custody)              Bitcoin
-------------------------                 ----------------              -------
1. Build vault -> descriptor  --export--> register policy on device
   (tr_multileaf, BIP386)     (BSMS/388)  (Coldcard/Ledger/Sparrow)
2. Import descriptor as watch-only <------ device verifies addresses
3. Propose spend -> binary PSBT           (tap_leaf_script + nLockTime)
   (BIP174/371/65)
4a. Browser tier: sign in-app  ----------- (BIP340/341, @scure/btc-signer)
4b. Hardware tier: UR crypto-psbt QR out  -> device signs -> UR QR / paste back
    (BCR-2020)
5. Merge partial sigs (quorum, BIP174 combiner)
6. Finalize (rust-miniscript, BIP174 finalizer)  -----------------> broadcast
7. Record event + (target) anchor attestation                      (mempool.space)
```

Security lives in the signatures, not the transport, so steps 1, 4b, and the
return leg are safe over any channel (QR, file, link). Everything except the
Stage-2 guided registration step already exists in the repo.

---

## 4. Registering the signer -- help, hurt, or N/A?

**Verdict: it HELPS, and for the hardware tier it is effectively REQUIRED. Not
applicable to the browser tier.**

- A Coldcard or Ledger will not sign a spend from a miniscript/multisig script it
  has not been shown first. You register the wallet policy once -- Coldcard
  imports the descriptor / a BSMS file (BIP 129); Ledger registers a wallet
  policy and returns an HMAC (BIP 388) -- and thereafter the device can verify
  that receive/change addresses belong to your vault and will refuse to
  blind-sign a script it does not recognize. That is a security feature (it
  defeats a malicious change-address swap), not friction for its own sake.
- Because DynastyTrust vaults are Taproot **miniscript**, registration uses the
  device's descriptor / miniscript-wallet import (and BSMS for the multisig
  exchange), not plain legacy multisig registration.
- **Browser tier:** N/A -- the app already holds the descriptor and keys.
- **Plan item:** add a guided Stage-2 "register your vault on your device" step
  that hands the correct artifact per device (descriptor / BSMS / wallet policy)
  and tells the user what the device should display to confirm.

---

## 5. Readiness verdicts (the three status questions)

### 5a. Education content -- COLLECTED + DRIFT-TESTED, two honest asterisks
- The 10-rung curriculum (`literacy.ts`) is complete; Sage's digest + the new
  grounding/citation rail mirror it verbatim; `test-rung-digest.mjs` (in
  `npm test`) binds them char-for-char so it cannot silently drift.
- Asterisk 1: the plain-language **jargon-guard** test (`test-literacy.mjs`) is
  NOT wired into `npm test`, so a surface-layer regression wouldn't be caught.
  Fix: add it to the test chain.
- Asterisk 2: two of ten rungs cite Tapit-repo sources not present in this repo
  (`tapit attack-list.md`, the Tapit literacy spec) -- intentional cross-repo
  anchors, but not locally verifiable. Fix: vendor those two sources in (or
  repoint the citations to in-repo docs) so every rung's provenance is checkable
  here.

### 5b. Legal documents + audit trail -- UP TO PAR, one gap
- ToS v1.0 (dual-hosted byte-identical, 12 sections, Delaware/arbitration,
  non-custodial + no-legal/tax-advice) and the legal-framework guide are
  complete; acceptance is recorded as a `terms_accepted` event with version +
  timestamp, and a build gate asserts `save()` records the ToS version. All 11
  templates carry real (not placeholder) trust docs. The audit PDF is a genuine
  attorney-format document (trust doc, roster, proposals+sigs, requests,
  stipends, attestations, chronological event log), plus a tax-summary PDF and
  an activity JSON export, all UI-wired.
- Gap: a plain **trust-doc edit** (`PATCH /api/vaults`) writes NO event, so a
  material amendment can leave no timeline entry unless the owner separately
  attests the new hash. Fix: one-line `trust_doc_updated` event insert in the
  PATCH branch. Minor: CLAUDE.md's schema block calls the events column `data`;
  it's actually `metadata`.

### 5c. Attestations returning the block + validating later -- HALF DONE
- Schnorr attestation: DONE. Four kinds (trust_doc, proof_of_life,
  death_declaration, descriptor) signed BIP 340 over a domain-separated
  `SHA256("DT-ATT-v1"...)` digest (provably never a spend sighash), with a
  create/verify UI and client-side signature verification.
- Bitcoin anchoring (return a block height, verify later): NOT in the product.
  OpenTimestamps lives only in the `tapit-attest` library against a **mock**
  provider; the real `OpenTimestampsProvider` is written but its npm package
  isn't installed, it's marked UNVERIFIED, the app's `vault_attestations` table
  has no anchor/proof/height column, and nothing calls the anchor/verify path.
- To make it real (its own slice): install the `opentimestamps` dep; add
  `ots_proof`, `calendar`, `bitcoin_height` columns to `vault_attestations`;
  wire `anchorAttestation` on create and `verifyAnchor` on read; surface "pending
  -> anchored at block N" in TrustTab and the audit PDF; verify end-to-end
  against a real calendar server and a testnet/mainnet block (upgrade takes
  hours-to-a-day as the calendar aggregates into a block).

---

## 6. Real-world test plan (signet first)

Run the whole spectrum on signet before mainnet, using the short-timelock
`[TEST]` templates so recovery/inheritance/protector unlock in hours:

1. Compile each shape (family-inheritance, generational-trust with
   protector+consent, lost-device, social-recovery) as `tr_multileaf`.
2. Register the descriptor on a real device (start Sparrow, then Coldcard) and
   confirm the device shows and accepts the policy.
3. Fund from the signet faucet; confirm the watch-only balance matches.
4. Propose a founders-now spend; sign BOTH ways (browser via the new
   `@scure/btc-signer` path, and hardware via UR QR); merge; finalize;
   broadcast; verify on the explorer.
5. Exercise each timelocked path: wait past `recovery_after`, spend the recovery
   leaf; wait past `inheritance_after`, spend with heir keys alone; exercise the
   protector leaf; confirm the consent gate freezes Path 1 when a beneficiary
   won't cosign.
6. Export the audit PDF; confirm every step above appears in the event log.
7. Once anchoring is wired: stamp a trust-doc attestation, upgrade it against a
   signet/mainnet block, and verify the returned height later.

A green run of 1-6 is the bar for "the wallet experience works end to end";
7 is the bar for "provable over time."

---

## 7. Sequencing (each a shippable, gate-green slice)

1. **Harden browser signing** -- swap to `@scure/btc-signer`, add the signet
   round-trip signing gate (satisfies "compatible with all vaults").
2. **Guided signer registration** -- Stage-2 per-device policy registration with
   the right artifact (descriptor / BSMS / wallet policy).
3. **Close the audit gap** -- `trust_doc_updated` event on PATCH; fix the
   CLAUDE.md `data`/`metadata` note.
4. **Firm up education vetting** -- wire `test-literacy.mjs` into `npm test`;
   vendor or repoint the two cross-repo citations.
5. **Bitcoin-anchored attestations** -- install OTS, add anchor columns, wire
   anchor-on-create + verify-on-read, surface in UI + audit PDF, verify against
   a real block.
6. **Real-world signet tests** -- run section 6 end to end.

Slices 1-4 are small and independent; 5 is the one genuinely new subsystem; 6 is
the payoff. None require rebuilding a wallet -- they harden the seam and close
honest gaps.

---

## 8. Progress

**2026-07-20 -- Slice 1 (harden browser signing) landed, minus the signet run.**

- Added `@scure/btc-signer` (v2.2.0), the audited signer from the same author as
  the `@noble`/`@scure` packages already in use.
- Rewrote `apps/web/src/lib/psbt-signer.ts` so the public `signPsbtWithMnemonic`,
  `mergePsbts`, and `countSignatures` prefer btc-signer (Taproot script-path AND
  P2WSH -> compatible with every vault shape), and fall back to the proven
  hand-rolled Taproot signer only when the library declines a PSBT, so today's
  working path can never regress. Both paths are fail-closed (zero signatures
  throws). Finalization stays server-side in rust-miniscript.
- New executable gate `scripts/test-psbt-signer.mjs` (wired into `npm test`)
  proves, without a live network, that btc-signer signs + finalizes + extracts a
  valid tx for: Taproot single pk() leaf, a multi-leaf tree (signs the correct
  leaf, rejects a non-signer), P2WSH miniscript, and a full quorum round-trip
  (fromPSBT -> sign x2 -> PSBTCombine -> 2 sigs -> finalize) that mirrors exactly
  what the app's sign+merge does. Plus a BIP340-over-BIP341 sighash cross-check.
- Gates: build pass, lint pass (7 pre-existing warnings), npm test pass,
  typecheck unchanged (14 pre-existing, none in psbt-signer).
- REMAINING for slice 1 (needs the live environment): one signet round-trip
  proving a PSBT built by our Rust compiler finalizes through rust-miniscript
  after btc-signer signs it -- the one interop boundary a sandbox can't exercise.
  Until that passes, the legacy fallback stays and mainnet gets caution. This is
  step 4 of the section 6 test matrix.
