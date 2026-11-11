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
   `npm test`. CORRECTION: this entry first said the Fly compiler deploy
   does not trigger on a `Cargo.lock`-only change. That was wrong -- the
   workflow's path list includes `Cargo.lock` (only its first three lines
   had been read). The compiler redeployed with the updated crates at
   21:34 UTC on 2026-11-10 (Actions run 31, success).

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

8e. **Adversarial review of the compiler path.** Done 2026-11-10; the three
   worst fixed and deployed the same day (see `HISTORY.md`):
   - ~~A1 twin keys~~: `02..X` / `03..X` are one Taproot key; a "2-of-2" over
     the pair opened with one signature. Rejected in every validator.
   - ~~A2 decay ladder~~: only the first rung's relative wait was capped, so
     lower rungs wrapped BIP 68 and opened at funding. Every rung validated.
   - ~~A4 height >= 500,000,000~~: read by Bitcoin as a past date. Rejected in
     Rust; offsets capped at ~100 years in the web tier.
   STILL OPEN from that review, in the order I would fix them:
   - A3: a co-signer's `fingerprint` / `derivation_path` are spliced into the
     stored descriptor unvalidated -- the saved descriptor can describe a
     different, attacker-spendable vault (real coins unaffected; anyone
     restoring from that descriptor, incl. Legacy Recovery, is misled).
   - A6: the consent gate is silently left out of the script when compiled
     before the beneficiary joins, while the record still says gated.
   - A5: `vaults.js` / `distribution-wallets.js` store an owner-supplied
     address + descriptor as "compiled" without recompiling to check.
   - A8 duplicate leaf ids (one vanishes from `leaf_scripts`); A10 path label
     not checked against the policy; A7 `address_type` other than
     `tr_multileaf` compiles a vault the app cannot spend; A9 `/psbt-binary`
     fails open with no policy and the tranche builder has no input/change
     check (reachable only by a direct caller); A11 an uncompressed key
     panics a request and huge key sets burn CPU; A12 Rust's timelock floors
     see absolute heights; A13 auth after body parsing, no dust/fee cap.

15. **Tamper-evident record and identity at the door.** Operator,
    2026-11-10: the chain of actions "all the way from the beginning to the
    end ... tamper evident ... always checking against the open timestamps
    hash that cannot be changed ... records of every single thing", and
    "anyone else logging in is who they're supposed to be." Five slices:
    - ~~15a Sealed ledger + lock the table.~~ BUILT 2026-11-10; LIVE 2026-11-11 (code 55d04f1,
      migration applied by DB deploy run 65 once the expired access token was
      replaced) (see `HISTORY.md`): `vault_ledger`, hash-chained
      and append-only for every role; `vault_events` read-only from the
      browser; every server event write goes through `recordEvent`.
    - 15b Signed entries: creating the vault, joining with a key, the final
      key set, each spend signature -- signed by the actor's vault key.
    - ~~15c Anchoring.~~ BUILT 2026-11-11, LIVE on main 29f3f8d with its
      migration applied, site verified (see `HISTORY.md`):
      the ledger tip is submitted to two OpenTimestamps calendars at
      milestones and by a daily job, receipts are upgraded to Bitcoin proofs
      checked against the real block from two sources, and
      `verifyAnchors` fails a ledger whose tail was cut or swapped. Our own
      dependency-free OTS reader, proven against the reference client's
      proof and Bitcoin block 358,391. NOT yet seen: one of OUR receipts
      upgrading to a Bitcoin proof (takes hours; a live receipt from
      2026-11-11 is saved to check), and the scheduled job running on Netlify.
    - ~~15d Verify screen + downloadable file, for every member.~~ BUILT
      2026-11-11, on the branch (see `HISTORY.md`): `/vaults/:id/record`
      re-walks the chain and checks the Bitcoin timestamps in the member's
      own browser, green or red, with a file to keep. Signature checks wait
      for 15b. Not yet seen against a real sealed entry.
    - 15e Identity at the door: invite bound to the invited email; the owner
      confirms the joiner's key fingerprint before the vault is finalized;
      two-step sign-in required to join a mainnet vault.
    Known limits to carry forward: existing vaults have no sealed history
    before the day this ships; if a ledger write fails the action still
    completes and the gap is only visible in the function logs; real-world
    identity (who is holding the phone) is out of scope by design.

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

