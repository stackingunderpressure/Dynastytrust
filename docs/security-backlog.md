# Security backlog -- the gaps, in the order we close them

Written 2026-11-09 from a grounded read of `main` (not from memory), after the
operator asked: other than the compiler living on Fly, how could someone be
tricked into signing something they should not, or how could DynastyTrust be
hacked to compromise funds or identity? Each item names the file, the attack
it closes, and how it is proven. Close one, append the proof to `HISTORY.md`,
strike it here. Nothing on this list is theoretical hand-waving: each one was
read in the code.

The frame: every vault is script-path only under the NUMS key, so no server
can move a coin. The only ways to lose funds are (a) a keyholder signs a
transaction that is not what they think it is, or (b) the keys themselves
leak. Identity is lost through (c) what an account or database exposure
reveals. The list is ordered by how directly each item stops (a), then (b),
then (c).

## Closed

1. ~~**Browser full-transaction gate.**~~ Closed 2026-11-09 (see `HISTORY.md`).
   `verifyPsbtMatchesRequest` now verifies, from the PSBT's own witness UTXOs,
   that every input is the vault's own coin, that any change returns to the
   vault, and that the real fee and change equal what the human is shown; wired
   into the main Send flow, the tranche claim, and the co-signer page. A
   coordinator (Netlify function, Supabase row, Fly compiler) can now only
   refuse to build a transaction, never redirect one. Proven by 8 harness
   checks (forged change, foreign input, lying fee, lying change, swapped
   destination; compiler-side refusals as belt and braces).

2. ~~**Absolute timelock cross-check.**~~ Closed 2026-11-09 (see `HISTORY.md`).
   Server: `_chain.js` `fetchTipHeight` now requires an all-digit response and a
   per-network `TIP_FLOOR`. Browser: `lib/timelock-check.ts` + `VaultWizard`
   fetch the tip separately and refuse to accept a compiled vault (all three
   shapes) unless every `after()` height is tip + the chosen offset within 12
   blocks, every `older()` duration came back untouched, and nothing carries a
   timelock that was not asked for. Proven by `scripts/test-timelock-check.mjs`
   (6 cases, in `npm test`). Honest limit: both tips still come from
   mempool.space, so this defends against the server path, not against the
   feed itself -- that is item 12.

## Open -- stops "tricked into signing"

3. ~~**Co-signer gate for tranche claims.**~~ Closed 2026-11-10 by grounding, no
   code: `ProposalDetail.tsx` never signs a tranche claim -- for
   `path === "tranche_claim"` it renders a notice that claims are signed from
   the Distributions tab and hides every signing surface (`!isTrancheClaim`
   on the local-key, Nostr and hardware cards). The Distributions-tab claim
   flow already carries the full gate with `tranche.address` (item 1). The
   gate on the proposal page still checks destination, amount and fee for a
   tranche claim's stored PSBT so the mismatch banner stays accurate.

4. ~~**Attestations verified on write.**~~ Closed 2026-11-10 (see `HISTORY.md`).
   `netlify/functions/_attest.js` mirrors the browser digest
   (`SHA256("DT-ATT-v1" || type || 0x00 || target_hash)`) and
   `vault-attestations.js` refuses any row whose Schnorr signature does not
   verify under the caller's registered `vault_members.pubkey`. Proven by
   `scripts/test-attestation-verify.mjs` (4 cases, browser signer vs server
   verifier, in `npm test`).

5. **Descriptor trust on load.** The vault's descriptor and address come from
   Supabase; fingerprint pinning (2026-08-29) is a comparison aid only. Once the
   compiler runs in the browser (item 9), re-derive the address from the stored
   descriptor on every load and refuse to show a vault whose descriptor does
   not compile to its own address.

## Open -- stops key leakage

6. ~~**Mainnet requires secure mode.**~~ Closed 2026-11-10 (see `HISTORY.md`).
   `keystore.ts`: a plaintext test-mode key can no longer be generated for
   mainnet, a mainnet key can no longer have its password removed, and
   `revealMnemonic` refuses a plaintext mainnet seed even if it pre-dates the
   rule or came in from a keyring file -- while `secureTestKey` (add a
   password) still works on it, so the upgrade path stays open.
   `keySigningBlockedReason(key)` is exported for the signer pickers; wiring
   it into their labels is a UI follow-up, the chokepoint already holds.
   Proven by `scripts/test-keystore-mainnet.mjs` (5 cases, in `npm test`).

