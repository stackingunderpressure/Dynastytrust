# Phase 2 Integration -- The Vault Key Bridge

Status: C1 (manual half) and C2 shipped 2026-08-08. B3 slice 1 ("prove the
pipe" -- publish + receive a psbt-cosign request over Nostr, no signing yet)
also shipped 2026-08-08, ahead of this doc's original C1-C3 sequencing,
because the operator's own description of how they wanted the Tapit Circle
vault to actually work day-to-day named it directly: real friends on their
own phones, notified automatically, not sharing a browser tab with the
vault owner. See "What actually shipped" below for the concrete state.
Companion to `docs/integration-phase1-signin-and-bridge.md` (Cut A/B: sign-in,
and the PSBT signing bridge -- both shipped) and `docs/build-map-and-cut-lists.md`
(the cross-repo map). Written after reading the real code in both repos, not
from memory of the plan docs alone.

Operator request (2026-08-08): a new vault template gated by a close circle of
3-5 people who each hold their key in Tapit Wallet, all of whom must sign for
the base leaf (unanimous, enforced at Bitcoin consensus level -- not an app-side
gate), with an easier/different, larger group on the leg above it (single-sig or
multi, user's choice). Tapit hands DynastyTrust the public key; only the person
holding that Tapit wallet, unlocked with their own passphrase, can ever produce
a signature for it.

---

## Ground truth established this pass

- **Cut A (sign-in by attestation) and Cut B0-B2 (the PSBT signing bridge) are
  already shipped**, not just planned. DynastyTrust's `tapit-attest` copy
  already has `sign-in.ts` (contradicting Phase 1's "ground truth" section,
  written before Cut A landed). `lib/wallet-signin.ts`, `lib/tapit-cosign.ts`,
  and `pages/TapitCosignCallback.tsx` are real, working code: DynastyTrust can
  already open a new tab at Tapit's `/sign?req=...`, and Tapit can already sign
  a vault-spend PSBT and hand it back over a same-origin `storage` event into
  `VaultDetail`'s existing `externalImport` -> `mergePsbts` -> `/api/psbt-finalize`
  path. **The signing half of this feature already exists.**

- **The gap is entirely on the key side**, and it is real, not paperwork:
  `tapit-wallet/src/features/sign-request/vaultTrail.ts`'s own comment says
  issuance of the vault-membership attestation "is NOT built yet -- that is
  explicitly out of scope... until issuance ships, no wallet holds a matching
  trail for any real vault, so the honest, fail-closed behavior is: psbt-cosign
  is refused for every vault." Finishing this bridge does not just satisfy the
  operator's ask -- it turns on a signing path that is currently dead code on
  every real vault that exists today.

- **Tapit's identity key is not a BIP32/HD key.** `tapit-attest/src/core/wallet.ts`'s
  `Wallet` class holds one flat secp256k1/Schnorr `Keypair` (`{publicKey,
  privateKey}`, from `generateKeypair()`) plus a rotation/succession chain. No
  chain code, no derivation path, no xpub concept anywhere in `tapit-attest`.
  DynastyTrust's whole descriptor/compiler/hardware-wallet layer
  (`descriptor-keys.ts`'s `SelectedKey`, `buildKeyOrigins`, `upgradeDescriptor`)
  expects the opposite shape: `{pubkey, xpub, fingerprint, derivationPath}`, so
  Nunchuk/Sparrow/Coldcard can show `[fp/path]xpub/0/0`.

  **Decision (operator: "up to you"): do not fake a BIP32 xpub around Tapit's
  key.** A synthetic xpub with an invented chain code would misrepresent the
  key to any hardware wallet that later imports the descriptor -- exactly the
  kind of "confident wrong answer" this repo's doctrine forbids. DynastyTrust
  already builds every vault as a fixed, non-ranged single address (the
  Nunchuk-parity fix, 2026-08-06 -- "this vault is a single fixed address by
  design, not a rotating HD wallet"), so a bare pubkey is honestly all the
  compiler needs. A Tapit-sourced key is a **distinct key-import source**, not
  a disguised xpub -- it shows up everywhere in the UI as "Tapit," never as a
  generic hardware-wallet-shaped key with invented origin metadata.

- **Both `tapit-attest` copies support `agreement`-kind attestations**
  (`kinds.ts` / `builders.ts` in both), which is the kind `vaultTrail.ts`
  expects for `isVaultMembership`. But the two copies have **diverged**
  (Phase 1's own finding) and use different internal canonicalization helpers.
  Nothing here may assume byte-parity between them -- it must be proven, the
  same way B0 proved PSBT-signer parity and B3 proved Nostr-transport parity
  before either shipped.

- **Tapit has no screen that shows the user their own public key today.**
  `features/settings/SettingsScreen.tsx` uses `wallet.identity` internally
  (cohort/org lookups) but never displays it. `features/qr/QrShow.tsx` is a
  generic, already-built QR-render component (used elsewhere for envelope
  export) that a "your public key" panel would reuse, not duplicate.

- **DynastyTrust's existing generic key-import UI already has the right
  shape for a manual fallback.** `InlineKeyCreate` in `VaultWizard.tsx`
  already has Generate / Import tabs with paste, QR scan
  (`XpubQrScanner`), and file-drop, all funneling into `onImportXpub`. A
  Tapit pubkey pasted or scanned there today would currently be
  misinterpreted as an xpub and rejected -- the fallback path needs a real
  "this is a bare pubkey, not an xpub" branch, not just a UI label change.

---

## What actually shipped (2026-08-08)

- **C1, manual half** -- tapit-wallet: `features/settings/PublicKeySection.tsx`,
  a "Your public key" panel (copy + QR, no passphrase gate). Nothing
  deep-link yet.
- **C2** -- DynastyTrust: `keystore.ts`'s `importTapitPubkey()` (lifts the
  32-byte x-only key to the 33-byte compressed form via the standard even-Y
  convention, no invented xpub/fingerprint/derivationPath), `VaultWizard.tsx`'s
  "From Tapit" InlineKeyCreate tab (manual paste), the Tapit Circle template
  + StartVault intent card + signet test variant, and the KeyPicker/KeyManager
  "no dead screens" fixes for a key with no xpub.
- **B3 slice 1 ("prove the pipe")** -- both repos, done out of the original
  C1-C3-then-B3 order because the operator's own description of the vault's
  day-to-day signing flow named Nostr delivery directly, not as a later
  nice-to-have:
  - tapit-wallet: `features/sign-request/psbtCosignChannel.ts` (send/subscribe
    on kind 9576, mirrors `encryptedInbox.ts`'s `sendEnvelopeTo`/`subscribeInbox`
    shape), `usePsbtCosignRequests.ts` (reads wallet/transport from
    WalletContext -- WalletProvider.tsx is at its 800-line hard limit),
    `IncomingPsbtCosignBanner.tsx` (the two-line HomeScreen mount that makes
    receipt visible).
  - DynastyTrust: new vendored package `packages/nip44/` (NIP-44 v2,
    byte-identical to `tapit-attest/src/core/nip44.ts`; its parity test
    doesn't rely on deterministic encryption -- it hardcodes two real
    ciphertexts, one produced by each repo's actual implementation and
    proven to decrypt correctly under the OTHER repo's real code, run and
    verified during this pass, not assumed), `lib/tapit-nostr-cosign.ts`
    (ephemeral-keypair sender, builds+encrypts+publishes the request),
    `VaultDetail.tsx`'s `NotifyCircleViaNostr` card (mounted in both the
    main Send flow and the tranche-claim flow).
  - **Deliberately not built yet**: nothing decrypts-and-acts on the Tapit
    side beyond parsing and displaying the request shape -- no `approveSignRequest`
    call, no signature produced, nothing published back. `approveRequest.ts`'s
    psbt-cosign branch still hardcodes a `window.location.href` redirect to
    the request's `callback` URL, which is meaningless over Nostr (no page to
    redirect to) -- giving it a non-redirect delivery path is slice 2's first
    task, alongside DynastyTrust subscribing for the response and merging it
    into `signing` automatically via the existing `externalImport` path.
  - `wallet_identities`/`vault_members` join from this doc's original C3
    sketch turned out to be unnecessary for slice 1: a Tapit Circle vault's
    founder keys are pasted in directly by the owner (no DynastyTrust account
    needed for a circle member), so the real x-only pubkey is already sitting
    on the local `LocalKey.tapitXOnlyPubkey` from C2 -- nothing to resolve
    via a members table.

Gates green in both repos at each commit (tapit-wallet: typecheck, lint,
844/844 tests, build + bundle budgets; DynastyTrust: typecheck/lint matching
the pre-existing baseline exactly, policy tests, and both new packages'
own test suites).

---

## The three cuts

Each stage ships independently, proven before the next, matching Phase 1's own
discipline. **Every step has a manual copy/paste or QR fallback alongside the
deep-link path -- nothing in this bridge has a single point of failure that
strands the user mid-flow.** A blocked popup, a closed tab, a network hiccup,
or simply preferring to type -- all of them still reach the same end state by
hand.

### Cut C1 -- Tapit exposes its public key

New: a "Your public key" panel, most naturally in `features/settings/SettingsScreen.tsx`
or a new small feature alongside it -- shows `wallet.publicKey` as text (copy
button) and as a QR (reusing `features/qr/QrShow.tsx`, no new QR-rendering code).
This alone, with zero deep-link work, is a complete manual fallback: open Tapit,
copy or scan the key, paste or scan it into DynastyTrust. Ship this first --
it's small, low-risk, and the fallback for every later stage depends on it
existing.

Deep-link version (optional, faster UX once C1's manual path is proven): a new
sign-request intent, e.g. `'export-pubkey'`, added to `tapit-wallet/src/features/sign-request/types.ts`'s
`SignRequest` union. Lower stakes than `psbt-cosign` (it hands over a *public*
key, nothing signs, nothing spends) but still shows an approval screen naming
the requesting origin -- consistent with "no rogue signing" as a posture, not
just a rule for money-moving intents. Returns `{ publicKey }` in the grant
(new optional field on `SignGrant`). DynastyTrust's side reuses `lib/tapit-cosign.ts`'s
exact pattern -- `window.open` a new tab (never a full navigation, so the
wizard's in-progress config isn't stranded the same reason B2 avoided it for
signing), callback writes to `localStorage`, the wizard's `storage` listener
picks it up.

### Cut C2 -- DynastyTrust accepts a Tapit key as a founder/heir/protector/consent key

- `keystore.ts` / `descriptor-keys.ts`: a Tapit-sourced key needs its own
  shape -- `origin: 'tapit'`, real `pubkey`, no `xpub`/`fingerprint`/`derivationPath`
  (or explicit nulls, not invented values). `toPubkeyHex()` short-circuits to
  the stored pubkey directly instead of deriving `/0/0`. `buildKeyOrigins()` /
  `upgradeDescriptor()` skip the `[fp/path]xpub/0/0` upgrade for these keys --
  the compiled descriptor carries the bare pubkey for that leaf slot, which is
  valid miniscript (`pk()` needs a pubkey, not necessarily a key-origin
  wrapper) and simply won't show hardware-wallet key-origin metadata for that
  signer, which is honest: it isn't a hardware wallet.
- `VaultWizard.tsx`'s `InlineKeyCreate`: a third tab, "From Tapit," alongside
  Generate/Import. Two paths, both landing in the same `onImportXpub`-equivalent
  handler: (a) "Get key from Tapit" button using C1's deep-link, (b) a plain
  paste field for the raw pubkey hex, always visible, never hidden behind the
  deep-link -- the fallback, not an afterthought bolted on later.
- The new "Tapit Circle" template (`vault-templates.ts`): `plannedFounders`
  3-5 (configurable), `founderQ === plannedFounders` (unanimous -- the point
  of the circle), `recoveryEnabled` off by default matching Gift Locker's
  precedent (a genuinely different-shaped leg above it, not a decayed version
  of the same one), heir leg fully configurable single-sig or multi
  (`heirQ`/`plannedHeirs` free choice), matching the operator's "single sig or
  multi depending on user preference."

### Cut C3 -- DynastyTrust mints and delivers the vault-membership attestation

This is the piece that turns on Tapit's already-built (but currently inert)
`psbt-cosign` signing gate for every vault that uses it, not just Tapit Circle
vaults.

- **Parity gate first, no UI before this is green** (same discipline as B0):
  a fixture test proving DynastyTrust's `tapit-attest` copy and Tapit's
  produce a byte-identical envelope digest for the same `agreement`-kind
  draft, and that a signature from DynastyTrust's `sign.ts` verifies under
  Tapit's `verifyEnvelope`. If the two copies can't be proven compatible,
  vendor one shared module the way B0 did for the PSBT signer and B3 did for
  Nostr transport, rather than trust two independently-evolved
  implementations to agree.
- At compile time (`vaults-compile.js`, alongside the existing descriptor
  compile), for every Tapit-sourced key in the result: build an
  `agreement`-kind attestation with `agreement_type: 'vault-membership'`,
  `vault_descriptor`, `vault_name`, `role`, `leaf_scripts` (the hex tapscript
  bytes that signer's key actually appears in -- read straight off the
  compiled `MultileafOutput`, never guessed), `high_value_threshold_sats`
  (wired to the same tier concept `docs/2026-08-callback-verification-and-amount-tiers.md`
  already defines). Sign it with... **open question, needs an answer before
  this cut starts:** the vault owner's own key (DynastyTrust already
  Schnorr-signs attestations today via `lib/attest.ts` for trust-doc/proof-of-
  life/death-declaration), naming the owner as the attester of record for who
  they invited and to which leaf -- not the Tapit member signing about
  themselves, since the member hasn't necessarily even received the draft yet
  at this point.
- Deliver to Tapit as a `cosign-existing` request (the existing intent already
  built for exactly this shape: "the wallet ADDS its signature to an
  already-signed envelope the requester hands over" -- ports directly, no new
  intent needed here unlike C1). Tapit's approval screen shows the plain-
  English membership terms, the member co-signs (proving they agreed to be
  named, not just that DynastyTrust claims they are), and the wallet calls
  `hold()` on the resulting envelope -- which is what makes `findVaultTrail`
  start finding it.
- Manual fallback: the attestation, once DynastyTrust has signed its half, is
  also downloadable/QR-able as raw JSON from the vault's Trust tab, importable
  into Tapit via its existing `features/qr/ScanEnvelopeModal.tsx` /
  `parseEnvelope.ts` (already built, used for other attestation import today)
  -- so a member without a smoothly working deep-link still ends up holding a
  real, self-verifying trail.

---

## Nostr transport

Raised by the operator, explicitly left "up to you." Recommendation: **defer,
same call B3 already made for the signing bridge** -- ship the deep-link +
manual-paste version of all three cuts first, proven on signet with real
people, before adding a transport. The request/grant shapes in C1-C3 are
already transport-agnostic (Phase 1's own framing: "deeplink transport encodes
these as base64url JSON in a query parameter; a Nostr transport would put them
in event payloads" -- the shapes don't change, only how they travel), and B3's
vendored `@dynastytrust/nostr-transport` package plus its established
kind-9576 precedent (the next free sibling after Tapit's liveness channel)
means adding Nostr later is additive, not a redesign. Encrypted, no-redirect
delivery is a genuinely better end state for a 3-5-person circle who'd
otherwise be juggling browser tabs -- it's just not the thing to build first
against an unproven key model.

---

## Rails (extending Phase 1's risk register to key import + attestation issuance)

- **No rogue signing extends to no rogue key claims.** DynastyTrust never
  asserts a pubkey belongs to a Tapit wallet without that wallet having
  produced it live (deep-link) or the operator having pasted it themselves
  (manual) -- never inferred, never reused across vaults silently.
- **The membership attestation is the same "governance signal, not spend
  authority" class as proof-of-life and death-declaration.** It gates whether
  Tapit *will* sign, same as it always has for `psbt-cosign` -- it is not
  itself a Bitcoin authorization and never substitutes for the real quorum.
- **Every deep-link step has a manual equivalent that ships in the same cut,
  not a "later" TODO** -- this was an explicit operator requirement
  ("manual paste in all directions for fall back... no dead screens or dead
  ends"). A blocked popup or a closed tab must never be able to strand
  someone with a half-built vault or a half-delivered attestation.
- **Small amounts first, signet before mainnet** -- same rule Phase 1 set for
  the signing bridge, applies identically here since C3 is the piece that
  arms it.
- **Parity proof before trust, not after** -- C3 does not ship until the two
  `tapit-attest` copies are proven to agree, mirroring B0 exactly.

---

## Touch list

**tapit-wallet:**
- `src/features/settings/` (or new small feature) -- "your public key" panel,
  reusing `features/qr/QrShow.tsx`.
- `src/features/sign-request/types.ts` -- new `ExportPubkeySignRequest` intent
  (C1 deep-link path).
- `src/features/sign-request/approveRequest.ts`, `SignApprovalScreen.tsx` --
  handle the new intent; existing `cosign-existing` handling covers C3
  without changes.

**DynastyTrust:**
- `apps/web/src/lib/keystore.ts`, `lib/descriptor-keys.ts` -- Tapit key
  source shape, `toPubkeyHex()` / `buildKeyOrigins()` short-circuit.
- `apps/web/src/lib/tapit-cosign.ts` (or a sibling `tapit-pubkey-export.ts`
  following the identical pattern) -- C1's deep-link request/callback.
- `apps/web/src/pages/VaultWizard.tsx` -- `InlineKeyCreate`'s new "From
  Tapit" tab (deep-link button + always-visible manual paste field).
- `apps/web/src/lib/vault-templates.ts` -- the new Tapit Circle template.
- `netlify/functions/vaults-compile.js` -- mint + deliver the
  vault-membership attestation at compile time (C3).
- `apps/web/src/components/TrustTab.tsx` or `VaultDetail.tsx` -- the manual
  attestation export/QR fallback for C3.
- A new parity-test fixture between DynastyTrust's and Tapit's
  `tapit-attest` copies, matching B0/B3's precedent.

---

## Recommended order

1. C1 manual half only (Tapit's pubkey panel) -- smallest, zero risk, unlocks
   testing everything downstream by hand even before any deep-link exists.
2. C2 (DynastyTrust accepts a bare Tapit pubkey as a real founder/heir key,
   pasted manually) -- provably compiles a real vault with a real Tapit key
   in it, no bridge automation needed yet.
3. The parity test (tapit-attest byte-parity) -- gate before C3, same as B0
   gated before B1/B2.
4. C3 (mint + deliver the membership attestation, manual fallback first) --
   this is the moment Tapit's existing `psbt-cosign` signing actually starts
   working on a real vault for the first time.
5. C1's deep-link half, then C3's deep-link half -- automation layered on top
   of a fully working manual path, never replacing it.
6. Nostr transport, once all of the above is proven on signet.