16. **`npm run dev` is broken (found 2026-11-11).** `tapit-attest/dist/anchor/
    opentimestamps-provider.js` still imports the `opentimestamps` package
    removed on 2026-11-10. Production builds drop that file and are
    unaffected (the live bundle is verified); only the local dev server
    fails. Fix in tapit-attest: remove or stub the provider, rebuild dist.

## Journey gaps -- found walking a family through the app (2026-11-11)

Read from every screen, the worst ones confirmed in the code by hand; not
walked on the live site as a new user. Ordered by how badly each one hurts a
real family. The operator picks the order.

J1. ~~**No way to restore a key from its words.**~~ BUILT 2026-11-11 (see
    `HISTORY.md`); also warns that keys live only in this browser.
J2. ~~**The inheritance moment.**~~ BUILT 2026-11-11 for both vault shapes,
    including opening Send on the right path (see `HISTORY.md`). STILL
    OPEN: (f) ~~a leaf-list vault cannot be rotated at all~~ BUILT
    2026-11-11 on the branch (see `HISTORY.md`); walk it on signet before
    real coins; Bloc vaults still cannot be rotated;
    (g) nothing reaches a person who is not looking at the app (J4). Was: (a) VaultDetail says inheritance is
    "Triggered only if the trustees are unreachable for the full window" --
    false, it opens at a fixed block height whatever anyone does. (b) The
    heir's Dashboard line turns the absolute height into a duration, so it
    never changes and never says open (named-field vaults). (c) When the
    path opens the heir's one prompt disappears; what remains is a card
    with no button and no steps. (d) "Rotate" defaults to the time
    remaining, so rotating keeps the same deadline; nothing says rotating
    is how a founder pushes inheritance out. (e) Nothing tells a founder
    the inheritance date is approaching.
J3. **Family cannot join a vault built today with their own keys.** Only
    the broken copy-link is fixed (2026-11-11); the rest is open. Was: The
    wizard fills every slot from keys in the owner's browser or a pasted
    xpub; `compile-leaves.js` never reads invited members. Invites still
    exist for old drafts: no email is sent, the link is a bearer token,
    nobody confirms a fingerprint, the invite flow cannot create a key, and
    the draft card's "Copy link" builds `/invite?token=` when the route is
    `/invite/:token`. A leaf-list draft shows "0 of 0 members joined" with
    a Compile button that fails. This is also 15e.
J4. **Nobody is told when they are needed.** The waiting-spend button
    and Cancel BUILT 2026-11-11; no email or push, and the co-signer still
    does not see fee or change. Was: No email or push anywhere. A
    second signer must know to open the app; "proposals awaiting
    signatures" has a "Go to Send" button that opens a blank form; the
    co-signer sees amount and destination but not fee or change; "Cancel"
    does not cancel the proposal.
J5. ~~**Sign-up from the home page.**~~ BUILT 2026-11-11. Was: It says "we sent a confirmation link";
    the email carries a 6-digit code and that page has no box for it. It
    also says the email "can be a burner".
J6. **Funding.** Deposit QR and test-first note BUILT 2026-11-11; no address check on a signing device yet. Was: No receive QR (the only QR is the descriptor, easy to scan
    by mistake), no "send a small test first", no address check.
J7. **Builder.** Opens blank with "Path 1"; the heirs' path must be
    invented; Sage's proposal is dropped on "build this"; network buttons
    are raw "signet"/"bitcoin"; compile fires on one tap and the wizard
    never says it is permanent; new-key form defaults to Testnet with the
    password box unticked.
J8. **If the site is gone.** The forced backup file is right, but the vault
    page has nine equal buttons and none is marked as the one to keep; the
    txt and the PDF disagree about Nunchuk; the long-horizon recovery setup
    asks for txid, vout and fee rate by hand; `/recover-descriptor` says
    "no account" but sits behind sign-in.
J9. **Jargon with no explanation** across the journey: xpub, fingerprint,
    derivation path, PSBT, sat/vb, UTXO, quorum, descriptor, TR_MULTILEAF,
    blocks, founder/heir/successor/trustee used interchangeably.

### J3 plan -- family joins with their own keys (agreed 2026-11-11; BUILT the same day, on the branch -- see `HISTORY.md`)