7. **Passkey-protected keys.** BUILT 2026-11-10, on the branch, NOT yet walked
   on a real device (see `HISTORY.md`). A key's password can be REPLACED by a
   passkey (WebAuthn PRF): the mnemonic is encrypted under a secret only the
   device's authenticator can produce, so there is no password to phish or
   capture as it is typed. `protectKeyWithPasskey` refuses unless the written
   backup was verified, asks the passkey twice and requires the same answer,
   and re-decrypts before it drops the password. "Use a password instead"
   goes back. Before this is called closed, the operator walks on a phone:
   protect a SIGNET key, sign with it, view its phrase, switch back to a
   password. Known limits: a passkey is bound to the site's domain
   (dynastytrust.family) and to the device or its synced keychain; PRF needs
   a recent browser (iOS 18+, current Chrome/Android) -- older ones are told
   plainly and keep the password; a decrypted mnemonic still exists in memory
   for the length of one signing call.

8. ~~**Supply chain: audit gate on what ships.**~~ Closed 2026-11-10 (see
   `HISTORY.md`). `scripts/audit-prod.mjs` (in `npm test`) fails on any
   high/critical advisory in the root tree with `--omit=dev` or in
   `netlify/functions`; offline it says UNVERIFIED and exits non-zero rather
   than passing silently. Measured before: 33 advisories in the tree, 16 in
   code that ships (4 high, 2 critical). After: 0 of any severity in what
   ships. The two criticals were the `request`/`form-data` chain under
   `opentimestamps`, pulled in by tapit-attest and never executed here --
   removed from tapit-attest's dependencies entirely (operator: "take it from
   tapit, standalone is better"); the provider still loads it lazily if a
   consumer installs it. react-router-dom 7.14.1 -> 7.18.5, ws -> 8.22.2 in
   both trees, brace-expansion updated. Dev tooling advisories (vite, eslint,
   postcss...) deliberately not gated: they never reach a user.

8b. ~~**Reproducible bundle check, strict installs, exact pins.**~~ Closed
   2026-11-10 (see `HISTORY.md`). `npm run verify:live` rebuilds the commit the
   live site claims to be, from scratch, and compares every served file byte
   for byte -- first run PASSED against d9e7548. Netlify now runs `npm ci`
   (lockfile only); all 55 dependency ranges are pinned to exact versions.

8c. ~~**Known-answer tests + Rust vulnerability gate.**~~ Closed 2026-11-10.
   `scripts/test-known-answers.mjs`: all 19 official BIP 340 vectors, the 7
   official BIP 341 wallet cases, and our script-path sighash against an
   independent implementation (36 digests). `scripts/audit-rust.mjs`: every
   locked crate checked against the OSV/RustSec database -- its first run
   found two unsound-API advisories (anyhow, tokio), both updated. Both in
   `npm test`. Open: the Fly compiler deploy does not trigger on a
   `Cargo.lock`-only change, so the DEPLOYED compiler still has the older
   anyhow/tokio (we call neither affected function) until its next deploy.

8d. ~~**Adversarial review of how we call the signing libraries.**~~ Done
   2026-11-10 (see `HISTORY.md`). Seven findings, all fixed: a tampered keyring
   file could seat an attacker's key in a vault (the one that could lose
   funds); the server's and browser's signature counts could be faked and a
   real signature shut out; the signer matched keys by substring and never
   checked a leaf belonged to the coin; the PSBT parser was lenient; seed
   blobs were not tied to their key; password stretching was below the
   SHA-256 figure; the keyring export shipped the passkey ciphertext.
   Still open from that review (not fund-losing):
   - Legacy Recovery: a hardware signer with randomized nonces would seal a
     share nobody can reopen -- sign twice and compare before sealing.
   - `vault-attestations.js` stores `target_data` without recomputing
     `target_hash` from it.
   - The same `/0/0` key signs for every vault a key is in (one leaked child
     key affects them all, and spends link the vaults on chain) -- structural.
   - A hardware wallet that reads a PSBT differently than we do is now much
     harder (strict parser) but untested on a real device.
   - Not yet reviewed: the compiler path (rust-miniscript / rust-bitcoin).

9. **Compiler in the browser (WASM), Fly as cross-check.** Compile-first
   migration of `protocol/` to WASM so the descriptor, address and PSBT are
   produced on the device; keep Fly for a byte-identical cross-check until the
   WASM path has run long enough to trust alone. This also unlocks item 5.

## Open -- stops identity exposure

10. **Second factor on sign-in.** BUILT 2026-11-10, on the branch, NOT yet
    walked on a real account (see `HISTORY.md`). Opt-in TOTP authenticator:
    `TwoStepCard` on the Keys page turns it on; `RequireAuth` shows
    `MfaChallenge` and renders nothing of the app until the code verifies;
    `_auth.js` refuses every API call from a password-only session once the
    account has a verified factor. Before this is called closed:
    - the operator walks enroll -> sign out -> sign in -> code -> turn off on
      a phone, and confirms a factor lookup succeeded in the function logs;
    - then flip `hasVerifiedFactor` in `_auth.js` from fail-open-on-lookup-error
      to fail-closed (it is fail-open only because it could not be exercised
      live and sits in front of every function);
    - MFA must be enabled for the Supabase project (Auth settings);
    - still to decide: REQUIRING it for members of mainnet vaults, and
      recovery codes / what a person does when the phone is lost (today:
      the owner of the Supabase project removes the factor by hand).

11. ~~**Authorization audit of every service-role function.**~~ Closed
    2026-11-10 (see `HISTORY.md`). All 40 functions that use the service-role
    key were read end to end. No endpoint let a stranger reach another user's
    vault by guessing an id, but 13 gaps were confirmed where "is a member" was
    treated as "may change this" or an export returned whole rows -- the worst
    let a view-only member read unclaimed invite tokens from the activity
    export and join as a founder. All 13 fixed; shared rules in
    `netlify/functions/_authz.js`, proven by `scripts/test-authz.mjs`.

11b. **Audit follow-ups.** Four closed 2026-11-10 (see `HISTORY.md`):
    - ~~`proposals.js`: `signed` / `fulfilled` settable by a client.~~ A client
      may now only set `broadcast` (chain-verified) or `cancelled`.
    - ~~`signer-sessions.js`: any bytes recorded as a signature.~~ The PSBT
      must be the proposal's own transaction and carry at least one
      cryptographically valid signature (`_psbt-verify.js`).
    - ~~`distribution-wallets.js`: tranche txid not verified on chain.~~ A
      txid a non-owner fills in must be a real transaction that pays /
      spends that tranche's address.
    - ~~Wallet sign-in: challenge consumption not atomic.~~ Atomic in both
      `wallet-signin-verify.js` and `wallet-link.js`. Expiry was already
      enforced inside tapit-attest's `verifySignIn`.
    Still open, each needs an operator call or a live database:
    - `members.js`: an active member can change their own
      xpub/pubkey/fingerprint after the vault is compiled (`repairPubkeys()`
      on boot writes these, so locking them is a design decision).
    - Wallet sign-in challenge is not bound to whoever requested it: someone
      tricked into signing an attacker's challenge would sign the attacker in
      as them. Depends on what Tapit Wallet shows the person before signing.
    - Moving functions off the service-role key onto the caller's JWT + RLS.

12. ~~**Two independent chain sources for the tip.**~~ Closed 2026-11-10 (see
    `HISTORY.md`). Every compile path now uses `fetchVerifiedTipHeight`
    (mempool.space AND blockstream.info must both answer and agree within 6
    blocks; the higher is used; otherwise the compile fails), and the wizard's
    timelock cross-check uses the browser's own two-source `verifiedTipHeight`.
    This also closes the limit noted under item 2. Still single-source, by
    choice for now: balances, UTXO lookup, fee estimates and broadcast -- a
    wrong answer there is visible and recoverable, not baked into a script.

## Operational, not a code gap

13. **Supabase free-tier pause.** The project pauses after a week idle and the
    front door answers "Load failed". Recovery never depended on the server
    (descriptor backup + Legacy Recovery), which is the right property, but
    before anyone other than the operator relies on the hosted app, either the
    paid tier or a scheduled keep-alive request. Operator's call, deliberately
    deferred while the app is in build.

14. **The Kimi K3 report text.** The 146-finding scan's per-finding text is not
    in the repo. When found, commit it under `docs/audits/` so the next scan
    can be diffed against it.