The loop: in the builder's Keys step a slot can be filled by "Invite someone
to hold this key" (name + email, path-bound link the owner sends); the
person signs in with that email and makes their key on their own device
with the backup step; the owner sees the fingerprint, checks it with them
by voice, and confirms; only confirmed keys can go into the vault; slots
persist between visits; finalize as today; the vault then appears on each
person's dashboard.

Operator's decisions (chips): invite tied to the invited email; owner
confirms every invited key's fingerprint ALWAYS, test coins included;
two-step sign-in required to join a real-bitcoin vault; an invited person
may use a password-protected phone key (backup required before joining) or
a hardware wallet; before finalize they see their own path only; the
owner can still fill any slot themselves exactly as today.

Blast radius: one migration (invites and members gain the path; members
gain confirmed-by/at); invites.js, invites-lookup.js, invites-claim.js
(email match, key validated -- also closes compiler-review A3), members.js
(owner confirm; no key change after confirm), compile-leaves.js (refuse an
unconfirmed member key), vaults.js (persist slots); VaultWizard Keys step,
InviteClaim, the draft card ("0 of 0" + failing Compile), Members tab, the
invitee's dashboard for a draft; a new sealed-record entry for the
confirmation, stamped at once. Not touched: compiler, signing path,
finalized vaults, the older-shape invite flow.

Left out: emailing the link; changing people after finalize; Bloc and
older-shape drafts; telling people when a spend needs them; who is
physically holding the phone.

Ships as one piece only when the whole loop walks; operator walks it on
signet with a second account before real bitcoin.

## Parked, decided, not started: a must-sign key on any path (2026-11-11)

Operator: "each leaf could have the and and it could be the hardware
signer and whatever the other part of the leaf would be." Plan given
2026-11-11; he chose to WAIT until he has walked the shared-key change
and the earlier items on his phone. Nothing is built.

His decisions, by chip:
- One OR MORE keys on a path may be marked must-sign.
- On a path that relaxes over time, a must-sign key STAYS required at
  every step; only the quorum of the other keys steps down.

Shape: `Leaf` gains an optional must-sign list; the path's script
becomes `and(pk(A), and(pk(B), thresh(q, others)))`, the same form the
consent group on the first path already compiles to
(`protocol/src/policy_compiler.rs`, `build_leaf_multileaf`). A vault
with no must-sign keys must keep its address (prove with
`scripts/test-known-answers.mjs` first).

Two slices: (1) compiler + offline harness proof, nothing visible;
(2) everything a person sees together -- builder, `lib/path-risk.ts`
(a must-sign key is required by definition), draft save, finalize,
spend build and fee estimate, signature counting on proposals, rotate,
what an invited person is told, the three PDFs, the assistant, vault
and proposal pages, trust document, backup file. No migration.

Unverified and cannot be verified from the sandbox: whether Coldcard,
Sparrow and Nunchuk import a descriptor with a lone key joined to a
multi-signature inside one path.

Left out on purpose: the named-field and Bloc builders; changing an
existing vault (new rule = new address = Rotate); an anyone-can-spend
last resort.

## Parked, plan only: an offline "seed words to account key" tool (2026-11-11)

Why: Bitcoin Core is now the proven recovery path, and Core does not
read seed words. Each signer must turn their words into the account
private key for the path printed beside their key. Today the backup
file says "get help from a person you trust". Operator asked for a
plan, NOT a build.

What it would be: one HTML file, like the existing
`/dynastytrust-legacy-recovery-tool.html` (same build script pattern,
`tools/legacy-recovery/build.mjs`), reusing `keystore.ts`'s tested
derivation. Inputs: the words, the network, the path from the backup
file. Outputs: the account private key and the ready-to-paste
descriptor key `[fingerprint/path]xprv/0/0`, plus the fingerprint so
the person can check it matches the backup file BEFORE using it.

Risks to settle first: it is a page that asks for seed words -- the
exact thing phishing pages do, so it must never be linked from a
signed-in screen, must refuse to run when online (or warn loudly), and
its checksum should be printed in the backup file so a saved copy can
be checked. A private key shown on screen can be photographed. A
hardware wallet avoids all of this and stays the better answer where
one exists.

Proof it would need: the Bitcoin Core proof extended to take the
tool's output instead of the keys it derives itself.

Left out: any online version; storing anything; signing in the tool.
