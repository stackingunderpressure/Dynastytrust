# DynastyTrust -- build history

Moved out of `CLAUDE.md` on 2026-09-16. This is the per-fix record: every
closed bug, every audit follow-up, what the root cause actually was, what was
deliberately NOT done, and which gates were green at the time. Nothing was
deleted in the move.

It lives here rather than in the doctrine file because `CLAUDE.md` is what an
agent must obey before it touches money-touching Bitcoin code, and 2,100 lines
of history in front of those rules is 2,100 lines an agent reads instead. The
architecture rules -- absolute CLTV vs relative CSV, `tr_multileaf`, keys never
leaving the browser -- stayed in `CLAUDE.md` deliberately: those are rules, and
losing one could lose an inheritance.

Read the entry for the code you are about to touch. Do not read all of it.
**Append here when you close something**, and keep `CLAUDE.md`'s "Current
state" block short -- working features, open gaps, next roadmap, nothing more.

## Evidence record -- what has actually been proven, and where the proof is

Written 2026-11-09 because a session told the operator there had been no
independent audit and no real-coin spend. Both were wrong; the evidence was in
this repo and on the chain, and nobody had indexed it. This section exists so
that never happens again. Every line below is either verifiable from the
named commit or the named transaction, or is marked as operator-witnessed.

**1. Real mainnet spend through the DynastyTrust pipeline (2026-08-15).**
Transaction `03107bcc865ae5d40e55de4c23b87c4420dd5d7ef12bbfa945566b5733a6f77c`,
confirmed in block 962,506 at 01:54:29 UTC (Foundry USA), 190 sats fee at
1.13 sat/vB, RBF-signalled (`nSequence 0xfffffffd`), `nLockTime 0`.
Verified on-chain on 2026-11-09 by decoding the witness from mempool.space,
not from memory:

- The spent output is `bc1pk2yjvl2gfwhe6tsec29lr4m6kpevdya8c7z0s47qwllnd2pdccfsfehq63`
  (P2TR), funded 30 minutes earlier by
  `95335563f2b35092f24312950ada715a47b0f3f7d6393826321244101e6285f1` with
  15,889 sats in block 962,503.
- The witness is a **Taproot script-path spend** with 4 items: a 64-byte
  Schnorr signature (SIGHASH_DEFAULT -- the only form our signer emits), an
  empty element for the unsigned key, the leaf script, and a 33-byte control
  block (leaf version 0xc0, no merkle path: a single-leaf tree).
- The control block's internal key is
  `50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0` -- the
  BIP341 NUMS point, byte-identical to `NUMS_HEX` in
  `protocol/src/policy_compiler.rs`, `protocol/src/psbt_builder.rs` and
  `compiler/src/main.rs`. No key-path spend is possible on this output; only
  the compiled script can move it, which is the whole design.
- The leaf script is `<pk1> OP_CHECKSIG <pk2> OP_CHECKSIGADD OP_1 OP_NUMEQUAL`
  = `multi_a(1, pk1, pk2)`: a 1-of-2 founders-only leaf with no timelock, the
  shape the wizard's `plain` mode compiles (founders only, quorum 1 of 2, no
  recovery or inheritance leaves, so `nest_leaves` returns the single leaf).
- Outputs: 13,889 sats to `bc1q67jr5skxxgjduf2njkktnyj968hw5072ww2vz3`
  (P2WPKH, the destination) and 1,810 sats of **change back to the vault's
  own address** -- exactly what `/psbt-binary`'s server-side
  `change_address` check enforces.
- Operator-witnessed, not derivable from the chain: the PSBT was built by
  DynastyTrust, signed in the browser with the DynastyTrust + Tapit Wallet
  signing bridge, and broadcast from the app. The chain proves the
  construction is ours and the spend was valid; it cannot show which app
  held the pen.

What this does NOT prove: a timelocked path (recovery or inheritance) spent
on mainnet, a hardware-wallet signature, or a multi-leaf tree. Those are
proven offline by the harness (item 3) and remain to be walked live on
signet per `[TEST] Family Inheritance`.

**2. Independent security audit (2026-08-21, follow-up 2026-08-29).** A paid
Kimi K3 automated security scan of the whole repo produced 146 findings. They
were triaged in two sessions; the confirmed-real ones were fixed in roughly
twenty commits on 2026-08-21, each citing the finding numbers it closes
(`c994971` #7/#10/#85 bounded PSBT parsing + rejected sighash types,
`3ab87c0` #12/#22 prevout/change scripts cross-checked against the compiled
policy, `dc1191b` #19/#138/#21/#26, `f1bfa44` Family A
`verifyPsbtMatchesRequest` in the send flow, `a85191b`, `a96fb5e`,
`1fe7b66` #56, `74e2a1b` #142, `a2af924` #15/#49/#25 request state machine +
broadcast txid verification, `7056348` #55/#66, `22bdcc6` #42/#58
MIN_RECOVERY_BLOCKS floor, `34e80cd` #145 membership-ack forgery,
`bde647a` #53/#80/#92/#131/#146 psbt-cosign + Tapit-connect response
forgery, `afe5499` #142/#8/#23, then Family D `27bcb8b`/`83e68da`/
`5794eab`/`9600897`). Three findings were design calls the operator
confirmed as intentional and are recorded in the "Security audit follow-up"
entry below so a future scan does not re-flag them. The threat-model
follow-up on 2026-08-29 (`978e9c2`) added descriptor-swap fingerprint
pinning and the CSP. **Gap:** the scan's per-finding text was not preserved
in the repo (see the Family D entry); the original report lives only where
the service delivered it. If it is found, commit it under `docs/audits/`.

**3. Offline every-door proof (2026-11-08).** `npm test` ends with
`scripts/offline-harness.sh`, which builds and runs the real Rust compiler
locally and drives `scripts/offline-vault-harness.mjs` through it: 33
checks across seven vault shapes (family-inheritance incl. consent gate,
lost-device, social-recovery, backup, second-inheritance, dynasty-bloc with
all four legs and three decay rungs, tranche), each positive spend compiled,
PSBT-built, signed with the real browser signer, merged and finalized by
rust-miniscript with the finalized transaction's `nLockTime` asserted, and
each negative (below quorum, wrong cohort, non-existent rung, consent
missing) asserted to be rejected. No Fly, no network, no bitcoind. The
finalizer is rust-miniscript's satisfier, not a node, so this proves the
compiler, signer and finalizer agree -- the live signet walk proves a
network agrees.

**Stale record to correct elsewhere:** AppCommander's
`project-memory/foreman-memory/projects/dynastytrust/DOCTRINE.md` (written
2026-05-16) still lists "end-to-end signet spend with real independent
signers" as not yet verified. Item 1 above postdates it.

## Security backlog (2026-11-09)

- **Must-sign keys SHIPPED 2026-11-12 01:01 UTC (main 8168739), and a
  guard added the same hour for a gap I opened by shipping.** Site
  verified byte-identical to 8168739; compiler deploy run 33 succeeded
  at 01:03 UTC.
  THE GAP: the site and the compiler deploy separately. Between the
  site going live and the compiler finishing (about two minutes), and
  for as long as any future compiler deploy fails, the OLD compiler
  would be asked to finalize a must-sign vault. It does not know the
  field, ignores it, and returns a valid address for the SAME vault
  WITHOUT the must-sign keys -- weaker than what the owner was shown,
  with nothing to say so. I should have built the guard before
  shipping, not after. I cannot see the database from here, so I
  cannot prove no must-sign vault was finalized in that window; the
  operator was the only person who knew the feature existed.
  THE GUARD: `netlify/functions/_must-sign-check.js` and its twin
  `apps/web/src/lib/must-sign-check.ts` check, from the compiled
  scripts, that every must-sign key is in ITS OWN path's script, on
  every step of a relaxing path (a key that merely appears on another
  path does not count). `compile-leaves.js` refuses and saves nothing;
  the builder and the rotate screen check again in the browser and
  refuse ("Do not send bitcoin to it"). Missing scripts fail closed.
  PROVEN: harness, real compiler -- the real scripts pass; the vault an
  older compiler would return (same policy, must-sign lists dropped)
  is caught on all three paths. `scripts/test-must-sign-check.mjs`, 4
  cases, twins identical. WALKED: a stand-in old compiler answers ->
  "The vault builder service did not include the must-sign keys for
  Everyday, Backup. Nothing was saved and no address was made." ->
  the draft is still a draft with no address -> Try again with the
  right answer -> finalized.
  Measured: npm test exit 0, 33 suites; lint 0 errors / 11 warnings;
  typecheck 10 = unchanged; build green.

- **Must-sign keys on a path, slice two (everything a person sees) --
  BUILT 2026-11-12, on the branch, NOT on main, awaiting the operator's
  word to ship.** His decisions, by chip: the count is set up front
  when shaping a path; a must-sign key that every path needs is
  allowed with a red warning and a tick; any key may be must-sign,
  with a warning when its seed is in the browser; one piece, shown
  before shipping.
  WHAT CHANGED. One shared description of a vault's paths
  (`netlify/functions/_vault-shape.js` and its twin
  `apps/web/src/lib/vault-spending-paths.ts`, held identical by test)
  now carries `requiredKeys` and the consent group, and decides "is
  this path's rule met" from WHO signed (`pathSignatureStatus`), with
  a step of a relaxing path resolved by name ("kids_1"). Builder
  (`VaultWizard.tsx`): a "Keys that must always sign" count on each
  path card; two groups to fill in the key step; the risk lines
  (`lib/path-risk.ts`) know a must-sign key is required on every step;
  a red card and tick box when one must-sign key is needed by every
  path. Server: `compile-leaves.js` validates and forwards
  `required_keys`; `psbt-binary.js` forwards them and counts them in
  the fee estimate; `psbt-merge.js` decides fully-signed by name;
  `governance.js` counts every signature the path needs;
  `_rotate.js` carries them; `_invite-rules.js` refuses an unconfirmed
  key in a must-sign slot and hides them from an invited person;
  `invites-lookup.js` tells an invited person how many keys must
  always sign. Pages: proposal page and vault page send flow count by
  name and say which must-sign key is missing; path cards, dashboard,
  draft card, rotate screen and check, timelock prompts, trust
  document, backup file, the three PDFs and the assistant's summary
  describe the path in one shared set of words (`lib/path-words.ts`
  and `_path-words.js`, held identical by test).
  TWO DEFECTS FIXED ON THE WAY, both older than this feature:
  (1) "fully signed" was a COUNT of signatures. Two phones on a
  hardware-plus-one-phone path read as ready and then failed at the
  last step; one signer across two coins also read as two. The
  consent group had the same weakness. Now decided by who signed
  every input, in browser and server. (2) The proposal page told the
  holder of a hardware wallet "none of your local keys are signers on
  this vault". It now says the key signs on its own device, or that
  it has signed.
  PROVEN. Offline harness, real compiler + signer: on real PSBTs two
  phones = two signatures and NOT ready, naming the missing must-sign
  key; must-sign key + one phone = ready; a relaxed step keeps its
  must-sign key; browser and server give the same verdict. Handler
  tests: finalize refuses an unconfirmed, doubled or unreadable
  must-sign key. Rotate tests: must-sign keys carried; a successor
  that lost or gained one is refused.
  WALKED at 375px on a production build with stand-in database,
  sign-in and compiler: (a) the count step -- words change as the
  count goes 0 to 1, timeline reads "1 must-sign + 1 of 2", draft
  saved with the count; (b) the key step -- hardware key picked as
  must-sign on two paths, no longer offered among that path's other
  keys, warnings name a 6-year wait computed from the draft, saved,
  left, resumed with the must-sign slot restored, finalized with the
  compiler receiving `required_keys` on the right paths; (c) the
  finished vault's page shows "1 must-sign + 1 of 2 required" and
  "must sign:" on the key; (d) a vault where every path needs one key:
  red card, finalize blocked until ticked, tick clears when the keys
  change; a browser key made must-sign gets its warning; (e) the
  proposal page fed REAL signatures from the real compiler: two phones
  -> "1 / 2 required" and "This path cannot be spent without
  Coldcard"; hardware + phone -> "2 / 2 required" and Broadcast; a
  device that knows none of the keys names the key by fingerprint.
  No overflow, no page errors.
  NOT SEEN: the vault page's own send flow on a must-sign vault; the
  rotate screen on one; the PDFs rendered; the invited person's
  screen; the assistant; any of it on a real phone, the real backend
  or the deployed Fly compiler; a hardware wallet signing.
  NOT in this slice: inviting a person straight into a must-sign
  slot; adding must-sign to an existing vault; the named-field and
  Bloc builders; `protocol/src/governance.rs` (not reached for path
  vaults -- `governance.js` evaluates them itself); consent on a
  path-builder vault in the builder.
  Measured: cargo test --workspace 130 + 39 passed; npm test exit 0,
  32 suites; lint 0 errors / 11 warnings; typecheck 10 = unchanged;
  build green.
  DEPLOY NOTE: reaching main redeploys the Fly compiler
  (`deploy-compiler.yml`). Old vaults keep their addresses (pinned).

- **Must-sign keys on a path, slice one (compiler only) -- BUILT
  2026-11-12, on the branch, NOT on main, nothing visible to a user.**
  Operator: "each leaf could have the and ... the hardware signer and
  whatever the other part of the leaf would be"; decisions by chip: one
  or more must-sign keys per path, and they stay required at every
  step of a relaxing path. `protocol::Leaf` gains `required_keys`
  (default empty); a leaf compiles to
  `and(pk(A),and(pk(B),thresh(quorum,keys...)))`, wrapped by the
  timelock and, on the primary leaf, the consent group as before.
  A key may not be both must-sign and in the quorum pool, nor listed
  twice, nor be its own other-parity twin, nor collide with the consent
  group (one `check_distinct_xonly` over the lists). `expand_decay`
  carries the must-sign keys onto every rung. `find_key_reuse` counts
  them. The compiler service accepts `required_keys` per leaf.
  PROVEN: (1) five existing vault shapes (shared key, decay, relaxing
  "if untouched", consent, single path) compile to the exact address
  recorded from the compiler BEFORE the change, with the field absent
  and with it empty -- pinned in `scripts/offline-vault-harness.mjs`.
  (2) Same harness, real compiler + browser signer + finalizer: 6
  must-sign spends finalize with the right lock_time (two paths
  sharing one must-sign key; a relaxed rung; two must-sign keys on
  one path) and 7 are refused (all the others without the must-sign
  key, on an open path, a dated path and a relaxed rung; the must-sign
  key alone; a must-sign key from another path; one of two must-sign
  keys; both must-sign keys with no quorum); the compiler refuses 3
  malformed policies. (3) 6 new Rust unit tests. (4) Bitcoin Core
  32.1, private chain, 14th check of `scripts/bitcoin-core-proof.mjs`:
  Core derives our exact output script for a must-sign vault, cannot
  complete without the must-sign key or with it alone, and the
  must-sign key plus one other is mined.
  Measured: cargo test --workspace 130 + 39 passed; npm test exit 0,
  31 suites; lint 0 errors / 11 warnings; typecheck 10 = unchanged;
  build green.
  SAFE TO SIT UNUSED: `netlify/functions/compile-leaves.js` forwards an
  explicit list of leaf fields (id, label, keys, quorum, unlock, decay)
  to the compiler, so a must-sign list cannot reach the compiler from
  the app until slice two adds it on purpose.
  NOT SEEN: a hardware wallet reading the descriptor; signet/mainnet.
  FOUND FOR SLICE TWO: `protocol/src/governance.rs` counts a leaf's
  required signatures as `leaf.quorum` (lines 654-690); with must-sign
  keys the true number is quorum + must-sign count, and WHICH keys
  signed matters, not just how many. The server's signature counting
  and fee estimate have the same assumption.
  DEPLOY NOTE: `.github/workflows/deploy-compiler.yml` redeploys the
  Fly compiler when compiler paths reach main. Not pushed to main.

- **A vault spent on a PUBLIC test network with signatures made by
  Bitcoin Core alone -- SEEN 2026-11-11.** Operator asked for a signet
  test. `scripts/signet-core-spend.mjs`: throwaway keys (kept outside
  the repo), a two-path vault from the real compiler, Bitcoin Core
  32.1 running offline in the network's own mode. Core derived the
  same address in signet mode. Four signet faucets refused an
  automated client (bot checks; not worked around), so the operator
  funded the address -- and the coin arrived on TESTNET4, not signet
  (both write addresses as tb1...; found by looking for it on each
  test network). The script took a CHAIN switch and ran there.
  5 checks, all passed on the real run: Core in testnet4 mode derives
  the same address; one signer alone cannot complete; the dated backup
  path, signed by Core 196,013 blocks early, is REFUSED by the public
  network as non-final; the backup path with no locktime cannot be
  completed; the everyday path, signed by two people in two separate
  Core wallets, is ACCEPTED. Spent coin
  ab51349c92f312dd567aab4a996c4a2fbd80bbd01bd7cb61077a64f78d76b70e:1
  (364,351 sats), spend
  e91e318cbe4c826986f7ed93e5c6cd5c012257ea27b01b0d7afd19a57280d2c8,
  read back from the explorer: two 64-byte signatures, locktime 0,
  fee 500, unconfirmed at the time of writing.
  LIMITS: Core was offline (a sandbox cannot reach peers), so the
  explorer supplied the coin's amount and script and carried the
  broadcast; address, signatures and finalizing were Core's. A dated
  path SUCCEEDING is still proven only on the private chain. Signet
  itself saw the address check only, no coin. No hardware wallet.
  Nothing in the app changed.

- **Recovery instructions no longer send families to Sparrow -- FIXED
  2026-11-11.** Every vault backup named Sparrow "the recommended
  recovery path", said Sparrow sets the timelock for you, and said one
  signer's seed is enough to spend. Nobody had seen Sparrow load one of
  these vaults; its release notes (web search, not witnessed) say it
  rejects a Taproot descriptor with a script tree. Operator approved
  the replacement wording and chose "apply it and ship". One source of
  the words now, `apps/web/src/lib/recovery-instructions.ts`: Bitcoin
  Core as the proven path with the nine commands in full and the right
  network flag, that Core does not read seed words, that the locktime
  is set by hand, and "do not count on" Sparrow or Nunchuk. Used by the
  vault backup and the on-chain recovery note
  (`descriptor-backup.ts`); the same substance, shortened, in the
  offline recovery tool (`tools/legacy-recovery/template.html`,
  rebuilt), `pages/DescriptorRetrieval.tsx`, the vault PDF's five steps
  (`netlify/functions/vault-pdf.js`), two teaching lines
  (`lib/literacy.ts` and their copy in `netlify/functions/assistant.js`)
  and `docs/terms-of-service.md`. "At least one signer's seed" is now
  "enough signers' seed phrases to open one path".
  The proof grew to 13 checks: the 13th follows the written steps
  exactly -- listunspent, createpsbt with the locktime, two people
  signing in two separate wallets, combinepsbt, finalizepsbt,
  sendrawtransaction -- on a dated path, mined.
  Mechanism: `scripts/test-recovery-instructions.mjs` (in `npm test`)
  fails if the instructions name a Bitcoin Core command the proof does
  not run, or if a backup recommends Sparrow or Nunchuk again.
  SEEN: a real backup file printed and read; the offline tool opened
  at 375px, new text present, no overflow, no page errors.
  NOT SEEN: the PDF rendered (syntax-checked only; step bodies kept
  under 200 characters to fit their two-line slots, by count not by
  eye); the recovered-descriptor card on the Retrieve page (it only
  shows after a real recovery); Sparrow actually refusing a vault; any
  of the nine commands on mainnet or signet, or with a hardware wallet.
  NOT changed: tranche backups say the steps were tested with a vault's
  descriptor, not a tranche's; older docs under docs/ that mention
  Sparrow as a design intention.
  Measured: npm test exit 0, 31 suites; lint 0 errors / 11 warnings;
  typecheck 10 = the same 10 as before; build green.

- **A vault stands on its own in Bitcoin Core -- PROVEN 2026-11-11 on
  a private test chain.** Operator asked whether Sparrow or Bitcoin
  Core would recognise the same address and signing. New script
  `scripts/bitcoin-core-proof.mjs` (not in `npm test`; needs a Bitcoin
  Core download, run with BITCOIN_BIN set). Bitcoin Core 32.1.0,
  release checksum matched, regtest. A five-path vault with one key on
  three paths, compiled by the real Rust compiler. 12 checks, all
  passed on a real run (11 first, a 12th added the same day): Core derives our exact output script from the
  compiler's raw descriptor AND from the exported
  `[fingerprint/path]xpub/0/0` form; imports it watch-only and as
  wallets holding only some seeds; sees deposits; spends the everyday
  path signing with Core alone (3 signatures); the shared key alone
  completes nothing; the kids path will not complete with no locktime,
  is refused by the network as non-final at height 106, and the same
  transaction is mined at 26,200 signed by the two kids only; a
  backup-path spend built, signed and finalized by OUR compiler and
  browser signer is accepted and mined by Core with change returned to
  the vault; and a spend our compiler built is signed and finalized by
  Core in place of our signer. This is the first time one of our own
  transactions was judged by a real node's consensus rules.
  NOT SEEN: mainnet or signet; a hardware wallet; Core fed a seed
  phrase (it cannot read one -- the test handed it account xprvs);
  Sparrow; Nunchuk; an "if untouched" (relative) path; a decay path.
  12th check, for Nunchuk: the same descriptor with every key written
  ranged (`/0/*`) gives OUR address at index 0 and a different address
  at index 1. Read from libnunchuk `src/descriptor.cpp` through a web
  summary, NOT witnessed in Nunchuk: its key pattern expects an
  optional suffix ending in `*` and it re-builds the descriptor and
  requires a string match, so our fixed `/0/0` keys are the likely
  reason the operator's import failed; the literal unspendable top key
  we use is one it accepts. A ranged copy would let Nunchuk hand out
  addresses at index 1+ and send change there, which this app does not
  watch -- the reason docs/sovereignty-education-bot.md gives for one
  fixed address.
  ALSO FOUND: Sparrow instructions are in more places than the backup
  file -- `tools/legacy-recovery/template.html`,
  `pages/DescriptorRetrieval.tsx`, `netlify/functions/vault-pdf.js`
  (a five-step Sparrow walk-through), `netlify/functions/assistant.js`.
  FOUND, NOT YET CHANGED: the backup file every vault downloads
  (`apps/web/src/lib/descriptor-backup.ts`, two places) and
  `docs/terms-of-service.md` name Sparrow as the recommended recovery
  path and say Sparrow sets the locktime for you. Sparrow's release
  notes, as found by web search today, say it rejects Taproot
  descriptors with a script tree. Not witnessed here. Replacement
  wording shown to the operator before any change.

- **One key on more than one path, with the cost shown as you pick --
  BUILT 2026-11-11, on the branch, NOT on main.** Operator: "let one
  key be chosen on more than one path but let's put the proper warnings
  in place each time they increase the risk ... the consequence being
  known upfront." The compiler always allowed it (keys must be distinct
  within a path, not across paths); the builder's picker hid any key
  once it was used anywhere. For path-builder vaults the picker now
  hides only keys already on THAT path (`VaultWizard.tsx` KeysStep,
  `pickable`); the older named-field and Bloc builders are unchanged.
  New pure file `apps/web/src/lib/path-risk.ts` computes, from the
  draft's own paths, what is shown under each path: for a key on two or
  more paths, which paths stop working for good without it, the soonest
  path that still opens without it and how long that wait is (decay
  steps and "if untouched" paths counted), and that a thief holds one
  signature on each of those paths; and, once a vault mixes a
  public-only key (hardware wallet, other device, Tapit) with keys held
  in this browser, whether each path can open with no separate-device
  key signing, with the number of signers that would make it required.
  One line for the whole vault above the paths. It replaces the vague
  "Heads up: one of the keys picked below is also used in..." line on
  this shape. An invited person's key is treated as "kind unknown", not
  as a hardware wallet. The same key's signing origin is now sent once
  at finalize, not once per path.
  PROVEN: `scripts/offline-vault-harness.mjs` gained a five-path vault
  with one key on three paths against the REAL Rust compiler and real
  signer: 6 spends finalize with the right lock_time (including the
  kids path WITHOUT the shared key) and 3 are refused (all-must-sign
  and backup without the shared key; the shared key on a path it is not
  on). `scripts/test-path-risk.mjs`, 10 cases, in `npm test`.
  WALKED at 375px against a production build with stand-in database,
  sign-in and compiler: hardware key picked on three of five paths; the
  note appears on both paths the moment it is added to the second;
  wording read back from the page; no overflow, no page errors; draft
  saved, left, resumed with every shared slot restored; finalize
  reached "Back up your vault" with the compiler receiving the shared
  key on three paths and 6 distinct origins.
  NOT SEEN: any of it on a real phone or against the real backend; a
  real spend from a vault built this way in the app (the harness
  drives the compiler directly, not the app's spend screens).
  NOT in this slice: a must-sign key joined to a quorum inside one
  path (`and(key, quorum)`) -- that is a compiler change; placing an
  invited person's key on a second path (they are shown one path
  only); the same freedom in the named-field and Bloc builders; a
  warning for two or more keys lost together.
  ALSO: `scripts/test-keystore-passkey.mjs` failed once by chance in
  this run ("mnemonic word found in storage"): the stored record's
  field names (label, network, version) are themselves recovery words.
  The check now looks for two phrase words side by side. 8 of 8 reruns
  of the old check had passed, so this was pre-existing and rare.
  Measured: npm test exit 0, 30 suites; lint 0 errors / 11 warnings;
  typecheck 10 errors = the same 10 before the change; build green.

- **Key lesson and a real password bar -- BUILT 2026-11-11, on the
  branch.** The operator asked whether "generate a new key" should
  walk people through making their own seed (dice), then decided
  against it: "the dice rolls belongs on a seed signer ... it's not
  really something you should do in DynastyTrust. I would like to have
  the education be informative of entropy and a good seed ... I don't
  want to skimp on security ... it's still a hot key." No dice code was
  written. Decisions (chips): teach that a seed must come from real
  randomness; teach AND enforce a stronger password on real-bitcoin
  keys.
  Two facts shaped it: a seed made here is always 256 bits, so its
  strength is not the user's to get wrong (the one way a weak seed
  enters is by being RESTORED); the strength a user does choose is the
  password, and the bar was eight characters of anything, mainnet
  included.
  `lib/password-rules.ts`: a real-bitcoin key needs 12+ characters
  that are not a repeat, a simple run, or built on a first-guess word
  (a long phrase containing one is fine); test-coin keys keep 8.
  Enforced in `keystore.ts` wherever a password is SET
  (generateSoftwareKey, restoreKeyFromWords, secureTestKey,
  changeKeyPassword, passkeyToPassword), so no screen can bypass it; a
  key already locked with a shorter password still opens. The forms
  show a hint as you type (weak / acceptable / strong).
  `lib/key-education.ts` + `components/KeySafety.tsx`: "What makes a
  key safe", six short lessons, shown closed-by-default wherever a key
  is made (Key Manager, the builder's inline key form, the invited
  person's page). It calls a browser key a hot key, says no password
  changes that, says never to choose words yourself, says to make at
  least one key per path a hardware wallet, and points dice-rollers to
  a signing device. The restore form carries a warning that only words
  this app or a signing device generated should be brought in.
  `scripts/test-password-rules.mjs` (6 cases, in `npm test`) pins the
  rule, the enforcement, the old-password case, and the lesson's two
  hard statements plus a list of safety promises it must never make.
  Four older key tests used passwords the new rule refuses ("first-
  password" is built on "password"); their passwords were changed,
  nothing else.
  WALKED at 375px in a production build: the hint through empty,
  short, first-guess, acceptable and strong; a weak mainnet password
  refused with nothing stored; the lesson open; a strong password
  accepted and the key stored encrypted. Not seen on a phone; the
  wording was sent to the operator for review before shipping.
  Measured: npm test exit 0, 29 suites; lint 0 errors / 11 warnings;
  typecheck 10 = baseline; build green.

- **Small, faint type (operator on his phone, 2026-11-11) -- FIXED, on
  the branch.** His words: "The type is pretty small in the explainers.
  Little hard to read fine print. Not sure how big we can go without
  messing everything up." Measured before touching anything: of 927
  inline text sizes, 697 were below 14px; across fourteen screens at
  375px, 610 of 788 visible text elements were under 14px and 226 under
  12px (smallest 10px); and the fine-print grey `colors.muted` (#5A5570,
  319 uses) was 2.7:1 against the card background, where 4.5:1 is the
  floor for body text. So it was small AND faint.
  "How big can we go" was answered by building the site at three size
  levels and measuring every screen: two steps up (9,10->12, 11->13,
  12->14, 13->15, 14->15) broke nothing at 375px; three steps pushed
  the vault page 19px off the side. Operator chose two steps and to
  lighten the grey. Applied by a mechanical rewrite of the inline
  sizes (804 changed, plus three 11.5px the rewrite missed and the new
  check caught); `muted` is now #827D96 (4.5:1 at worst, still quieter
  than `sub`).
  After, same fourteen screens: under 12px 226 -> 0; under 14px 610 ->
  247; smallest 10 -> 12; sideways overflow at 375px 0 -> 0; clipped
  text 4 -> 4. At 320px the vault page ALREADY ran 32px off the side
  (the header's Rotate/Delete row); the name now gives way and it is
  0 (the landing page's pre-existing 4px remains).
  `scripts/test-readability.mjs` (3 cases, in `npm test`) fails on any
  inline text size below 12px, on more than a sliver at 12px, and on
  any text colour under 4.5:1 against any background token.
  NOT covered: screens I could not render with stand-ins (the send
  flow past the form, the builder's later steps, legacy recovery,
  modals) were resized by the same rewrite but not measured; the PDF
  exports keep their own colours. Seen in a desktop browser at phone
  width, not on a phone.
  Measured: npm test exit 0, 28 suites; lint 0 errors / 11 warnings;
  typecheck 10 = baseline; build green.

- **Deploy and evidence record, 2026-11-11 13:00 UTC.**
  Family joins went to main as d19b064. DB deploy run 73 succeeded and
  the three new columns answer on the live REST API; `verify:live`
  PASS against d19b064.
  FIRST BITCOIN CONFIRMATION OF OUR OWN RECEIPT: the calendar receipt
  saved from a live submission on 2026-11-10 (listed under 15c as "not
  yet seen") was upgraded by alice.btc.calendar.opentimestamps.org to
  Bitcoin block 975,362. Replayed with our own reader: our digest
  leads to the calendar commitment, the commitment leads to the block's
  merkle root, and mempool.space and blockstream.info agree on that
  root. That is the whole path, end to end, on a real block. Still not
  seen: the scheduled `ledger-anchor` job itself running on Netlify
  (it was due at 09:17 UTC today; the anchors table cannot be read
  without a member session, so look at the sealed record screen).

- **Family joins with their own keys (J3, with 15e's identity gates) --
  BUILT 2026-11-11, on the branch, NOT on main.** For a vault built
  with the wizard, every key had to come from the owner's own browser
  or be pasted in; invites existed but `compile-leaves.js` never read
  them. An invite was a bearer link: whoever opened it first took the
  slot, and the key details they typed were stored unchecked
  (compiler-review finding A3).
  Operator's decisions (chips): invite tied to the invited email; the
  owner confirms EVERY invited key's fingerprint, test coins included;
  two-step sign-in to join a real-bitcoin vault; a password-protected
  phone key (backup required) or a hardware wallet; before finalize an
  invited person sees their own path only; the owner can still fill
  any slot themselves as before.
  The loop: Keys step -> "Invite someone to hold a key" (name + email)
  -> a link the owner sends -> the person signs in as that address,
  makes the key on their own device and must write its 24 words down
  before Join unlocks -> the owner sees the fingerprint, checks it by
  voice, confirms -> the key fills the slot -> slots are saved to the
  draft as they change ("Save and finish later" used to throw them
  away) -> finalize as before -> the vault appears on each person's
  dashboard.
  Server: migration `20261111010000_invite_paths.sql` (nullable
  columns only: the path on invites and members, confirmed-at/by on
  members). `_invite-rules.js` (pure): `checkPathInvite`,
  `emailMatches`, `joinAllowedAtAal`, `checkClaimedKey` (the signing
  key must be the xpub's own first child, right kind of coin, nothing
  private or malformed -- closes A3 for this flow),
  `unconfirmedMemberKeys` (x-only match, so the 02/03 twin is caught),
  `draftViewForMember`, `draftRosterForMember`. Applied in
  `invites.js`, `invites-lookup.js` (own path only, email masked),
  `invites-claim.js` (all checks BEFORE the invite is consumed),
  `members.js` (owner `confirm_key` bound to the fingerprint on
  record; a confirmed key cannot be changed), `compile-leaves.js`
  (refuses an unconfirmed member key), `vaults.js` (an invited person
  gets only their path of a draft). `key_confirmed` is sealed and
  stamped at once; the email address is never sealed.
  Browser: `components/vault-builder/PathInvites.tsx`,
  `pages/InviteClaimPath.tsx` (replaces, for path invites, a page that
  sent newcomers elsewhere to make a key and called browser keys "for
  testing only"), `components/PathDraftCard.tsx` (replaces "Ready to
  compile / 0 of 0 members joined" and its failing button),
  `lib/path-people.ts`. A draft now remembers how many slots each path
  has (`planned_keys`): resuming used to shrink a 2-of-3 path to two
  slots.
  Tests, all in `npm test`: `test-invite-rules.mjs` (6 cases),
  `test-invite-handlers.mjs` (7 cases: the REAL handlers through the
  whole loop against stand-ins), `test-path-people.mjs` (4 cases).
  The migration applied twice to a throwaway real PostgreSQL 16:
  idempotent, existing rows untouched.
  WALKED at 375px, three browsers against a production build with the
  REAL handlers behind /api (database, sign-in, chain tip and compiler
  stood in): owner's draft card -> fills his slot -> invites Anna -> a
  stranger with the link is refused and the invite survives -> Anna
  sees only her path, makes her key, is forced through the backup,
  joins, is shown her fingerprint -> owner returns, his slot was
  saved, sees the SAME fingerprint, confirms -> finalize reaches
  "Back up your vault" -> the compiled vault holds both keys and both
  hardware-wallet origins -> Anna sees the vault. No page errors, no
  overflow. Ledger: invite_created, member_joined, key_confirmed,
  draft_compiled.
  NOT SEEN: any of it against the real database, real sign-in or the
  real compiler; the two-step refusal in a browser (handler-tested
  only); an invited person SIGNING a spend on a vault made this way
  (ProposalDetail already lists a member's device keys on a leaf-list
  vault, but that was not driven); the hardware-wallet route for an
  invited person; a path with more than one invited person.
  NOT in this slice: emailing the link; changing people after
  finalize; Bloc and older-shape drafts (their invite flow is
  untouched); one key on more than one path; telling people when a
  spend needs them.
  CORRECTION (2026-11-11, later): this entry and my report to the
  operator said the owner can place an invited person's confirmed key
  on a second path. Not true. `PathInvites` offers a member's key only
  on the path they were invited to, and the Keys step's picker removes
  ANY key from its list once it is used on any path
  (`VaultWizard.tsx` `claimed`/`availableKeys`). The compiler itself
  allows the same key on several paths (distinctness is checked per
  leaf); the builder screen does not let you choose it. Found when the
  operator asked whether one hardware key could sit on three of five
  paths.
  Measured: npm test exit 0, 27 suites; lint 0 errors / 11 warnings;
  typecheck 10 = baseline; build green.
  DEPLOY NOTE: the small traps batch went to main as 5a4e7cc;
  `verify:live` PASS.

- **Small traps batch (journey gaps J3-J6, the quick ones) -- BUILT
  2026-11-11, on the branch.** Five places a person got stuck or
  misled, each a small change:
  (1) Home-page sign-up said "we sent a confirmation link"; the email
  carries a 6-digit code and that card had no box for it. The card now
  takes the code (same Supabase calls as `pages/Auth.tsx`), offers
  Resend, mentions spam, and a sign-in that fails with "email not
  confirmed" goes to the code box with a fresh code sent. Errors there
  were raw Supabase text; `friendlyAuthError` moved to
  `lib/auth-errors.ts` and both screens use it. "Email can be a burner"
  is replaced with "use an email you will still have in ten years".
  (2) The draft card's "Copy link" built `/invite?token=...`; the route
  is `/invite/:token`, so the invited person landed on the vault
  builder. One-line fix.
  (3) No way to scan the vault's address: the only QR on the page was
  the descriptor. Added "Show deposit QR" (the address, with its last
  eight characters to compare) and "First deposit? Send a small
  amount, wait until it shows here, then send the rest."
  (4) "N proposals awaiting signatures -> Go to Send" opened a BLANK
  send form. One waiting spend now opens that spend; several open
  History.
  (5) "Cancel" on the signing screen only cleared the form and left
  the spend open in History. It is now "Cancel this spend" and marks
  the proposal cancelled (the server already allows the client to set
  that), with a separate "Leave it open for the others to sign".
  WALKED at 375px in a production build with stand-in services: (1)
  sign-up -> code box -> a wrong code's message -> resend; (3) the QR
  and both notes; (4) the button lands on the proposal. NOT WALKED:
  (2) is read, not clicked through; (5) needs a built spend on screen
  and was not driven -- it is typechecked and read only. None seen
  live.
  Measured: npm test exit 0, 24 suites; lint 0 errors / 11 warnings;
  typecheck 10 = baseline; build green.
  DEPLOY NOTE: rotate went to main as 26abc82; `verify:live` PASS.

- **Rotate for vaults built with the path builder (J2f) -- BUILT
  2026-11-11, on the branch.** A vault's dates are fixed in its script;
  the only way to push an inheritance date out is a new vault with
  later dates and the coins moved. No vault the wizard builds could be
  rotated: the button was hidden and the server refused the shape.
  Operator's decisions (chips): carry the same keys over with a confirm
  step; shift every dated path together; a standing warning on the old
  vault until the coins are moved.
  Server: `_rotate.js` (pure) carries the paths forward changing ONE
  thing, each dated path's wait; `vaults-rotate.js` inserts a leaves
  draft (same row `createLeavesDraft` makes, keys already in place,
  consent rule, key labels, trust doc, predecessor link). Bloc stays
  refused; the named-field branch is untouched.
  Browser: `components/RotatePathVault.tsx` -- pick Keep / +1 / +3 / +5
  years, see each path's old and new date and every key with its name
  and fingerprint, tick to confirm; then rotate -> compile-leaves ->
  TWO checks before the vault is accepted: the compiled heights against
  tip + the chosen wait from two chain sources (the same
  `timelock-check.ts` gate every new vault passes), and
  `rotate-plan.ts`'s `checkRotatedVault`, the compiled successor
  against the old vault field by field (same network, paths, keys in
  order, quorums, step-downs, untouched-for rules, consent rule; a new
  address; no date earlier than before). A refused successor is DELETED
  so the old vault's Sweep button cannot point at it. The new vault's
  own backup must be saved before the dialog lets go. The old vault
  shows the standing warning.
  Tests: `test-rotate.mjs` (4 cases: plan, plan refusals, server
  carry-forward, 15 tampered successors refused);
  `test-rotate-handler.mjs` (3 cases: the REAL handler run against
  stand-ins for sign-in, database and ledger -- what it writes, ten
  refusals that write nothing, and the named-field branch unchanged).
  Both in `npm test`.
  WALKED at 375px in a production build with stand-in services: plan,
  gating on the confirm tick, create, the backup gate and download,
  the old vault's warning and Sweep button; and a server that swaps a
  key -- refused, deleted. The walk caught two things, both fixed: the
  old vault showed no warning or Sweep button until reloaded (the
  banner looked its successor up once), and a refused successor stayed
  linked.
  NOT SEEN: any of it against the real backend or the real compiler
  in this flow (compile-leaves itself is unchanged and the offline
  harness covers leaf-list compile and spend); a real sweep between a
  real pair of vaults. Walk it on signet before trusting it with coins.
  NOT in this slice: Bloc rotate; changing signers or quorums while
  rotating; moving the coins automatically; telling other signers;
  re-publishing long-horizon recovery (the dialog says to); cleaning
  up a draft left behind if the dialog is closed after a failed
  finalize (it can be finished from the draft, or deleted).
  Measured: npm test exit 0, 24 suites; lint 0 errors / 11 warnings;
  typecheck 10 = baseline; build green.
  DEPLOY NOTE: the path-builder inheritance prompts went to main as
  89d2a07; `verify:live` PASS against that commit.

- **The inheritance moment for vaults built with the path builder --
  BUILT 2026-11-11, on the branch.** The J2 fixes below covered only
  the older named-field shape; the wizard builds leaf-list vaults,
  which have no heir role at all, so nothing told anyone a dated path
  had opened. `timelock-words.ts` gains `pathMoments`: "is it mine and
  is it open?" is answered by the keys on THIS device (x-only match,
  so the 02 and 03 forms of a key are one signer). A dated path that
  has opened raises "<path> is open" with the steps, only on a device
  holding one of its keys; a dated path within about six months raises
  a heads-up for everyone. Both prompts, and the named-field heir
  prompt, now open Send ON that path (`SendPrefill.path`) instead of
  leaving the person to find it in a dropdown. The "Next to open" line
  gives the estimated date and says it is fixed.
  FOUND, not fixed: rotating a leaf-list vault is refused by
  `vaults-rotate.js` ("isn't supported yet"), so for every vault built
  today the only way to push a date out is to build a new vault by
  hand and move the coins; the heads-up says exactly that.
  CORRECTION (same day): this entry first said the Rotate button opens
  its dialog on such a vault and then fails. Wrong -- I had read the
  server's refusal and not the button. `VaultDetail.tsx` hides Rotate
  on leaf-list and Bloc vaults, so there is simply no button; the
  server refusal is the backstop behind it.
  `test-timelock-words.mjs` now 5 cases. WALKED at 375px in a
  production build with a fabricated vault and fixed tip: far from the
  date, three months out, open with none of the path's keys here (no
  prompt), open with one here (prompt, and Send opens on "The kids"),
  and the named-field heir (Send opens on Inheritance); no page errors
  or overflow. NOT SEEN live or on a real vault.
  Measured: npm test exit 0, 22 suites; lint 0 errors / 11 warnings;
  typecheck 10 = baseline; build green.
  DEPLOY NOTE: the J2 fixes went to main as 4310a74; `verify:live`
  PASS against that commit.

- **The inheritance moment (journey gap J2) -- BUILT 2026-11-11, on the
  branch.** Every timelock on a named-field vault is an absolute block
  height; four screens said otherwise or said nothing.
  (a) The vault page's Path 3 card read "Triggered only if the trustees
  are unreachable for the full window" -- false: the path opens at that
  block whatever anyone does. It now says so, and that the only way to
  keep it closed longer is to rotate and move the coins. The founder's
  hint "If trustees go silent ..., the recovery path opens" had the same
  false premise and is corrected.
  (b) The Dashboard turned the absolute height itself into a duration:
  an heir saw "~18yr" that never moved and never said open. The same
  bug sat on the Recovery line and on custom-path lines of every vault
  card. The Dashboard now fetches the tip per network and counts from
  the blocks LEFT; with no tip it says nothing rather than something
  wrong.
  (c) When the inheritance opened, the heir's one prompt DISAPPEARED
  (it was only built while blocks remained). There is now a "The
  inheritance path is open" item with the steps and a button to Send,
  and the phase card's hint spells the steps out, including restoring
  a key from its words if it is not on this device.
  (d) A founder was never told the inheritance date: the phase card now
  always states it and what it means, and from about six months out
  the action guide raises it.
  (e) Rotate defaulted to the time remaining, which keeps the SAME
  date, and never said rotating is how you push inheritance out. The
  dialog now states the estimated date for the number in the box,
  whether that is the same, later or earlier than this vault, and
  offers Keep the same date / +1 / +3 / +5 years.
  One source for the words: `lib/timelock-words.ts` (pure; tip and
  clock are arguments), `scripts/test-timelock-words.mjs` (4 cases, in
  `npm test`). WALKED at 375px in a production build with a fabricated
  vault and a fixed tip: dashboard as heir before and after the date,
  vault page as heir before and after, as founder three months out,
  and the rotate dialog; no page errors, no horizontal overflow; read
  from the rendered text, not judged by eye. NOT SEEN: on the live
  site, or against a real vault whose date has passed.
  NOT in this slice: vaults built today are leaf-list shaped and have
  no "heir" role tied to a path -- they still show the generic
  "Currently spendable / Next to open" text; preselecting the
  Inheritance path when the heir lands on Send; any alert that reaches
  someone who is not looking at the app (J4).
  Also: `verify-live-bundle.mjs` now reports a deploy landing mid-check
  as such instead of FAIL (seen twice this day; that branch of the
  script is syntax-checked only, not exercised).
  Measured: npm test exit 0, 22 suites; lint 0 errors / 11 warnings;
  typecheck 10 = baseline; build green.
  DEPLOY NOTE: restore-from-words went to main as 6262974;
  `verify:live` PASS against that commit.

- **Restore a key from its written words -- BUILT 2026-11-11, on the
  branch.** Found by walking the whole family journey screen by screen
  (see `docs/security-backlog.md`, "Journey gaps"): the app made people
  write 24 words, verified they had, and then had NO place to type them
  back in. "Restore" in the Key Manager only un-archived a key; "Import
  JSON" carries public keys only; ProposalDetail told a signer to
  "import that seed on this device" when no such thing existed. A
  cleared browser or a new phone lost the signer from the app for good,
  for a founder and, years later, for an heir.
  `keystore.ts`: `restoreKeyFromWords` runs the phrase through the same
  derivation a new key uses and stores it the same two ways (password-
  encrypted; plain text on test coins only -- mainnet without a password
  is refused). A public-only row for the same key (the new-phone state
  after Import JSON) is upgraded in place with its name kept, matched on
  either kind of coin so a forgotten network is not a trap. One set of
  words is kept in a browser once: the first test run showed the same
  words could otherwise sit in plain text under a test entry beside
  their real-money twin, and that is now refused by design.
  `inspectRecoveryWords` drives the form: a word count and the first
  word that is not a recovery word, as the person types; a pasted
  numbered list reads the same as plain words. Key Manager: "Restore
  from words", a standing note that keys live only in this browser and
  that Export JSON is not a backup of the words, and the same sentence
  on the key-created prompt.
  `scripts/test-keystore-restore.mjs` (7 cases, in `npm test`): a
  mainnet key lost and restored is the same xpub, signing pubkey and
  both fingerprints; the standard BIP39 test phrase restores to its
  published master fingerprint 73c5da0a; misspelt, missing and swapped
  words, no password on mainnet, and repeats are refused with nothing
  stored. WALKED at 375px in a production build with fabricated
  services: live feedback, restore, the row and its fingerprint, the
  refused repeat; no horizontal overflow. NOT SEEN: on a real phone,
  or a restored key signing a real spend (the signer derives from the
  same stored words, and reveal re-checks them against the xpub).
  NOT in this slice: BIP39 passphrases; restore inside the invite or
  wizard flows; telling the person which vault the restored key signs.
  Measured: npm test exit 0, 21 suites; lint 0 errors / 11 warnings;
  typecheck 10 = baseline; build green.
  DEPLOY NOTE: the sealed record screen went to main as b4ed42d;
  `verify:live` PASS against that commit.

- **Sealed record screen (15d) -- BUILT 2026-11-11, on the branch.**
  Until this there was no way for anyone, the operator included, to
  LOOK at the ledger: the tables are readable only through
  `vault-ledger.js` with a member session and no page called it.
  `/vaults/:id/record` (`pages/VaultLedger.tsx`, button "Sealed record"
  on the vault) shows every entry in plain words, who and when, and
  whether it is proven in Bitcoin, holds a receipt, or is waiting.
  The verdict on the page is the BROWSER's, not the server's:
  `lib/ledger-verify.ts` is a second implementation (noble hashes +
  Uint8Array, no Buffer) that re-walks the chain, replays every
  OpenTimestamps proof, and matches it to the real block fetched from
  mempool.space and blockstream.info, which must agree. The server's
  verdict is a second opinion and a disagreement is itself shown.
  "Save a copy" downloads every row plus how to check it without us.
  `scripts/test-ledger-verify.mjs` (6 cases, in `npm test`) holds the
  two implementations to the same answer in the same words on honest,
  altered, removed, reordered, re-hashed, cut-off and forged records,
  and replays the reference client's proof to block 358,391.
  FOUND AND FIXED on the way: `verifyAnchors` treated a block the
  caller had not looked up as a failure, and `vault-ledger.js` looks up
  only the newest 12 -- so a vault with more than 12 stamped blocks
  would have gone red for no reason. Reproduced in `test-anchor.mjs`
  first; a height with no key is now counted in `blocksUnchecked`, a
  key with an empty value (lookup tried and failed) is still a problem.
  WALKED at 375px against a production build with fabricated data and
  every outside service intercepted (honest, empty, altered with a
  lying server, tail cut off, chain sources down): no horizontal
  overflow, expand and download work. The walk caught the page saying
  "Proven in Bitcoin" in green when the block could not be fetched;
  it now says the proof is held but unchecked, in orange. NOT SEEN:
  the page against the real backend with a real sealed entry.
  NOT in this slice: signatures on entries (15b is not built).
  ALSO FOUND, not fixed: `npm run dev` is broken since opentimestamps
  was removed from tapit-attest -- its dist still imports it
  (`anchor/opentimestamps-provider.js`); production builds tree-shake
  it and are unaffected. Backlog item 16.
  Measured: npm test exit 0, 20 suites, 71 harness checks; lint 0
  errors / 11 warnings; typecheck 10 = baseline; build green.

- **Bitcoin anchoring of the ledger via OpenTimestamps -- BUILT, on the
  branch (2026-11-11).** Backlog 15c. Operator: "each stage submitted
  to the open time stamps ... always checking against the open
  timestamps hash that cannot be changed"; chose "at milestones +
  daily". What a hash chain cannot detect by itself is its most recent
  entries being cut off, or the whole chain being replaced with
  another consistent one by whoever controls the database. An anchor
  closes that. `netlify/functions/_ots.js`: our own reader for the
  OpenTimestamps wire format (no `opentimestamps` npm package -- that
  is the one whose `request` chain carried two criticals), the
  domain-separated `anchorDigest(vault, position, entry hash)`,
  `submitToCalendar`, `fetchUpgrade`, `matchesBlock`, and `toOtsFile`
  so any standard OTS tool can check a proof without us. Only a
  32-byte hash ever leaves the server. `_anchor.js`: `anchorTip`
  (submits the tip to two calendars once each; one being down does not
  stop the other), `upgradePending` (asks the calendar, replays the
  proof, and records it ONLY if it matches the real block's merkle
  root from two independent chain sources), `anchorAllUnanchored`,
  `isMilestone` (vault created, script finalized, spend broadcast,
  member joined/removed, rotation, deletion), and pure `verifyAnchors`.
  `recordEvent` anchors milestones at once, best effort and bounded;
  new scheduled function `ledger-anchor.js` (09:17 UTC daily, in
  `netlify.toml`) sweeps the rest and upgrades receipts.
  `vault-ledger.js` now returns the anchors and their verification,
  looking the claimed blocks up itself and saying `blocksChecked:
  false` rather than showing a pass when the chain cannot be reached.
  Migration `20261111000000_vault_ledger_anchors.sql`: insert-only for
  every role, members read. TWO DEFECTS CAUGHT BY THE TESTS, both
  mine: (1) `verifyAnchors` first accepted a Bitcoin proof row without
  requiring it to connect, through a verified calendar receipt, back
  to OUR digest -- a valid proof of something else would have counted;
  now the whole path digest -> receipt -> commitment -> block must
  hold. (2) The migration's commitment pattern used `{2,400}`, which
  Postgres rejects (limit 255); only running it on a real Postgres
  showed that. Proof: `scripts/test-ots.mjs` replays the reference
  client's published "Hello World!" proof to the merkle root of
  Bitcoin block 358,391 and shows a different document, a different
  block, or one flipped bit all fail (5 cases);
  `scripts/test-anchor.mjs` (6 cases) shows a cut-off tail and a
  swapped chain both fail their anchors; `test-ledger-db.sh` grew a
  6th group on the anchors table against real PostgreSQL 16; and a
  digest was submitted to both live calendars and parsed. NOT YET
  SEEN: one of our own receipts upgrading to a Bitcoin block (hours;
  a live receipt from this session is saved to check), the scheduled
  job firing on Netlify, any of it against the real Supabase project.
  Measured: npm test exit 0, 19 suites; ledger-db 6 groups; all
  functions bundle; lint 0 errors / 11 pre-existing warnings;
  typecheck 10 = baseline; build green.
  DEPLOY STATE OF 15a, recorded honestly: its code is live on main
  (55d04f1, site verified) but its migration did NOT apply -- the
  "Supabase DB deploy" job fails with HTTP 401 "Invalid access token"
  (the `SUPABASE_ACCESS_TOKEN` secret has expired; the same job failed
  on the two earlier pushes that day, unnoticed because they carried
  no migration). Production therefore logs "NOT SEALED" and carries
  on, exactly the fallback `recordEvent` was given. Waiting on the
  operator to replace the token.
  DEPLOYED 2026-11-11 00:30-00:40 UTC: the operator replaced the token
  (first attempt stored the project's legacy JWT secret by mistake --
  the job answered "JWT could not be decoded"; the second was a real
  account access token). DB deploy run 65 applied
  `20261110230000_vault_ledger.sql` ("1 applied, 47 already up to
  date"); 15c went to main as 29f3f8d and run 66 applied
  `20261111000000_vault_ledger_anchors.sql`; both tables answer on the
  live REST API. Gates re-run before the push: npm test exit 0 (19
  suites, 71 harness checks), lint 0 errors / 11 warnings, typecheck
  10 = baseline (no web source in the diff), build green.
  `verify:live` PASS against 29f3f8d. (One run during the deploy
  window reported a mismatch against 55d04f1: version.json was read
  before Netlify switched and the assets after; the re-run passed.)
  STILL NOT SEEN: a real entry sealed or anchored in production --
  the tables are unreadable without a member session and there is no
  ledger screen yet (15d) -- nor the scheduled job firing.

- **Sealed ledger: the vault's record is now hash-chained and
  append-only -- BUILT, not yet shipped (2026-11-10).** Backlog 15a.
  Operator: "the chain of actions all the way from the beginning to
  the end ... tamper evident ... records of every single thing."
  Grounded first: `vault_events` was an ordinary table -- nothing
  linked one row to the next, and its original policy (`for all using
  auth.uid() = user_id`) let any signed-in user UPDATE or DELETE their
  own event rows straight from the browser, so the record could be
  changed with no trace. Built:
  `supabase/migrations/20261110230000_vault_ledger.sql` -- table
  `vault_ledger` where each entry's `entry_hash` is sha256 over the
  previous entry's hash, the vault, the sequence number, the time, the
  actor, the event type and the exact canonical JSON of the details
  (stored verbatim so anyone can recompute it from the row alone).
  Rows enter only through `append_vault_ledger()`, which takes a
  per-vault lock, checks the entry really extends the current tip, and
  RECOMPUTES the hash itself; a trigger refuses UPDATE, DELETE and
  TRUNCATE for every role including the service role; `vault_id` is
  deliberately not a foreign key so deleting a vault cannot erase its
  history; members may read, nobody may write from the browser. The
  same migration makes `vault_events` read-only from the browser.
  `netlify/functions/_ledger.js`: `canonicalJson`, `ledgerEntryHash`,
  `verifyLedger`, `nextLedgerEntry`, `appendLedger` (retries a lost
  race from the new tip), `recordEvent`. All 25 places the server wrote
  an event (19 functions) now call `recordEvent`, which writes the
  timeline row AND seals a ledger entry; every metadata block was read
  to confirm no secret enters a ledger all members can read. New
  `netlify/functions/vault-ledger.js` returns a vault's entries and the
  server's verification to any active member. Deliberate choice: if
  the ledger write fails the action still completes and the failure is
  logged loudly -- a spend that already happened must not be reported
  as failed -- which also means the functions keep working if they
  deploy before the migration applies. PROOF, the part that matters:
  `scripts/test-ledger-db.sh` starts a throwaway REAL PostgreSQL 16,
  applies the migration (twice -- idempotent), and shows: the
  database's hash equals the JS hash on awkward text; a fork, a gap, a
  wrong previous hash and contents that do not match the hash are all
  refused; UPDATE and DELETE are refused for the service role AND the
  database owner; TRUNCATE is refused; a signed-in browser can neither
  insert nor call the append function; an active member can read and a
  removed one cannot; old event rows can no longer be edited or
  deleted from the browser; and an edited, removed or reordered entry
  in a copied dump fails `verifyLedger`. Passed on its first run.
  `scripts/test-ledger.mjs` (6 cases, in `npm test`) pins the hash to
  a known answer independently reproduced with `sha256sum`. HONEST
  LIMITS: a chain alone cannot detect its own TAIL being cut off --
  that needs the external anchor (15c); vaults that exist today have
  no sealed history before this ships; not exercised against the real
  Supabase project (its migration runs on push to main); no screen
  yet (15d). Measured: npm test exit 0, 17 suites; ledger-db 5 groups;
  all functions bundle; lint 0 errors / 11 pre-existing warnings;
  typecheck 10 = baseline; build green.

- **Correction and deploy record (2026-11-10).** The supply-chain entry
  below says `deploy-compiler.yml` "does not trigger on `Cargo.lock`
  alone" and that the Fly compiler would keep the older crates. That
  was WRONG: the workflow's path list includes `Cargo.lock`; only its
  first three lines had been read. The operator was asked whether to
  redeploy the compiler, chose "leave it" on the strength of that
  claim, and the compiler redeployed anyway with batch 1aee98f at
  21:34 UTC (Actions run 31, success). No harm -- same code, two
  patched crates, 163 Rust tests green -- but a deploy of the
  money-touching compiler happened against an operator decision
  because of an unverified statement. Lesson, already doctrine:
  read the whole file before asserting what it does. Deploy record
  for the compiler review fixes: commit 5a0efa6, site live 21:53 UTC
  and verified byte-identical to source by `npm run verify:live`; Fly
  compiler deployed 21:54 UTC (Actions run 32, success), `/health`
  200. NOT verified: the live compiler refusing the review's attack
  requests -- that needs `COMPILER_SECRET`, which this sandbox does
  not and should not hold; it rests on the deploy succeeding with code
  the harness proves.

- **Compiler review: three ways to build a vault weaker than it looks,
  fixed (2026-11-10).** A read-only adversarial review of how we drive
  rust-miniscript and rust-bitcoin, allowed to run the real compiler.
  It reported thirteen findings; the three worst were reproduced by
  the orchestrating session against the real binary BEFORE anything
  was changed, shown to the operator, and fixed as one slice at his
  direction. None lets a stranger take coins from a vault built
  normally with honest co-signers; each let someone build, or trick
  an owner into building, a vault whose real rules were not the ones
  on screen. (A1) `02..X` and `03..X` are different 33-byte keys but
  the SAME 32-byte key inside a tapscript. miniscript's
  `DuplicatePubKeys` compares the 33-byte form, and none of our four
  validators deduplicated, so `/compile` accepted founders `[K,
  twin(K)]` quorum 2 and the reviewer spent it with ONE signature in
  both witness slots. Same for heirs, for a consent key that is a
  founder's twin (voiding the gate), custom leaves, Bloc parent/kid,
  tranche trustees -- and for an invited co-signer submitting the twin
  of another member's key. New `check_distinct_xonly` in
  `protocol/src/policy_compiler.rs`, called by `verify`,
  `verify_leaf_policy`, `verify_bloc` and `build_tranche` over every
  set of keys counted together in one leaf (founders+consent,
  parents+kids, each list, primary leaf+consent). The same person in
  two DIFFERENT leaves (a founder who is also an heir) stays allowed.
  (A2) `verify_leaf_policy` capped a relative wait at
  `MAX_RELATIVE_BLOCKS` on the base leaf only; `expand_decay` then
  added `rung * step_blocks` unchecked and `compiler/src/main.rs` cast
  the result `as u16`. A ladder from 60,000 with step 5,536 compiled
  `older(65536)` -- zero blocks under BIP 68's 16 bits -- so a 2-of-3
  meant to take over a year was open when the coin confirmed; a
  larger step set the time-type flag. Every expanded rung is now
  validated (1..=MAX_RELATIVE_BLOCKS for `older`, a real height for
  `after`), a stepping ladder needs `step_blocks > 0`, and the cast is
  `u16::try_from` with an error. (A4) Bitcoin reads an nLockTime of
  500,000,000 or more as a calendar date; `after(500000001)` is a date
  in 1985, already satisfied, while the record and governance view
  would say locked for millennia. New `LOCKTIME_THRESHOLD` /
  `check_height` in all four validators including the last rung of the
  Bloc kids ladder; and `_chain.js` `checkTimelockFloor` gained
  `MAX_TIMELOCK_OFFSET_BLOCKS` (5,256,000, about 100 years) so the web
  tier refuses first. Every fix is a refusal of an input that should
  never have been accepted: no existing honest vault changes, and all
  163 pre-existing Rust tests pass untouched. Proof: a "compiler
  review" section in the harness sends the reviewer's exact requests
  to the real compiler -- 13 refusals (six twin-key shapes, three
  decay shapes, four height shapes) and 2 must-still-compile cases (a
  founder who is also an heir; an honest 30000/40000/50000 ladder) --
  harness now 71 checks. Measured: npm test exit 0, 16 suites; cargo
  test 124 + 39; release build of the compiler clean; lint 0 errors /
  11 pre-existing warnings; typecheck 10 = baseline; build green. The
  ten remaining findings are listed in `docs/security-backlog.md` 8e,
  in fix order; the next is A3 (a co-signer's derivation path can
  rewrite the stored descriptor).

- **Adversarial review of the signing path: 7 findings, all fixed --
  including one in code written two days earlier (2026-11-10).** A
  fresh-eyes read-only review was asked one question: not whether the
  crypto libraries are sound, but how WE call them and what hostile
  input reaches them. It demonstrated its findings with scripts; each
  was re-read in the code before being changed. (A1, the only one that
  could lose funds) `importKeyringJson` spread every field of every
  entry into the keyring. A keyring file altered between two people
  could carry a co-signer's real xpub, label and fingerprint with an
  ATTACKER'S `pubkey` -- and `pubkey` is the field `toPubkeyHex` hands
  the compiler, so a vault would be compiled with the attacker's key in
  that seat while the screen showed the right xpub. It also accepted
  planted seeds, reset `compromised` to `active`, and added duplicate
  ids. Rewritten from a whitelist: pubkey and fingerprint are
  RECOMPUTED from the xpub with the network's versions (the file's
  values are ignored), no form of seed is accepted from a file, an
  entry arrives as `imported_xpub` (it has no seed here), marks
  survive, ids are de-duplicated. `repairPubkeys` now passes network
  versions -- without them every tpub threw and was silently skipped,
  so signet/testnet keys were never repaired. (A2) My own
  `_psbt-verify.js` from 11b read the leaf scripts from the SUBMITTED
  PSBT: a member could attach invented leaves naming fresh keys, sign
  them, and be counted as three signers; and `mergePsbts` kept the
  first entry per (key, leaf) unverified, so garbage filed under a
  co-signer's key shut their real signature out while
  `countSignatures` counted it. Fixed in one place and used by all
  three callers: `packages/bip341-psbt-signer` gains `leafScriptKeys`
  / `leafNamesKey` (walks the script opcode by opcode),
  `leafCommitsToOutput` (BIP 341 control-block check: merkle root ->
  tweak -> output key == the coin's scriptPubKey) and
  `verifyTapScriptSig`. The server now takes leaves ONLY from the
  proposal's stored PSBT, requires one to exist, and refuses a
  submission containing ANY signature that does not verify; the
  browser merge and count keep only verified signatures. (A3)
  `signPsbtWithMnemonic` matched our key by hex substring and never
  checked the leaf was part of the coin; it now requires the key to be
  a real pushed key and the leaf to commit to the input's
  scriptPubKey, and refuses the whole PSBT otherwise. Signing is also
  refused when the vault has no address on file (the own-coins check
  used to be skipped). (A4) `parsePsbt` is strict: valid hex only, no
  duplicate keys in any map, exact key lengths, bounds-checked
  witness-utxo, nothing after the last map. (A5) `revealMnemonic` now
  derives the signing pubkey from the decrypted seed and refuses on a
  definite mismatch with the key's xpub -- a blob moved or planted
  under another key no longer unlocks silently. (A6) New password
  blobs use 600,000 PBKDF2 rounds (OWASP's SHA-256 figure; 210,000 was
  their SHA-512 one) with the count stored in the blob; blobs saved
  before still open. (A7) `exportKeyring` strips the passkey
  ciphertext too. Checked by the review and found SOUND, recorded so
  it is not re-litigated: the BIP 341 sighash field by field; that a
  lied-about amount or script yields a useless signature, not a
  spendable one; verify-then-sign uses the same bytes in all three
  flows; Schnorr nonces; attestation domain separation; key
  generation; nonce and salt handling. Proof: the harness grew an
  "adversarial" section replaying the review's own attacks against the
  real compiler and signer (invented-leaf signatures count for nothing
  on server and browser; garbage submitted first no longer blocks the
  real signature and the proposal still finalizes; a planted leaf
  naming our key is refused before signing; key bytes inside a data
  push are not our key; trailing bytes, non-hex and duplicate keys
  refused) -- harness now 56 checks, and every earlier spending path
  still signs and finalizes under the new control-block check, which
  is itself evidence that check is right for every vault shape. New
  `scripts/test-keyring-import.mjs` (6 cases) in `npm test`. The
  shared package's own parity tests 4/4. Measured: npm test exit 0,
  16 suites, 100 checks printed; lint 0 errors / 11 pre-existing
  warnings; typecheck 10 = baseline (two errors I introduced were
  caught by the gate and fixed); build green. NOT exercised: the
  server functions against a live database; a real hardware wallet
  against the stricter parser.

- **Supply-chain defenses: known answers, Rust gate, strict installs,
  and proof the live site is this source (2026-11-10).** Operator,
  after reading about AI-found bugs in widely used libraries: where
  are we exposed through other people's proven code, and is it smart
  to re-audit it? Measured surface: ~180 shipped npm packages, ~167 in
  the functions, 94 Rust crates. Four defenses, all four chosen by the
  operator. (1) `scripts/test-known-answers.mjs` + vendored
  `scripts/vectors/` (from github.com/bitcoin/bips): all 19 official
  BIP 340 vectors through the same `@noble/curves` `schnorr` the
  browser signs with (8 signatures reproduced byte for byte, 9
  accepted, 10 correctly refused); the 7 official BIP 341 wallet cases
  through OUR `tapLeafHash`/`taggedHash` (12 leaf hashes, every merkle
  root, tweak and output key); and, because BIP 341 publishes no
  script-path sighash vector, our `tapscriptSighash` against an
  independent implementation (`@scure/btc-signer`'s
  `preimageWitnessV1`) on the official 9-input transaction -- 36
  digests identical. Passed on its first run. (2)
  `scripts/audit-rust.mjs`: reads `Cargo.lock` and asks the OSV
  database (mirrors RustSec) about every locked crate; fails on
  vulnerabilities and "unsound" advisories, prints "unmaintained";
  UNVERIFIED and non-zero when offline. No cargo-audit install needed.
  Its FIRST run found three: anyhow 1.0.102 (unsound
  `Error::downcast_mut`), tokio 1.50.0 (unsound `AsyncFd`
  constructors), pin-utils (unmaintained). We call neither affected
  function (grepped), but both were updated with `cargo update -p
  anyhow -p tokio`; rust-bitcoin 0.31.2 and miniscript 11.2.3
  untouched; 124 protocol + 39 compiler tests and the 47-check harness
  green on the new lock. NOT done: `deploy-compiler.yml` does not
  trigger on `Cargo.lock` alone, so the compiler running on Fly keeps
  the older crates until its next deploy -- left for the operator,
  since it deploys the money-touching compiler. (3) Every dependency
  range in `apps/web`, `netlify/functions`, `packages/*` and
  `tapit-attest` pinned to the exact installed version (55 ranges),
  and `netlify.toml` now runs `npm ci` for the root and tapit-attest,
  so production installs exactly the lockfile. Proven by running the
  exact Netlify command in a clean copy of the tree (exit 0);
  tapit-attest 73/73. Root and functions lockfiles: zero resolved
  version changes; tapit-attest's dev-only tooling moved a few patch
  versions. (4) `scripts/verify-live-bundle.mjs` (`npm run
  verify:live`): reads the commit the live site says it is, builds
  that commit from scratch in a throwaway worktree with the Netlify
  command, reads the three public build settings out of the live
  bundle itself, and compares every file. First run against
  production: index.html, the JS bundle, the CSS and the lazy chunk
  all BYTE-IDENTICAL to a clean build of d9e7548 -- under Node 22
  locally vs Node 20 on Netlify, so the build is reproducible. Getting
  there took two honest misses (the live Supabase URL has a trailing
  slash; a third public setting, the Tapit wallet URL) -- each shown
  by diffing the two bundles, not guessed. Measured: npm test exit 0,
  15 suites, 85 checks printed; lint 0 errors / 11 pre-existing
  warnings; typecheck 10 = baseline; build green.

- **Deleting a key now needs its name typed and the key unlocked
  (2026-11-10).** Operator, walking production on a phone: "you can
  edit name of key with no password." Grounded before answering: Edit
  calls `renameKey`, which changes the label only -- signing is bound
  to the key, never its name, so that is harmless and the operator
  chose to leave it open. But the button beside it was not harmless:
  `handleDelete` in `KeyManager.tsx` took ONE Confirm tap and no proof
  of anything, and would delete a mainnet key marked NOT BACKED UP
  (the operator's own key in the screenshot) -- a wrong tap, or anyone
  holding the unlocked phone, and a key whose phrase was never written
  down is gone forever. Operator chose "password + type the name". New
  `deleteKeyVerified` in `lib/keystore.ts`: a key protected by a
  password or passkey must be UNLOCKED to be deleted (a wrong password
  throws, nothing is removed); keys with nothing to unlock delete
  directly. `handleDelete` now asks for the key's name typed exactly
  (the existing prompt `matchValue` guard), states in capitals when the
  key is not backed up, then asks for the password; passkey keys get
  the device prompt. Proof: `test-keystore-mainnet.mjs` case 6 (wrong
  password and no password both refuse and the key survives; right
  password deletes; an unprotected key deletes directly; unknown id
  throws). NOT walked: the two prompts on a phone. Also witnessed by
  the operator the same day and recorded as evidence: two-step sign-in
  turned on against the real account in production, and after signing
  out and back in the code screen appeared and let him in (backlog
  item 10's enroll + challenge path, verified live). The server's
  factor lookup stays fail-open for now: his walk proves the browser
  path, but an aal2 session skips the server lookup entirely, so that
  lookup has still not been seen to succeed.
  Measured: npm test green, lint 0 errors / 11 pre-existing warnings,
  typecheck 10 = baseline, build green.

- **Audit follow-ups (11b): four of six closed (2026-11-10).** (1)
  `proposals.js` PATCH accepted any valid status from a request body,
  so a member could mark a proposal `signed` with no signatures or
  lock its record as `fulfilled` with no payment. Every client call
  site was read first: the app only ever sets `broadcast` and
  `cancelled` (`signed` is set server-side by `psbt-merge` from the
  real signature count; nothing sets a proposal `fulfilled`), so a
  client may now set only those two. (2) `signer-sessions.js` stored
  any hex as a signature. New `netlify/functions/_psbt-verify.js`
  (`verifySignedPsbt`) uses the same shared BIP341 package the browser
  signs with: the PSBT must parse, be the SAME unsigned transaction as
  the proposal's stored PSBT, and carry at least one BIP340 signature
  that verifies over the BIP341 sighash for a key named in its leaf
  script. Deliberately NOT "signed by the caller's registered key": an
  owner holding several of a vault's keys signs with each under one
  membership, and hardware/Tapit signatures are relayed by whoever
  collected them -- that stricter rule would have broken the
  operator's own flow. `@dynastytrust/bip341-psbt-signer` declared in
  `netlify/functions/package.json` as a `file:` dependency, the same
  way tapit-attest already is. (3) `distribution-wallets.js`: a tranche
  txid a non-owner fills in must be a real transaction on
  mempool.space that pays (funded) or spends from (claimed) that
  tranche's address (`txMatchesTranche`, `newlyFilledTxids` in
  `_authz.js`). (4) Sign-in challenge consumption made atomic in
  `wallet-signin-verify.js` and `wallet-link.js` (`update ... where
  consumed_at is null` returning the row; no row, refused). Checked
  and found already fine: challenge expiry is enforced inside
  tapit-attest's `verifySignIn`. Left open on purpose: post-compile key
  edits in `members.js` and binding a challenge to its requester --
  both design decisions -- and the move to JWT + RLS. Proof: the
  harness grew a "server signature check" section against PSBTs from
  the real compiler signed by the real signer (real signatures
  accepted and counted 1 then 2; a timelocked-path signature verifies;
  "00", an unsigned PSBT, a genuine signature for a different
  transaction, and a corrupted signature all refused) -- harness now 47
  checks; `test-authz.mjs` grew an 8th case for the tranche rule; all
  five changed functions bundle as Netlify builds them. Same honest
  limit as the audit itself: the handlers were not exercised against a
  live database. Measured: npm test green, lint 0 errors / 11
  pre-existing warnings, typecheck 10 = baseline, build green.
  Also recorded here: production deployed the security batch plus
  two-step sign-in and passkey keys at 2026-11-10 21:00 UTC
  (`version.json` 1154882) after the operator relinked Netlify; walked
  headless at 375px (`/`, `/recover-descriptor`, `/vaults`, a bad
  invite) with no page errors, the CSP serving `blockstream.info`, and
  the functions answering (401 without a token, clean 404 on a bad
  invite).

- **Passkey-protected keys built -- UNVERIFIED on a real device
  (2026-11-10).** Security backlog item 7; operator chose "passkey
  replaces password" and "cut now, I walk later." The gap: a
  secure-mode key's mnemonic is wrapped with a typed password, which a
  compromised page can capture as it is typed and which is only as
  strong as the human who chose it. Built: `apps/web/src/lib/passkey.ts`
  (`PrfProvider`, `webauthnPrf`: creates a passkey with the WebAuthn
  PRF extension and evaluates it against a random 32-byte salt; local
  random challenge, nothing touches a server; throws a plain "this
  device cannot do this, the key keeps its password" when PRF is
  absent). `lib/keystore.ts` gains `PasskeyBlob` /
  `LocalKey.passkeyMnemonic`, `encryptWithPrfSecret` /
  `decryptWithPrfSecret` (HKDF-SHA256 with a fixed info string ->
  AES-256-GCM), `keyNeedsPassword`, a passkey branch in
  `revealMnemonic`, `protectKeyWithPasskey` and `passkeyToPassword`.
  Because this is the one keystore operation that could strand a seed,
  `protectKeyWithPasskey` refuses rather than hopes: the key must be
  `backedUp` (checked BEFORE any passkey is created); the passkey is
  evaluated twice and must give the same 32 bytes; the blob is
  decrypted again and compared; only then is the password blob dropped
  in the same write. Any failure leaves the key exactly as it was. UI:
  `components/PasskeyProtect.tsx` ("Use a passkey instead" / "Use a
  password instead") in the key's detail actions, the confirm text
  stating in plain words that the password goes away and what the two
  ways back are; the recovery-phrase modal unlocks with the passkey;
  the four signing call sites (`VaultDetail` x2, `ProposalDetail`,
  `TrustTab`) ask for a password only when `keyNeedsPassword`. Fixed
  in passing, a bug my own item 6 created: the two "Remove password"
  buttons would have thrown uncaught on a mainnet key (the keystore now
  refuses that) -- they are hidden on mainnet. Proof:
  `scripts/test-keystore-passkey.mjs` with a SIMULATED passkey (7
  cases: refused without verified backup and no passkey created; wrong
  password changes nothing; non-deterministic passkey refused and the
  password still works; success leaves no password blob and no
  mnemonic word in storage and a passkey key may sign on mainnet; a
  wrong secret cannot unlock; back to a password; a test key upgrades
  directly) in `npm test`. NOT verified, and it is the part that
  matters: the real WebAuthn prompts on a real phone -- creation, PRF
  support, three prompts in a row, unlock at signing. No sandbox can
  show a passkey prompt. Measured: npm test green, lint 0 errors / 11
  pre-existing warnings, typecheck 10 = baseline, build green.

- **Two-step sign-in built -- UNVERIFIED on a real account (2026-11-10).**
  Security backlog item 10; operator: "cut now, I walk later." The gap:
  sign-in was email + password only, and an account shows vault
  structure, balances, addresses, member names and pending requests --
  coercion material though it moves no coins. Built, opt-in, on
  Supabase Auth MFA (TOTP): `apps/web/src/lib/mfa-rules.ts` (pure:
  `mfaDecision`, `normalizeTotpCode`), `lib/mfa.ts` (wrappers:
  `getMfaState`, `startEnrollment` which clears any half-finished
  factor first, `verifyCode`, `removeAuthenticator`),
  `components/TwoStepCard.tsx` mounted on the Keys page under the Tapit
  wallet card (QR via the existing `QrImage` plus the secret as text),
  `components/MfaChallenge.tsx`, and `RequireAuth` now holds the whole
  app behind the challenge when the session owes the step. Server half
  -- the wall, since the browser screen is only the front door:
  `netlify/functions/_auth.js` `requireUser` refuses a token whose
  `aal` is not `aal2` when the account has a verified factor
  (`aalSatisfied`, plus a per-instance 60s cache of the admin
  `mfa.listFactors` lookup, skipped entirely for aal2 tokens).
  DELIBERATE AND TEMPORARY: on a lookup ERROR the server does not ask
  for the step (logs loudly). That check sits in front of all 40
  functions and could not be run against the live project from the
  sandbox; failing closed on an untested lookup would turn one wrong
  assumption into a total outage. Flip it to fail-closed once a real
  lookup has been witnessed succeeding. Copy says plainly what this
  protects (what the account can SEE) and what it does not (coins are
  guarded by keys). Verified: `scripts/test-mfa.mjs` (3 cases: browser
  decision, code normalisation, server refuses a password-only session
  for an enrolled account) in `npm test`; both new screens rendered in
  a throwaway preview at 375px and looked at -- no overflow, no errors,
  copy and layout as intended. NOT verified, and it is most of the
  feature: enroll, challenge, verify, unenroll and the admin factor
  lookup against real Supabase, on a real phone, with a real
  authenticator. Not built: requiring it for mainnet-vault members,
  recovery codes, lost-phone recovery. Measured: npm test green, lint 0
  errors / 11 pre-existing warnings, typecheck 10 = baseline, build
  green.

- **Authorization audit of all 40 service-role functions: 13 gaps found
  and closed (2026-11-10).** Security backlog item 11. Every Netlify
  function that touches the database uses the Supabase service-role key,
  which bypasses RLS, so each handler is its own gatekeeper. A fresh-eyes
  read-only audit read all 40 end to end (PDF layout code and prompt
  constants grepped, not read); each finding was then re-verified
  against the code before anything was changed. Verdict: no endpoint
  let a stranger reach another user's vault by guessing an id -- but two
  mistakes were repeated across the tree: "is an active member" treated
  as "may change this", and exports returning whole rows where the
  regular endpoints redact. Fixed, in severity order: (1)
  `vault-activity-export.js` and `vault-audit-pdf.js` did `select("*")`
  on `vault_invites` and `vault_members`, handing any member -- a
  viewer included -- every unclaimed invite's `token` (the credential
  to join as founder/heir) and every member's xpub; both now redact
  exactly as `members.js`/`invites.js` do (token never leaves, invited
  email owner-only, xpub owner-or-self). (2) `psbt-merge.js` rewrote
  `status`/`psbt_signed_hex` on a broadcast/cancelled/fulfilled
  proposal, bypassing the terminal lock `proposals.js` enforces; it now
  404s an unknown proposal and 409s a terminal one. (3) `proposals.js`
  POST and PATCH accepted any role; view-only members are refused, and
  a `txid` may only be set together with the verified `broadcast`
  transition. (4) `signer-sessions.js` let a viewer record a
  "signature"; refused. (5) `invites-lookup.js` (unauthenticated)
  returned every spending path's `keys` despite its own comment saying
  no keys leave; paths now carry shape only. (6) `vault-requests.js`
  skipped both role checks when `status` was absent, so any member
  could rewrite a request's note and linked proposal; now
  trustee-only (requester while pending or when cancelling), and the
  linked proposal must belong to the vault. (7) `liveness.js` let any
  member re-post someone's OLDER signed heartbeat, replacing the
  current one and making them read as not-alive; a proof now only
  replaces an older one. (8) `invites-claim.js` was not atomic -- two
  accounts racing one token both became members; the invite is now
  claimed first with `update ... where claimed_at is null` and released
  if the member insert fails. (9) `distribution-wallets.js` let any
  member set, clear or forge tranche txids and store extra keys; each
  row is now the STORED row with only the two txids taken from the
  request, well-formed, fill-in-only for non-owners, viewers refused.
  (10) `circle-phrase-deliveries.js` upsert could reassign another
  owner's delivery row; refused when the row belongs to another
  account. (11) `stipends.js`: viewers refused, `last_proposal_id` must
  belong to the vault. (12) `members.js`: a removed member could still
  edit their old row; refused. (13) `proposals.js`: a
  `distribution_wallet_id` must belong to the proposal's vault. The
  rules live once in new `netlify/functions/_authz.js` (`canMutate`,
  `isTerminalProposalStatus`, `redactMember`, `redactInvite`,
  `stripPathKeys`, `sanitizeTrancheUpdate`, `isNewerProof`,
  `activeMembership`, `isVaultOwner`). Role rule chosen deliberately
  narrow: only `viewer` is read-only -- beneficiaries consent-sign and
  claim tranches, so restricting to owner/founder/heir would have
  broken real flows. Every client call site of the tightened endpoints
  was read first to confirm no legitimate flow is refused (the three
  `proposals.update` shapes, both `distributionWallets.update` calls,
  both `vaultRequests.update` calls, the stipend bump). Proof:
  `scripts/test-authz.mjs` (7 cases over the pure rules) in `npm test`;
  all 13 changed functions pass `node --check` and bundle with esbuild
  as Netlify does. HONEST LIMIT: the handlers were NOT exercised against
  a live database -- there is no test Supabase here -- so the wiring is
  proven by reading and bundling, the rules by test. Deliberately left,
  listed as backlog 11b: client-set `signed`/`fulfilled` unchecked,
  signer-session PSBT not verified to carry the member's signature,
  post-compile key edits by an active member, tranche txid not verified
  on chain, the wallet sign-in challenge questions, and the original
  move off the service-role key onto JWT + RLS. Measured: npm test
  green (all suites incl. authz 7, audit-prod PASS, harness 41), lint 0
  errors / 11 pre-existing warnings, typecheck 10 = baseline, build
  green.

- **Chain tip from two independent sources, or no compile (2026-11-10).**
  Security backlog item 12, and the limit left open under item 2. The
  gap: the tip that every absolute timelock is built from (`tip +
  offset`) came from mempool.space alone, on the server and again in the
  browser's cross-check -- so the cross-check defended against a
  tampered server path but not against the feed itself being wrong. Fix,
  server: `netlify/functions/_chain.js` gains `SECOND_SOURCE`
  (blockstream.info Esplora, all three networks), pure
  `reconcileTips(a, b)` (throws when more than `TIP_SOURCE_MAX_DIFF` = 6
  blocks apart, else returns the HIGHER tip -- a low tip opens a
  timelock early, so the later height is the safe one) and
  `fetchVerifiedTipHeight`, which requires both sources to answer, pass
  the floor, and agree; the five compile paths (`compile.js`,
  `compile-bloc.js`, `compile-leaves.js`, `vaults-compile.js`,
  `vaults-compile-bloc.js`) now call it. It fails closed on purpose: if
  either source is down a vault cannot be compiled for a few minutes,
  which is cheap; a wrong timelock is forever. `fetchTipHeight`
  (single source) stays for `proposals.js` and `psbt-binary-tranche.js`,
  where the tip only gates a display/eligibility check that the chain
  itself re-enforces at broadcast. Fix, browser: `lib/timelock-check.ts`
  gains the same `reconcileTips`; `lib/chain.ts` gains
  `verifiedTipHeight` (fresh, uncached, both sources); `VaultWizard`'s
  `assertTimelocks` uses it; `config.ts` gains `SECOND_TIP_SOURCE`; and
  `netlify.toml`'s CSP `connect-src` now allows
  `https://blockstream.info` (without that the browser fetch would be
  blocked in production and every compile would be refused). Deliberately
  still single-source: balances, UTXOs, fee estimates and broadcast.
  Proof: `scripts/test-timelock-check.mjs` grew a 7th case running the
  browser and server `reconcileTips` through the same assertions and
  asserting the two `TIP_FLOOR` tables are equal; and
  `fetchVerifiedTipHeight` was run live against both feeds on all three
  networks (bitcoin 975,303, testnet 5,323,815, signet 330,251, both
  sources identical at the time). NOT walked: the wizard's compile step
  in a real browser under the production CSP -- that needs a signed-in
  session and is the operator's to confirm on the next compile.
  Measured: npm test green, lint 0 errors / 11 pre-existing warnings,
  typecheck 10 = baseline, build green.

- **Supply-chain gate on what ships, and the tree cleaned to pass it
  (2026-11-10).** Security backlog item 8. Measured first, not assumed:
  `npm audit` found 33 advisories in the whole tree, 16 in code that
  ships (root `--omit=dev` plus `netlify/functions`): 4 high, 2 critical.
  Triage: both criticals and several moderates were the `request` /
  `form-data` / `tough-cookie` / `qs` chain under `opentimestamps`, which
  tapit-attest declared as an optional dependency for its
  `OpenTimestampsProvider` -- a provider nothing in this repo executes
  (`apps/web/vite.config.ts` already externalizes the package for that
  reason), so the only thing it shipped was the advisory. Operator:
  "You can take from tapit. I think standalone is better." Removed from
  `tapit-attest/package.json` outright (not demoted; optional deps still
  install); the provider's lazy `import('opentimestamps')` and its clear
  "install it yourself" error are unchanged, so a consumer that wants
  real OTS anchoring adds the package and nothing else moves.
  tapit-attest's own gates after: typecheck clean, 73/73 tests. The
  Tapit Wallet copy of tapit-attest never carried the package, so nothing
  is owed there. Targeted upgrades, each inside its existing semver
  range, never a blind `npm audit fix` (whose dry run wanted to change 54
  and remove 189 packages -- too much churn on one theory in
  money-touching code): react-router-dom 7.14.1 -> 7.18.5 (open redirect
  via backslash in Link/useNavigate among eight advisories), ws ->
  8.22.2 at the root (via supabase realtime) and in `netlify/functions`,
  brace-expansion updated. Root install then pruned 267 packages, all
  the opentimestamps chain. New gate `scripts/audit-prod.mjs`, wired
  into `npm test` ahead of the harness: audits the root tree with
  `--omit=dev` and `netlify/functions` separately (they install
  separately in CI), fails on high or critical, and when the registry is
  unreachable prints UNVERIFIED and exits non-zero rather than passing
  silently. Dev tooling advisories (vite, eslint, postcss, js-yaml...)
  deliberately NOT gated: they never reach a user, and a gate that
  fails on a linter's glob library teaches people to ignore it; upgrade
  those on their own schedule. After: 0 advisories of any severity in
  anything that ships. Walked, not just built: rebuilt with the public
  Supabase env, served with `vite preview`, loaded `/`,
  `/recover-descriptor`, `/invite/<bad token>` and `/vaults` headless at
  375px on the new router -- every route rendered, auth redirects
  intact, the bad invite handled gracefully, no horizontal overflow, no
  page or console errors. Deliberately not done, now item 8b: the
  reproducible-bundle comparison against what dynastytrust.family
  serves, and switching Netlify's build command from `npm install` to
  `npm ci`. Measured: npm test green (all suites + audit-prod PASS +
  harness 41), lint 0 errors / 11 pre-existing warnings, typecheck 10 =
  baseline, build green.

- **Attestations verified server-side before they are stored
  (2026-11-10).** Security backlog item 4. The gap, documented in the
  function's own header since it was written: `vault-attestations.js`
  checked that `signature` was 128 hex chars and that `pubkey` matched
  the caller's registered `vault_members.pubkey`, then stored the row
  without ever verifying the signature. Any member with a session could
  file a proof-of-life, death-declaration, trust-doc or descriptor
  attestation that no key signed. It could not unlock a leaf, but every
  one of those is something heirs and trustees act on. Fix: new pure
  `netlify/functions/_attest.js` (`attestationDigest`,
  `verifyAttestationSignature`) reproducing `apps/web/src/lib/attest.ts`'s
  digest exactly, `SHA256("DT-ATT-v1" || type || 0x00 || target_hash)`,
  BIP340 Schnorr over it with the x-only key; the POST handler now
  returns 400 unless the signature verifies under the registered key,
  after the existing pubkey-match check and before insert. The browser's
  render-time verification stays, so there are two independent checks.
  `@noble/curves` / `@noble/hashes` added to `netlify/functions/
  package.json` (they were only declared for the web app; the function
  bundle resolved them from the root in the sandbox, but Netlify's
  functions install must not depend on that), and the function was
  bundled with esbuild the way Netlify does to confirm the import
  resolves. Proof: `scripts/test-attestation-verify.mjs` signs with the
  real browser signer and verifies with the real server code (4 cases:
  honest proof-of-life verifies; wrong key, corrupted byte, swapped type
  and swapped target all refused; digest domain-separated by tag and
  type; malformed input fails closed without throwing), wired into
  `npm test`. Item 3 (tranche-claim co-signer gate) closed the same day
  by grounding with no code: `ProposalDetail.tsx` never signs a tranche
  claim (every signing surface is behind `!isTrancheClaim`; claims are
  signed from the Distributions tab, which carries the full gate).
  Measured: npm test green (policy, legacy, onchain, spending paths,
  timelock-check 6, keystore-mainnet 5, attestation-verify 4, harness
  41), lint 0 errors / 11 pre-existing warnings, typecheck 10 =
  baseline, build green.

- **Mainnet refuses plaintext (test-mode) seeds (2026-11-10).** Security
  backlog item 6. The gap: `lib/keystore.ts` test-mode keys hold the
  mnemonic in plain text in localStorage, so any script that can read this
  origin's storage holds the seed outright -- fine for signet coins, never
  for mainnet -- and nothing stopped a test-mode key from being created
  for mainnet, downgraded to plaintext on mainnet (`removeKeyPassword`),
  or used to sign a mainnet spend. Fix: one rule stated once
  (`testModeBlockedReason(network)`) and a per-key
  `keySigningBlockedReason(key)`, called at the three places a plaintext
  mainnet seed could come to exist or be used: `generateTestKey` throws
  for mainnet, `removeKeyPassword` throws for a mainnet key, and
  `revealMnemonic` throws for a plaintext mainnet key -- including one
  created before this rule or imported via `importKeyringJson` -- while
  `secureTestKey` (which reads the field directly) still upgrades it, so
  the path out is open and the path to signing is closed. Secure-mode and
  hardware keys untouched. Deliberately not done: the signer pickers in
  `VaultDetail`/`ProposalDetail` still list such a key and let the refusal
  surface on tap with the reason; `keySigningBlockedReason` is exported so
  a follow-up can label them in place. Proof:
  `scripts/test-keystore-mainnet.mjs` (localStorage shimmed in-memory;
  5 cases: refused on mainnet and usable on signet, pre-existing plaintext
  mainnet key cannot reveal, upgrade restores signing with the password
  and rejects a wrong one, downgrade refused and the key stays encrypted,
  password-protected mainnet key allowed) wired into `npm test`. Measured:
  test green, lint 0 errors / 11 pre-existing warnings, typecheck 10 =
  baseline (the two in keystore.ts are the documented PBKDF2/AES typing
  errors at lines 112/137, unchanged), build green.

- **Absolute timelock cross-check: the browser refuses a compiled vault whose
  heights are not tip + the offset chosen (2026-11-09).** Security backlog
  item 2. The gap: every `after()` leaf is compiled server-side as `tip +
  offset` where `netlify/functions/_chain.js`'s `fetchTipHeight` took any
  finite non-negative number from mempool.space as the tip, and nothing in
  the browser ever checked the absolute heights that came back. A tip wrong
  by a lot (a feed bug, a changed API base in the Netlify environment, a
  tampered function or response) compiles a vault whose recovery and
  inheritance doors are already open the day it is funded, with the only
  symptom a height nobody reads by hand. Fix, server half: `TIP_FLOOR`
  per network (bitcoin 900,000 / testnet 5,000,000 / signet 300,000;
  measured tips that day 975,224 / 5,322,818 / 330,163), an all-digit
  response check, and a thrown error below the floor. Fix, browser half:
  new pure `apps/web/src/lib/timelock-check.ts` (`checkTipFloor`,
  `checkAbsoluteTimelocks`, 12-block slack) and `VaultWizard.runCompile`
  now fetches the tip itself via `lib/chain.ts` after each of the three
  compile paths and throws `TimelockMismatch` -- vault not accepted, not
  advanced to Backup, told plainly not to fund it and to delete it --
  unless every `after()` height is tip + the chosen offset within slack,
  every `older()` duration came back untouched, and no leaf carries a
  timelock that was not asked for. Standard compares the draft row's
  relative `recovery_after` / `inheritance_after` /
  `second_inheritance_after` to the compiled row; leaf-list compares each
  enabled non-immediate leaf draft by id (a missing or re-typed leaf is a
  mismatch, never a pass); Bloc compares `parentSoloAfter` /
  `kidsDecayStartAfter` to `bloc_policy`. Verified before wiring that all
  three server paths persist and return the ABSOLUTE heights
  (`vaults-compile.js` 279/372, `vaults-compile-bloc.js` 132/162,
  `compile-leaves.js` `wireLeaves` at 205), so the comparison is against
  what is actually stored. Deliberately not done: the two tips still come
  from mempool.space, so this defends against the server path, not a bad
  feed (item 12); and a mismatched compile has already written the vault
  row server-side -- the browser refuses it and tells the user to delete
  it rather than silently archiving. Proof: `scripts/test-timelock-check.mjs`
  (6 cases: honest within slack, doors-already-open refused, slack
  boundary exact, unasked-for and missing timelocks refused, relative
  converted to height refused, floors on all three networks) wired into
  `npm test`. Measured: npm test green (policy, legacy, onchain, spending
  paths, timelock-check 6, harness 41), lint 0 errors / 11 pre-existing
  warnings, typecheck 10 = baseline, build green.

- **Browser full-transaction gate: inputs, change and fee verified from the
  PSBT's own bytes (2026-11-09).** Operator, after a grounded threat read of
  main: "cut the browser-side gate now." The gap: `verifyPsbtMatchesRequest`
  (`apps/web/src/lib/psbt-signer.ts`, Kimi K3 Family A) checked only that
  output[0] paid the typed destination and amount and that there were at
  most two outputs. It never checked that output[1] (change) returned to the
  vault, that every input spent the vault's own coin, or that the fee was
  real -- the confirm screen rendered the server's `summary.fee_sats` /
  `change_sats`. The only change-address check lived server-side in the
  Rust compiler, i.e. inside the component under suspicion. A compromised
  coordinator could therefore pay the destination exactly as shown and send
  the remainder as "change" to an attacker, or sweep in a foreign input
  that shares the signer's keys, and the browser would sign it. Fix:
  `PsbtRequestCheck` gained optional `ownAddress`, `feeSats`, `changeSats`;
  when given, every input must carry a witness UTXO (refused otherwise --
  an input that cannot be checked is not assumed benign) whose
  scriptPubKey equals the vault's own, output[1] if present must equal it,
  change must equal what is shown (0 means no change output at all), and
  sum(inputs) - sum(outputs) must equal the fee shown. Wired into the main
  Send flow (`VaultDetail.tsx` with `vault.address`), the tranche claim
  (`tranche.address`), and the co-signer page (`ProposalDetail.tsx`:
  `signWith` refuses, and a red "Do not sign this request" card replaces
  the Nostr/hardware signing inputs with an empty PSBT when the stored
  PSBT does not match the proposal row). Deliberately left: the co-signer
  page skips the own-coins/change half for `tranche_claim` proposals
  because it does not load the tranche address (security backlog item 3).
  Proven by 8 new checks in `scripts/offline-vault-harness.mjs` (honest
  PSBT passes; same-length byte forgery of the change script and of the
  input's witness UTXO script refused; lying fee, lying change and swapped
  destination refused; compiler-side refusal of a foreign input and foreign
  change as belt and braces). Measured: harness 41 checks green, lint 0
  errors / 11 pre-existing warnings (none on changed lines), typecheck 10
  errors = documented baseline (none new), build green. The full ordered
  list of remaining gaps is `docs/security-backlog.md`.

## Closed open-gap items (6 through 9)

6. ~~Legacy Recovery: leaf-list ("generic") vault shape not covered yet.~~
   **Closed 2026-08-22.** Operator, on a custom-shape vault's Legacy
   Recovery page: "keys not showing up here. Needs to be for any key in
   the vault." Exactly the gap already named here: `rolesForVault` only
   ever enumerated `founder_keys`/`backup_keys`/`heir_keys`/
   `second_heir_keys`, all empty for a `leaves`-shaped vault, so the page
   fell through to "This vault has no named roles to publish for yet."
   Added the same `Array.isArray(vault.leaves) && vault.leaves.length > 0`
   branch used elsewhere in this file's history: one role slot per key in
   every leaf, keyed off the leaf's own `id`/`label` (`"${leaf.label} ${i
   + 1}"` when a leaf has more than one key, else just the leaf's own
   label) rather than a fixed founder/heir shape -- a key reused across
   leaves gets one slot per leaf it actually appears in, the same pattern
   vault-membership grants already use for this vault shape. `role` (the
   slot's string id) was confirmed to be pure display/iteration state
   nowhere else in the file -- never persisted or matched against a fixed
   enum -- so widening it needed no other change: `LegacyOnChainV2Card`,
   the derivation path, sealing, and publish flow are all already fully
   generic per-key mechanics untouched by this fix. Named-field vaults are
   byte-for-byte unchanged. All four gates green, matching the documented
   10/10 baseline exactly.
7. ~~Legacy Recovery: on-chain publication of the pad.~~ **Closed
   2026-08-18.** `LegacyRecoverySetup.tsx` now shows the on-chain share as
   an OP_RETURN-ready hex payload with instructions for embedding it via
   any wallet, and records the resulting txid once the owner broadcasts it
   themselves. Deliberately still not auto-broadcast -- DynastyTrust
   doesn't custody funds or manage a user's unrelated UTXOs, so the actual
   send stays a human action in their own wallet, same boundary every
   other send flow here respects.
8. ~~PDF / audit / tax exports don't know about the custom leaf-list vault
   shape.~~ **Closed 2026-08-19.** `vault-pdf.js`, `vault-audit-pdf.js`,
   and `vault-tax-summary.js` all now branch on `Array.isArray(vault.leaves)
   && vault.leaves.length > 0` and read the generic `LeafSpec[]` shape --
   per-path quorum/key-count/timing rows -- instead of assuming
   `founder_keys`/`heir_keys`/`founder_quorum`/`heir_quorum` unconditionally.
   `vault-pdf.js` additionally regenerates its "VAULT POLICY" path cards,
   the "KEY CONFIGURATION" rows, page 2's public-key listing (one section
   per path instead of the fixed Founder/Heir pair), and the signing-
   instructions copy from the real leaf list. Named-field and Bloc vaults
   are byte-for-byte unchanged -- this only adds the missing branch, no
   existing rendering path was touched. One honest residual: the client
   PDF's per-path key listing on page 2 stops drawing (with a page break)
   if it runs off the bottom rather than flowing onto a third page --
   pre-existing behavior for the founder/heir path too, not new here, but
   worth knowing for a vault with a very large number of paths and keys.
9. ~~Vault-membership circle invites don't work at all for the custom
   leaf-list vault shape.~~ **Closed 2026-08-19.** Three real, connected
   fixes, not one: (1) `compile-leaves.js` never read `leaf_scripts` off
   the Fly.io compiler's response at all, despite `compile_leaves` (Rust,
   `compiler/src/main.rs`) already returning it keyed by leaf id and
   already being unit-tested to do so (`compiles_a_valid_leaf_list_and_
   returns_leaf_scripts_by_id`) -- so `vaults.leaf_scripts` sat `null` for
   every leaf-list vault ever compiled. Now persisted on compile, same as
   `vaults-compile.js` already does for the named-field shape. (2)
   `circle-membership-delivery.ts`'s `VaultMembershipRole` type and
   `leafScriptsForRole` were hard-wired to the five named-field roles;
   widened (`(string & {})`) with a fallback that treats an unrecognized
   role as a literal leaf id and looks it up in `leaf_scripts` directly --
   exactly what a leaf-list vault's "role" actually is, no fixed mapping
   needed since compile-leaves.js's leaf_scripts is already keyed by leaf
   id. (3) `VaultMembershipSetup.tsx` gained an optional `leaves` prop;
   when present it builds its roleArrays from each leaf's own `id`/`keys`
   instead of the five fixed arrays, and every role label falls back to
   the leaf's own `label` (e.g. "Grantor(s)") instead of the fixed
   `ROLE_LABELS` map. `tapit-circle-members.ts` needed no change at all --
   it was already role-agnostic, taking any key array. `VaultDetail.tsx`
   now passes `vault.leaves` through. A key that legitimately sits in more
   than one leaf (the key-reuse pattern `find_key_reuse` already
   recognizes) gets one membership grant per leaf it's actually in, which
   is arguably more correct than the named-field path's fixed
   founder-signs-two-leaves mapping. Works for any custom-shape vault,
   including the new Revocable living trust template.

## Recently closed

**Recently closed:**

- **Threat-model audit follow-up: descriptor-swap pinning + a CSP
  (2026-08-29).** Operator, after a long discussion of where DynastyTrust
  could be tricked into signing something malicious: "Anything we can do
  to sure up holes." Two real, previously-unaddressed gaps from that
  discussion, both closed; the rest of the discussion's concerns
  (change-output spoofing, leaf/path mislabeling) were traced against
  `psbt_builder.rs`/`psbt_parser.py` and found already closed by existing
  code (`change_address` is rejected server-side unless it matches the
  vault's own compiled script; `attach_tap_change_output_metadata` stamps
  real BIP371 derivation on the change output so SeedSigner's own
  `verify_multisig_output` cryptographically confirms it, not a label) --
  confirmed rather than re-fixed. (1) **Descriptor-swap pinning.** Nothing
  before this stopped a signer from importing a DIFFERENT descriptor than
  the one that actually funded a vault (a compromised app substitutes it,
  a stale copy-paste, a swapped QR) -- every future signature that signer
  produces is then perfectly correct against the wrong tree, with nothing
  at signing time able to catch it. New
  `apps/web/src/lib/descriptor-fingerprint.ts` (`descriptorFingerprint`/
  `formatDescriptorFingerprint`, plain SHA-256 over the descriptor's UTF-8
  bytes, first 8 hex chars -- same convention as `PsbtQrDisplay.tsx`'s
  `psbtTransactionFingerprint`) is displayed in both of `VaultDetail.tsx`'s
  descriptor cards, printed in `vault-pdf.js`'s technical-details page
  (via a Node `crypto.createHash('sha256')` computation, independently
  implementing the same algorithm rather than importing across the
  browser/server boundary), and written into `descriptor-backup.ts`'s
  downloadable backup text -- all three with the same explicit
  instruction: write the fingerprint down SEPARATELY (paper, not the
  screen it was read from), and compare it against any future copy of the
  descriptor before trusting it. This is a labeling/comparison aid, not a
  security mechanism on its own -- comparing DynastyTrust's own displayed
  fingerprint against a descriptor DynastyTrust also generated proves
  nothing about a substitution DynastyTrust itself performed maliciously
  or was tricked into performing; its value only exists once captured
  once, out of band, and compared later against a channel a single
  compromised party can't touch. Deliberately not mirrored into
  `vault-audit-pdf.js`/tax exports -- `vault-pdf.js` is the primary
  client-facing artifact and the smallest useful slice. (2) **CSP +
  security headers.** `netlify.toml` had no security headers at all.
  Added `Content-Security-Policy` (script-src limited to 'self' -- this
  bundle has no inline scripts, confirmed by inspecting the built
  `index.html` -- closing off the most common injected-script path for
  the app's softest attack surface: an XSS bug, malicious extension, or
  compromised npm dependency getting a shot at an unlocked secure-mode
  key or a test-mode plaintext mnemonic in `localStorage`), plus
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and
  `Permissions-Policy` scoping camera to same-origin (needed for this
  app's own QR scanners) with microphone/geolocation denied outright.
  `connect-src` deliberately allows `wss:` broadly rather than an
  enumerated relay list, because Nostr relay choice is intentionally
  user-configurable (`nostrRelayPrefs.ts` -- "a family that wants to run
  its own relay") and a fixed allowlist would silently break that feature
  for anyone who points it elsewhere; `style-src`/`font-src` needed
  `fonts.googleapis.com`/`fonts.gstatic.com` added after the production
  build revealed the app's Google Fonts `<link>` tags, caught by actually
  inspecting `dist/index.html` rather than guessing at what the CSP needed
  to allow. Separately confirmed no gap: `ChatWizard.tsx`'s `ConfirmCard`
  ("Sage rubber-stamping a malicious spend") -- read the code and found
  Sage only ever proposes VAULT STRUCTURE (quorums, timelocks), never a
  destination or amount, and "Looks right -- build this vault" only
  navigates into the full `VaultWizard` prefilled; it does not compile,
  sign, or spend anything by itself, so every real review step (Configure
  -> Keys -> Compile -> Backup -> Funding) still happens normally. No fix
  needed, stated here so a future audit doesn't re-flag it. All four
  gates green: typecheck matches the documented 10-error pre-existing
  baseline exactly (none in a file this change touched), lint 0 errors/11
  pre-existing warnings, build clean, full test suite passing
  (`node --check` on `vault-pdf.js`, plain JS with no build step).

- **Sage told a user their tiered heir/backstop plan needed two separate
  vaults -- it doesn't, and Sage's own knowledge had no way to know that
  (2026-08-27).** Operator pasted a real Sage transcript for review: a
  person built up to "heirs inherit after ~10 years, a single buried key
  as the ultimate backstop after ~15 years," and Sage's final answer was
  "the templates I can build here have one heir path, not two stacked
  heir leaves... best built as its own thing: a second, separate vault."
  Checked against the real compiler and found that flatly wrong: the
  Standard vault shape has carried exactly this -- a second, independent
  `second_inheritance` leaf with its own quorum (down to a single key)
  and its own longer timelock, stacked on top of the first inheritance
  leaf in the SAME compiled vault -- since the 2026-08-XX second-
  inheritance feature shipped, fully wired into `VaultWizard.tsx`'s
  Standard Configure step as an "Add a second, independent heir group"
  toggle. Traced the actual root cause rather than just re-answering the
  question: `assistant.js`'s hand-maintained knowledge digests (the top-
  of-prompt product description, `RUNG_DIGEST`'s Rung 6, and
  `TEMPLATE_DIGEST`) never once mentioned second inheritance anywhere,
  so the model had no way to know the capability existed and reasonably
  improvised the two-vault workaround. Two further, smaller instances of
  the identical gap found while grounding this: `VAULT_SAFE_FIELDS`
  (what Sage can see about a vault it's discussing) omitted
  `second_heir_quorum`/`second_inheritance_after`, so even asking about
  an EXISTING vault with one already configured would have shown Sage
  nothing; and the `vault-proposal` JSON schema Sage uses to hand off a
  concrete recommendation had no fields to express a second tier at all,
  so even a correct recommendation couldn't have been proposed end to
  end. Fixed all four: the top-of-prompt description and Rung 6 now
  state plainly that inheritance is not a ceiling and a deeper tier is
  optional and stacks on the SAME vault; a new SECOND INHERITANCE
  section in `TEMPLATE_DIGEST` states this explicitly and says outright
  never to recommend two vaults for this shape; `VAULT_SAFE_FIELDS` and
  the named-field branch of `vaultContext` now surface
  `second_heir_quorum`/`second_inheritance_after` when set;
  `extractProposal()`, `VaultProposal` (`api.ts`), and `ChatWizard.tsx`'s
  `ConfirmCard` all gained matching OPTIONAL
  `second_heir_quorum`/`second_heir_count`/`second_inheritance_after_months`
  fields (omitted entirely when a plan has no deeper tier, so every
  existing proposal shape is untouched). The rest of that transcript was
  independently verified accurate and left alone -- Sage's refusal to
  give a "15% return" allocation number, its timelock/loosest-door
  reasoning, and its single-buried-key trade-off critique all checked
  out against the real mechanics. `node --check` passed on the edited
  Netlify function (plain JS, not covered by tsc/eslint); all four
  frontend gates green, matching the documented baseline exactly.

- **Number fields for a timelock could get permanently stuck at their
  starting value -- clearing them to type something else just snapped
  right back (2026-08-26).** Direct follow-up to the timelock-floor
  warning above: operator asked "Did you fix the fields where a zero is
  stuck even if you're trying to go to something else." Real, separate
  bug from the floor warning, and a classic React controlled-number-
  input footgun: every one of these fields bound `<input type="number">`
  directly to a NUMBER state via `value={n}` /
  `onChange={e => setN(parseInt(e.target.value) || fallback)}`. The
  moment the field is cleared, `e.target.value` is `""`,
  `parseInt("") || fallback` evaluates back to the exact value the field
  already held, so the state never actually changes -- and since the
  JSX still renders `value={n}` with that same unchanged number, React
  forces the DOM's displayed text straight back to it before the next
  keystroke can land. Worst on a field whose live value is exactly 0 (a
  fresh leaf's unset "after a fixed date" timelock is 0 by design), but
  it affects ANY value: backspacing never produces a genuinely empty
  field to type a new number into. `VaultWizard.tsx`'s shared
  `TimelockField` (behind every timelock input in the builder) gained
  local `rawBlocks` text state for its raw-blocks field, re-synced from
  the numeric `value` prop only when something ELSE changes it (a preset
  button, a date/time pick, a parent overwrite) via a `useEffect` keyed
  on `value` -- not on the field's own keystrokes, so an in-progress
  empty or leading-zero string is never fought mid-edit; a real,
  finite parsed number is the only thing that ever calls back up to
  `onChange`. `VaultDetail.tsx` had the identical pattern in two
  unrelated places, fixed the same way but without needing the
  presets-and-date-pickers complexity `TimelockField` has, so a simpler
  text-state-plus-derived-number split sufficed: the Rotate-vault
  dialog's "Recovery timelock" / "Inheritance timelock" fields
  (`recoveryOffsetText`/`inheritanceOffsetText`, previously
  `recoveryOffset`/`inheritanceOffset` as bare numbers), and the Tranche
  creation form's "Tranche count" / "Interval (blocks)" / "First unlock
  block" fields (`trancheCountText`/`intervalBlocksText`/
  `firstUnlockBlockText`) -- each now holds raw text, with the numeric
  value used everywhere else in the component (validation, the actual
  compile/rotate payload, display labels) derived from that text via a
  plain `const`, so no other call site needed to change beyond the
  `<Input>` itself. `max_sats` in the same file's rules editor was
  checked and found already safe (`value={r.max_sats != null ? ... :
  ""}`, never forces a "0" string) -- confirmed rather than touched.
  All four gates green, matching the documented baseline exactly
  (typecheck's known pre-existing errors merely shifted line numbers,
  zero new lint warnings).

- **Builder gave no warning for a too-short fixed-date timelock -- it
  just failed at compile with a bare server error (2026-08-26).**
  Operator: "the number fields for timelocks on months has a bug. And
  some leafs won't let you do short timelocks not sure why. But it
  gives an error if I only put in 100 blocks." Traced to real,
  intentional-but-unexplained behavior, not a math bug: every "after a
  fixed date" (absolute CLTV) path -- Standard's Recovery/Inheritance/
  Second inheritance, Bloc's parent-solo/kids-decay-start, a leaf-list
  leaf's After unlock -- has always required >= 26,000 blocks
  (`MIN_RECOVERY_BLOCKS`, ~6 months) server-side
  (`_chain.js`'s `checkTimelockFloor`, mirroring
  `protocol::MIN_RECOVERY_BLOCKS`) so a fixed-deadline path can't be
  made near-instant, defeating the point of a real waiting period --
  see CLAUDE.md's absolute-vs-relative timelock rule. An "if left
  untouched" (relative CSV/`older()`) path has NO such floor by design,
  which is exactly why "some leafs" (paths) rejected 100 blocks and
  others didn't -- correct, but never explained anywhere the operator
  could see it. The real gap: nothing in the builder checked this
  BEFORE hitting Compile, so typing 100 directly, or picking "6 months"
  on the date/time picker and landing on a calendar stretch a little
  short of 182.5 days (Feb-inclusive spans, for instance), both sailed
  past every client-side check and only surfaced as the server's bare
  `"...must be >= 26000 blocks (or 0 for no leaf)."` at the very last
  step -- indistinguishable from an actual bug to anyone who didn't
  already know the floor existed. `lib/blocks.ts` gained an exported
  `MIN_RECOVERY_BLOCKS` (mirrors the two existing Rust/JS copies, now a
  third kept in sync by the same constant value, not re-derived).
  `TimelockField` (the one shared component behind every timelock input
  in the builder -- presets, calendar pickers, and the raw blocks field
  alike, so this covers all three ways a value gets in) gained an
  optional `minBlocks` prop: when a value is nonzero but below it, an
  inline red warning explains the real minimum in both human terms
  (`blocksToHuman`) and blocks, and says plainly that value will be
  rejected at compile -- wired into all six absolute-CLTV fields
  (Standard's three, Bloc's two, the leaf-list After field) and
  deliberately left off the three relative/duration fields (Older-type,
  both decay-step fields) which have no such floor. `leafShapeIssues()`
  gained `hasShortAfter`, extending the same pattern its existing
  `hasUnsetAfter` check already established for the leaf-list Continue
  gate. Standard and Bloc had no equivalent Continue-button gate at
  all before this -- the single shared "Continue -- add keys next"
  button only ever blocked on the leaves shape -- so `ConfigureStep`
  gained `stdShapeBlocked`/`blocShapeBlocked` checks (reading only the
  fields actually active for the current config, matching exactly what
  `runCompile` sends) folded into one `shapeBlocked` now driving the
  button's `disabled` prop for all three shapes uniformly, closing the
  same "invalid shape reaches Keys/Compile with no way back to fix it"
  dead end already fixed for leaves in the full builder-pipeline audit
  entry below. All four gates green, matching the documented baseline
  exactly (typecheck's known pre-existing errors are all in unrelated
  files, zero new lint warnings).

- **Descriptor round-trip check strengthened to catch a wrong tree, not
  just a malformed string (2026-08-26).** Operator asked for an
  independent audit of `policy_compiler.rs`: "Anywhere the compiler
  could give the wrong descriptor or the wrong miniscript structure?"
  Traced all three live tree-builders (`build_multileaf`,
  `build_leaf_multileaf`, `build_bloc_multileaf`) by hand-expanding
  their `format!`-built descriptor strings against the exact
  `TaprootBuilder.add_leaf(depth,...)` calls that produced the real
  tree -- no live mismatch found; `nest_leaves()` (used by the latter
  two) provably matches the `add_leaf` depth schedule `[1,2,...,n-1,
  n-1]` for any n, not just the specific cases checked by hand. The
  real gap was in the safety net meant to catch exactly this class of
  bug: all three compile paths' "descriptor round-trip" check
  (`let _: Descriptor<DescriptorPublicKey> = Descriptor::from_str(...)`)
  discarded the parsed result, so it only ever proved the descriptor
  string was syntactically valid Miniscript grammar -- a hand-built
  tree with leaves nested at the wrong depth (syntactically fine,
  structurally wrong) would have parsed clean and shipped anyway. Note
  this never put DynastyTrust's own signing at risk -- `psbt_builder.rs`
  always pulls the control block from `spend_info.control_block(...)`,
  the same `TaprootSpendInfo` object that produced the address, never
  a re-derivation from the descriptor text -- but a wrong descriptor
  string handed to an external wallet (Sparrow, Nunchuk) could still
  compute a different address than the one actually funded. All three
  sites now re-derive the round-tripped descriptor's scriptPubkey via
  `at_derivation_index(0).script_pubkey()` (network-independent, so no
  network parameter needed for the comparison) and reject the compile
  outright if it disagrees with `spend_info`'s own scriptPubkey, instead
  of binding the parse result to `_`. `compile_tranche_tr_multileaf`
  was noted as the one path with no round-trip check at all, but left
  alone -- its tree is always exactly two leaves at a fixed depth
  (`{A,B}`), with no `n`-dependent nesting logic to get wrong, so the
  risk this fix targets doesn't apply there. All 124 protocol tests and
  39 compiler tests pass unchanged, confirming the stronger check
  doesn't false-positive on any existing vault shape (standard,
  Tapit Circle, Gift Locker, 4-leaf, leaf-list, Bloc). Frontend gates
  unaffected (Rust-only change) and re-run anyway, matching the
  documented baseline exactly.

- **Dashboard: "Waiting for your signature" kept showing proposals the
  caller had already signed, and the "Trustee" portfolio card was
  pure noise (2026-08-25).** Operator: "The messages section gets stale.
  Even if you've already signed a proposal it is annoying. And I don't
  need to know that there is 3 vaults I can sign. I know I can see
  them." Two separate fixes, both in the same cross-vault summary area.
  (1) `proposals-mine.js` (powers `PendingFeed`'s "Waiting for your
  signature" list) returned every non-terminal proposal on every vault
  the caller belongs to, with no check at all for whether the CALLER
  specifically still needed to act -- so a proposal stayed in the list
  until every co-signer caught up, even after the caller's own part was
  done. `signer_sessions.member_id` is always server-derived from
  `(vault_id, user_id)` at signing time (`signer-sessions.js`), never
  client-supplied, so it's a reliable "did I already sign this" check:
  the endpoint now looks up the caller's own `member_id` per vault and
  filters out any proposal where a `signer_sessions` row for that
  member is already `signed`. (2) `Dashboard.tsx`'s `RoleSummary`
  "Trustee" card (`"N vaults you can sign now"`) restated a count
  already visible in the vault list directly below it, with no
  information the list didn't already show -- unlike the Successor/
  Beneficiary cards next to it, which surface something NOT visible at
  a glance (soonest inheritance, consent requirements). Dropped the
  card and the now-unused `trustee` bucket; Successor/Protector/
  Beneficiary/Observer cards are unchanged. All four gates green,
  matching the documented baseline exactly.

- **Full builder-pipeline audit: resuming a saved leaf-list draft
  reconstructed the WRONG vault shape, plus two smaller correctness gaps
  (2026-08-25).** Operator: "Let's go through all scenarios of the
  builder and make sure we hand everything where it's supposed to go
  labeled properly and compiles correct." Traced the entire path by hand
  -- `LeafDraft` (Configure step UI state) -> `leafDraftToSpec` ->
  `LeafSpec` (client type) -> `createLeavesDraft`/`updateLeaves`
  (persisted) -> `compile-leaves.js` (validates, converts relative-to-
  absolute, forwards) -> Rust `/compile-leaves` (`Leaf`/`LeafPolicy`,
  wire-format confirmed byte-for-byte via `#[serde(tag = "type",
  rename_all = "snake_case")]` matching `leafUnlockOf`'s output exactly)
  -- and confirmed it all wires and labels correctly EXCEPT three real
  gaps. (1) **The most severe**: `VaultWizard.tsx`'s resume-draft effect
  (fired by VaultDetail's "Continue setup" button) had no branch at all
  for a leaf-list draft -- every one fell into the `else` (`shape:
  'standard'`) branch, reconstructing a bogus `StandardConfig` from the
  vault's zeroed/defaulted named-field columns (the same "leaf-list vault
  reads named-field columns unguarded" bug class closed everywhere else
  this session, just never reached the wizard's own resume path). The
  Keys step would then render the WRONG slots (fixed Signing/Heir keys
  instead of the vault's real per-path slots), and `runCompile`'s
  `shape==='standard'` branch would call the STANDARD compile endpoint --
  silently compiling a completely different vault than the one actually
  configured, the most serious kind of "hands it where it's not supposed
  to go" this audit could have found. Fixed with a new `isLeafListVault`-
  gated branch plus a new `leafDraftFromSpec` (the exact inverse of the
  existing `leafDraftToSpec`), reconstructing `leafDrafts` from
  `v.leaves` the same honest way the standard/bloc branches already
  reconstruct their own "planned count" UI-only fields (quorum as a
  floor, since a draft's `keys` array is empty at this stage -- key
  selections were never persisted mid-flow for any shape, only the
  policy shape itself). (2) The "Continue -- add keys next" button was
  gated only on `busy`, never on the two validity warnings
  (`hasImmediate`/`hasUnsetAfter`) sitting right above it -- and Configure
  is the ONLY step that can edit a path's timing at all; Keys and Compile
  have no way back to it. An invalid shape could leave Configure, get
  real keys picked for it, and only then fail at the actual Rust compile
  step with "Back to keys" as the sole recovery option -- which has no
  controls for the timing problem in the first place. Extracted the two
  checks into a shared `leafShapeIssues()` (previously computed inline
  only inside `LeavesConfigureFields`) and used it to disable Continue
  and show a clear reason, closing the dead end before it can be created
  rather than trying to add an escape hatch after the fact. (3) Building
  the "Revocable living trust" preset hardcoded its three paths' labels
  directly as trust terms AND set `trustLabeled = true` without ever
  snapshotting `preTrustLabels` -- so unchecking "Use trust wording"
  afterward hit the toggle's `else if (preTrustLabels)` branch, found it
  `null`, and did nothing: the checkbox visually unchecked while the
  labels silently stayed trust-worded, contradicting its own "restores
  the labels you had before" copy. Fixed by making the preset build
  PLAIN-language labels and routing it through the exact same snapshot-
  then-`applyTrustLabels()` mechanism the manual checkbox already uses,
  so the preset and the checkbox are one mechanism instead of two
  independently-hardcoded label sets that could drift apart (already
  slightly had: the preset's own "incapacity backstop" phrasing differed
  from `applyTrustLabels`'s generic "if quiet for a while" for the same
  leaf shape -- reconciled to the more descriptive "incapacity backstop"
  everywhere, single source of truth now). Everything else traced --
  disabled-secondary-leaf filtering (`enabled = leafDrafts.filter(...)`,
  consistent across Configure/Keys/compile), per-leaf key-slot labeling
  in `KeysStep`, `key_origins` wiring, decay-ladder wire format, numeric
  bounds and timelock-floor validation in `compile-leaves.js` -- was
  already correct, confirmed rather than re-fixed. All four gates green,
  matching the documented baseline exactly (typecheck's known
  pre-existing errors merely shifted line numbers, zero new lint
  warnings).

- **Shape-story card and the trust-wording checkbox consolidated into one
  collapsible box, matching the layer-education accordion above it
  (2026-08-25).** Direct follow-up to the front-door consolidation just
  above: operator: "the bill of irrevocable trust and they used trust
  language are two of the same button. They need to be consolidated to
  one expanding box... need to be the same expandable as the other ones."
  Read precisely: `LeavesConfigureFields` had the "Read the story, then
  build it" `Card` (the Revocable living trust `ShapeStoryCard`) and the
  "Use trust wording" `Card` sitting right below `VaultLayersAccordion`
  as two permanently-open blocks, while the accordion rows directly above
  them collapse -- an inconsistent, real-estate-heavy pair the operator
  correctly clocked as redundant (turning trust wording on is already the
  natural next step after building the trust preset). Extracted the
  accordion rows' header/border/expand presentation into a new shared
  `CollapsibleRow` primitive (`VaultLayerAccordionRow` now composes it
  instead of duplicating the markup), then rebuilt the two Cards as one
  `CollapsibleRow` -- "Shape preset & trust wording," collapsed by
  default -- whose expanded body holds the shape-story card(s), the
  pending-switch confirmation, and the trust-wording checkbox together,
  unchanged in behavior otherwise (same `requestApplyTab`/
  `toggleTrustLabels` handlers, same content). Named-field and Bloc
  vaults untouched; this only reaches `LeavesConfigureFields`. All four
  gates green, matching the documented baseline exactly (typecheck's
  known pre-existing errors merely shifted line numbers, zero new lint
  warnings). Browser verification hit the same two pre-existing sandbox
  limitations as the entry above (dev-mode opentimestamps dep-scan
  failure, no `VITE_SUPABASE_URL` in this environment) -- not
  browser-verified, noted honestly; `npm run build`'s clean exit is the
  strongest signal available here.

- **Front-door education pages collapsed into a collapsible accordion atop
  the builder -- /start and /start/:layerId retired (2026-08-25).**
  Operator: "I want to redo the look of the builder and I want to take all
  of the education and have head tabs at the top... wasted space on that
  whole page... when you click one of those headers and spills out on
  there and has all the same information that it has before and then when
  you're not it just collapses up and then the builder is down there with
  the four different lea[yers]... instead of being several different pages
  and different clicks." Grounded against the real flow before touching
  anything: `/start` (`StartVault.tsx`) showed four big cards -- Primary
  Path, Backup & Recovery, Inheritance, Long-Horizon Backstop
  (`vault-education.ts`'s `VAULT_LAYERS`, exactly four -- confirming "the
  four different lea[yers]") -- each one a full page-navigation to
  `/start/:layerId` (`VaultLayerGuide.tsx`) showing that layer's
  explanation/trade-offs/illustration, whose own "Build it" then navigated
  a third time to `/policy` (`VaultWizard.tsx`), which always opens blank
  (no per-layer preset exists to apply -- confirmed in
  `VaultLayerGuide.tsx`'s own header comment). Three page-hops for what
  the operator wanted as one. Built a new `VaultLayersAccordion` (in
  `VaultWizard.tsx`, right where `ShapeStoryCard` already lived) rendering
  the same four `VAULT_LAYERS` as single-open collapsible rows -- opening
  one closes any other, matching "collapses up" -- directly above the
  vault name/network fields at the top of `ConfigureStep`, with the exact
  same explanation/trade-offs/illustration/howToCraft content
  `VaultLayerGuide.tsx` used to show on its own page. "Build it" inside an
  expanded row has nothing to preset (same reason the old page's "Build
  it" never prefilled), so it scrolls to the primary path card already
  further down the SAME page instead of navigating anywhere -- reusing the
  identical `buildAnchorRef`/smooth-scroll mechanism the shape-story
  "Build it" already used, lifted from `LeavesConfigureFields` up to
  `ConfigureStep` so both "Build it" buttons land on the same spot.
  `StartVault.tsx` and `VaultLayerGuide.tsx` are deleted outright (not
  left as dead code); `/start` and `/start/:layerId` now just redirect to
  `/policy`, so every existing entry point (`config.ts`'s "Start a vault"
  nav link, Dashboard's two "Build your first vault" CTAs, old bookmarks)
  keeps working with zero call-site changes. Caught and fixed two stale
  references while grounding this: the "backstop" layer's `howToCraft`
  text pointed at "More: crafty or specialty paths" in the builder's shape
  tabs -- a tab that was pruned to just "Revocable living trust" in an
  earlier session and no longer exists -- corrected to point at where
  decay ladders and self-refreshing paths actually live now (each path's
  own "After a fixed date" decay checkbox / "If left untouched" timing,
  confirmed by reading `LeafCard`'s real controls); and
  `vault-education.ts`'s header comment, which claimed `VAULT_LAYERS` fed
  two separate page consumers -- updated to describe the real, single
  consumer now that both pages are gone.
  `docs/ux-coherence-redesign.md` section 7 gained a dated item 7
  documenting the consolidation, following the same pattern item 6 already
  used for the page split this reverses. All four gates green, matching
  the documented baseline exactly (typecheck's known pre-existing errors
  merely shifted line numbers; zero new lint warnings). Browser
  verification was attempted but blocked by two separate pre-existing
  sandbox limitations, not anything this change caused: dev mode hits the
  same `tapit-attest`/`opentimestamps` Vite dep-scan failure documented
  earlier in this file's history, and the production preview server has
  no `VITE_SUPABASE_URL` configured in this environment -- noted honestly
  rather than claimed as browser-verified; `npm run build`'s clean exit is
  the strongest signal available here that the bundle is sound.

- **History tab had no way to cancel a pending proposal without drilling
  into "Sign / manage" first (2026-08-25).** Direct follow-up to the
  leaf-list quorum fix above landing live: operator, screenshot of the
  History tab with three PENDING proposals against the same spent UTXO
  left over from testing the broadcast fix, all now permanently
  unbroadcastable double-spends: "Cant delete these." `ProposalCard`
  (`VaultDetail.tsx`'s History tab) only ever rendered "Sign / manage"
  and "Copy PSBT" -- cancelling a proposal was only reachable via the
  full `ProposalDetail.tsx` page's own "Cancel proposal" button at the
  bottom, several taps away from the list showing the clutter. Added a
  "Cancel" button directly to the History card, gated the same way
  `ProposalDetail.tsx`'s own button is (`!terminal && !isTrancheClaim`
  -- tranche claims are signed/broadcast entirely inside
  `TrancheClaimModal`, never from this page) and calling the identical
  `api.proposals.update(id, { status: "cancelled" })` PATCH. `onRefresh`
  (passed in from the parent's `load` as `HistoryTab`'s prop but
  previously discarded with `void onRefresh` since nothing on the card
  needed it yet) is now threaded through `ProposalCard` and called after
  a successful cancel so the row updates in place without a manual
  reload. All four gates green, matching the documented baseline exactly
  (typecheck's known pre-existing errors merely shifted line numbers).

- **The "leaf-list vault reads named-field columns unguarded" bug class,
  audited end to end and closed with a canonical shared reader instead of
  another one-off patch (2026-08-25).** Operator, after the fourth
  independent instance of this exact bug got fixed in one day (VaultDetail's
  duplicate paths block, the Send-tab "Unknown path: founders_now" error,
  the key_origins hardware-signing failure, each entry above this one):
  "All of the numbers of signers bugs need to be found and squashed. We
  need to rethink how it's programmed. How it logics through it in
  different places." Read as two asks, not one -- find every remaining
  instance, and stop the bug class from being able to recur, not just
  patch the latest symptom. A full-repo audit found 18 separate,
  independently hand-written implementations of "what are this vault's
  real spending paths" scattered across the frontend and Netlify
  functions, 8 of which still read `founder_quorum`/`founder_keys`/
  `heir_quorum`/`heir_keys`/`recovery_after`/`inheritance_after` with no
  guard for a leaf-list vault (whose real paths live in `vault.leaves`,
  with those named-field columns sitting at their bare DB defaults).
  Rather than hand-patch each site with its own copy of the
  `Array.isArray(vault.leaves) && vault.leaves.length > 0` branch --
  which is exactly how the bug class kept reappearing in the first place
  -- built one canonical reader in two mirrored, test-bound
  implementations: `apps/web/src/lib/vault-spending-paths.ts` (frontend
  TS: `isLeafListVault`, `getSpendingPaths`, `findSpendingPath`) and
  `netlify/functions/_vault-shape.js` (the byte-for-byte plain-JS twin
  Netlify functions actually need, since `netlify/functions/` has its own
  separate `package.json`/dependency list disjoint from the root npm
  workspace -- a cross-package `@dynastytrust/policy-engine` import was
  considered and rejected for the same reason). New
  `scripts/test-vault-spending-paths.mjs` (now part of `npm test`) proves
  the two copies stay byte-identical across 7 fixtures spanning both
  vault shapes, the same binding-test pattern `test-rung-digest.mjs`
  already established for keeping `assistant.js`'s hand-copied curriculum
  digest bound to `literacy.ts`. Eight real bugs fixed with the new
  helper, ranked by what was actually broken versus merely wrong-looking:
  (1) `vaults-rotate.js` would have silently rotated a leaf-list or Bloc
  vault's signing keys while leaving its `leaves`/`bloc_policy` completely
  unchanged -- a live fund-loss bug, not a display bug -- so rotation for
  both shapes is now explicitly rejected server-side (`VaultDetail.tsx`'s
  Rotate button hidden client-side to match) rather than silently
  producing a vault whose Taproot tree no longer matches its own
  metadata; building real rotation support for these shapes (absolute-vs-
  relative timelock carry-forward, etc.) is a separate, larger feature,
  not attempted here. (2) `psbt-merge.js` compared a leaf-list proposal's
  collected signatures against the wrong (named-field) quorum number when
  deciding if a PSBT was fully signed -- now resolves the real leaf's
  quorum via `findSpendingPath`. (3) `ProposalDetail.tsx`'s
  `resolvePathSigners` had no leaf-list branch at all, so a leaf-list
  vault's proposal could never actually be resolved to its real
  signer set for display/signing. (4) `governance.js`'s `/status` and
  `/audit` actions unconditionally forwarded to the Fly.io Rust compiler,
  whose `GovernanceStatusRequest`/`GovernanceAuditRequest` structs have no
  `leaves` field at all (task #135's leaf-id governance generalization
  only ever reached `governance.rs`'s internal logic, never these two
  HTTP handlers) -- for a leaf-list vault this silently evaluated against
  zeroed founder/heir data, which would show every path as already
  unlocked. Fixing the Rust side needs a Fly.io redeploy outside this
  session's reach, so leaf-list vaults are now routed to new, genuinely
  correct pure-JS equivalents (`jsGovernanceStatusLeafList`/
  `jsGovernanceAuditLeafList`, exported from `governance.js`) instead --
  confirmed dead/dormant from the live UI (no shipped page calls
  `/api/governance`) so this carried no live-surface risk, but is now
  honestly correct rather than silently wrong for whenever that surface
  gets built. (5) `proposals.js`'s `runGovernanceAudit` -- which writes
  the PERMANENT audit-trail record every PDF/tax/activity export treats
  as ground truth -- had the identical bogus-forward problem for a
  leaf-list vault's proposals; now calls the same `jsGovernanceAuditLeafList`
  from (4) instead of building a named-field request body. (6)
  `invites-lookup.js` sent nothing but bogus founder/heir numbers for a
  leaf-list vault's invite preview; now also sends `is_leaf_list` +
  `paths` (real per-leaf label/quorum/timing), and `InviteClaim.tsx`
  branches its "What you are joining" Fact grid to render the real paths
  instead of the fixed Trustees/Successors/Recovery/Inheritance facts
  (`api.ts`'s `invites.lookup` response type widened to match). (7)
  `Reminders.tsx` and `RemindersBanner.tsx` each independently computed
  false "Recovery path unlocks in ~X days" / urgent "Inheritance path is
  now spendable" reminders and banners for a leaf-list vault's
  owner/founder/heir-role members, driven by the same zeroed
  `recovery_after`/`inheritance_after` defaults -- both now skip those
  two named-field countdown blocks entirely for a leaf-list vault via
  `isLeafListVault`, rather than inventing a new founder/heir-role
  mapping onto arbitrary leaf labels that doesn't exist for this shape.
  (8) `assistant.js`'s Sage context assembly (`VAULT_SAFE_FIELDS`, the
  `vaultContext` template string) would have taught the model -- and then
  the user -- bogus quorum/timelock numbers for a leaf-list vault the
  moment a vault-scoped chat surface gets wired up; currently dormant
  (no live route passes `vault_id` yet) but fixed for correctness ahead
  of that surface shipping, branching on `isLeafListVault` to list real
  per-leaf data via `getSpendingPaths` instead. Deliberately NOT done in
  this pass, and said so rather than silently attempted: the other 12
  already-correct duplicate implementations the audit found (VaultDetail's
  own several fixed functions, Dashboard.tsx, descriptor-backup.ts,
  legacy-recovery.ts, trust-doc.ts, VaultMembershipSetup.tsx,
  circle-membership-delivery.ts, psbt-binary.js, vault-pdf.js,
  vault-audit-pdf.js, vault-tax-summary.js) are NOT migrated onto the new
  canonical helper -- they already produce correct output today, and
  touching already-correct code to satisfy an architectural preference
  is exactly the kind of unrequested refactor this file's own doctrine
  warns against; a real follow-up if the operator wants the whole
  codebase converged onto one implementation, not attempted silently
  here. Named-field and Bloc vaults are byte-for-byte unchanged
  everywhere in this pass. All four gates green, matching the documented
  10/10 baseline exactly (11 pre-existing lint warnings, not 10 -- the
  file's own already-documented count; `Reminders.tsx`'s and
  `RemindersBanner.tsx`'s pre-existing `react-refresh/only-export-
  components` warnings on `getRemindersEnabled`/`useReminderCount` are
  untouched by this pass, not new).

- **A leaf-list vault could never actually be signed by a real hardware
  wallet -- "Signing with this seed did not add a valid signature"
  (2026-08-25).** Direct follow-up to the same day's Send-tab fix, which
  was the first thing that ever let a leaf-list vault's PSBT reach a real
  signer at all -- this is the bug that was sitting underneath it,
  invisible until then. Operator, photo of the SeedSigner error screen
  after finally getting a transaction QR to scan: exactly that message.
  Root cause, traced end to end: `compile-leaves.js` -- the leaf-list
  shape's own compile endpoint -- never wrote `vault.key_origins`
  (fingerprint + derivation_path per signer) at all, unlike
  `vaults-compile.js` (standard shape) and `compile-bloc`'s
  `bloc_policy.key_origins` (Bloc shape), both of which have written it
  since the 2026-08-12 hardware-wallet fix. With `key_origins` empty,
  `psbt-binary.js`'s `attach_tap_key_origins` call is a no-op (it
  early-returns on an empty list), so no PSBT input for a leaf-list vault
  ever carried BIP371 `PSBT_IN_TAP_BIP32_DERIVATION` -- and a real
  hardware wallet, unlike the browser or a Tapit signer (both match a key
  by searching the leaf script bytes directly, no BIP371 needed),
  strictly requires that field to know which key to sign with. embit's
  `sign_with()` found nothing it could sign, so it added zero signatures
  -- exactly SeedSigner's error text. `VaultWizard.tsx`'s `runCompile`
  already HAD everything needed to build this (the same `leafKeys`
  `SelectedKey[]` per leaf that `buildPsbtKeyOrigins` already turns into
  the right shape for the Bloc shape's compile call) -- it just never
  called that function or sent the result anywhere for the leaves
  branch. Fixed going forward: `api.vaults.compileLeaves` now takes an
  optional `key_origins` argument, `runCompile`'s leaves branch computes
  it via `buildPsbtKeyOrigins(allLeafKeys)` (reordered so `allLeafKeys`
  exists before the call that needs it) and passes it through, and
  `compile-leaves.js` accepts and persists it exactly like
  `vaults-compile.js` does. Fixed for vaults already compiled before this
  landed: a new owner-only, leaf-list-only `key_origins` repair PATCH on
  `vaults.js` (structured special-case block, same pattern as the
  existing `key_label` one, strictly validated -- 66-hex pubkey, 8-hex
  fingerprint, a real BIP32 path shape -- and explicitly rejected for any
  non-leaf-list vault so it can never clobber a shape that already gets
  this right at compile time), plus a silent self-heal effect in
  `VaultDetail.tsx` that runs once per vault load: if the vault is
  leaf-list and `key_origins` is empty, match each leaf's stored pubkeys
  against this browser's own local keys and repair it server-side, same
  spirit as `keystore.ts`'s `repairPubkeys()` -- no action needed from
  the owner, it just starts working the next time the vault page loads.
  `VAULT_FIELDS` gained `key_origins` so the client can actually see
  whether it's already populated before deciding to repair. All four
  gates green, matching the documented 10/10 baseline exactly.

- **PSBT QR now sizes itself to nearly the full viewport width instead of
  a fixed 280px (2026-08-25).** Operator, after finally getting SeedSigner
  to scan a transaction QR: "just need to blow up the QR code instead of
  me having to do it manually every time... as soon as it blows up a
  little bit and takes more of the screen up it scans just fine but don't
  make the user do that." Root cause matched this file's own SPEED
  section on `PsbtQrDisplay.tsx`: SeedSigner's low-res Pi camera needs
  large, easy-to-resolve modules, and the operator's manual pinch-zoom
  was doing exactly what a bigger default render would do automatically.
  New `computeResponsiveSize()` sizes the QR to `min(viewport width - 48,
  480)`, floored at the old static 280 so a narrow window never renders
  smaller than before; a `renderSize` state recomputes it on mount and on
  window resize/orientation change, replacing every direct use of the old
  fixed `size` prop (the QR generation width, the placeholder box, the
  `<img>` dimensions, and the fingerprint-box/helper-text max-width) --
  an explicit `size` prop still overrides it when passed, but no call
  site currently passes one. All four gates green, matching the
  documented 10/10 baseline exactly.

- **Send tab: a leaf-list vault could not actually be spent from at all --
  "Compiler error: Unknown path: founders_now" (2026-08-25).** Operator,
  pasting the live Send tab: the "Spend path" dropdown offered "Founders
  now (2 of 0) -- no waiting" and "Recovery (2 of 0 founders) -- after
  timelock" for a real 2-leaf vault ("Everyday signers" 1 of 1,
  "Path 2" 1 of 1) -- same bogus-default display bug as every other
  entry in this history for this vault shape, but this instance was
  functional, not cosmetic: hitting "Review & sign" with the default
  selection failed outright, since `psbt-binary.js`'s leaf-list branch
  (`leafListSignerCounts`) only ever recognizes a real `vault.leaves[]`
  entry's own `id` as a valid `path` -- never the five named-field path
  ids ("founders_now" etc.) `SendTab`'s `standardPath` state was hard-
  typed to and defaulted to. The backend has supported arbitrary leaf-id
  paths since the leaf-list generalization (`policy_compiler.rs`,
  `psbt_builder.rs`, `compiler/main.rs` -- all already generic); the gap
  was entirely that `SendTab` never grew a leaf-list branch of its own.
  Fixed with the same `isLeafList` discriminator now hoisted at the top
  of `SendTab`: `hasRecovery`/`hasInheritance`/`hasBackup`/
  `hasSecondInheritance` all gained a `!isLeafList &&` guard so the old
  named-field dropdown can never show for this vault shape again;
  `standardPath`'s type widened from the closed 5-value union to `string`
  and its initial value now defaults to the vault's first immediately-
  spendable leaf id (falling back to the first leaf) instead of the
  literal `"founders_now"`; a new leaf-list-only dropdown (hidden for a
  single-leaf vault, same "only show a picker once there's a real choice"
  rule the named-field one already follows) lists each real leaf by its
  own label/quorum/timing; and the signer-discovery `if (bp) {...} else
  {...}` in `buildAndSign` gained an `else if (isLeafList)` branch that
  finds the leaf by `id === standardPath` and pulls its real `keys`/
  `quorum` instead of falling through to the `founders_now` case's
  `vault.founder_keys` (empty for this shape). Named-field and Bloc
  vaults are byte-for-byte unchanged. All four gates green, matching the
  documented 10/10 baseline exactly (the file's known pre-existing
  typecheck errors merely shifted line numbers).

- **VaultDetail: a leaf-list vault showed the correct spending paths at
  the top of the page AND a bogus, stale duplicate below them
  (2026-08-25).** Operator, pasting the live page for a 2-leaf custom
  vault: the top correctly showed "Everyday signers 1 of 1" / "Path 2
  1 of 1, locked until block 990,193" via `VaultStructureTree`, but
  further down a second, older block read "PATH 1 Trustees - Now: 2 of
  0 trustee signatures required," "PATH 2 Recovery: Trustees can
  recover after 0 blocks," "PATH 3 Inheritance: 2 of 0 successor
  signatures after 0 blocks," and a "Details" table showing "Trustee
  quorum: 2 of 0" and "Recovery: unlocks at block 26,000." Same root
  cause as every other entry in this history for this vault shape --
  `founder_keys`/`heir_keys` sit empty and `founder_quorum`/
  `recovery_after`/`inheritance_after` sit at their bare DB defaults
  for a leaf-list vault -- but a NEW instance of it: this `paths`/
  "Details" block is older code that predates `VaultStructureTree`'s
  own leaf-list branch and was simply never given the same
  `Array.isArray(vault.leaves) && vault.leaves.length > 0` gate that
  already wraps `VaultPhaseCard`/`VaultStructureTree` two lines above
  it -- so for a leaf-list vault both the correct, newer summary AND
  the stale, older one rendered on the same page, one right under the
  other. Fixed by wrapping the entire `paths.map(...)` block and the
  "Details" table in a new `!isLeafList` check, the same discriminator
  now hoisted once at the top of the component (`const isLeafList =
  Array.isArray(vault.leaves) && vault.leaves.length > 0`) rather than
  inlined again. Named-field and Bloc vaults are byte-for-byte
  unchanged -- this only hides a block that was already fully redundant
  with `VaultStructureTree` for the one vault shape it was wrong for.
  All four gates green, matching the documented 10/10 baseline exactly
  (the file's known pre-existing typecheck errors merely shifted line
  numbers).

- **Custom leaf-list builder pruned to the Revocable living trust story
  only -- every other shape story and the "Common paths to add" checkbox
  menu removed (2026-08-25).** Operator, on the checkbox-menu-plus-story-
  cards redesign from the day before: "the only one that I want in there
  is the revocable trust... anything to do with the normal four leaves
  and configuration of those four leaves leave it off. I don't want
  suggestions. Only the revocable trust one." Read precisely against
  `LEAF_SHAPE_TABS`: "the four different leaves" is the four non-trust
  shape stories (`simple`, `deep-recovery`, `self-refreshing`,
  `long-horizon-family-vault`) and "the different checkboxes" is the
  three `COMMON_PATH_TEMPLATES` entries (Recovery / Heirs / Heirs-
  decaying) added the day before -- both removed entirely, along with
  the now-dead `mainTabs`/`moreTabs` grouping, `toggleCommonPath`, the
  `CommonPathTemplate` interface, and the "Common paths to add" card.
  `LEAF_SHAPE_TABS` now holds exactly one entry, Revocable living trust,
  kept because it does something none of the removed ones did -- it
  drives the "Use trust wording" (Grantor / Successor Trustee /
  Beneficiary) relabeling toggle, a real behavior difference, not just a
  numbers preset. The underlying generic leaf editor (primary/secondary
  `LeafCard`s, "+ Add another path") and the trust-wording toggle are
  both untouched and still fully available -- removing the presets
  doesn't remove the ability to hand-build any shape, it only removes
  the suggestion layer on top. All four gates green, matching the
  documented 10/10 baseline exactly, zero new errors or warnings in
  `VaultWizard.tsx`.

- **Cross-device transaction-fingerprint check: coordinator and air-gapped
  signer show a matching short hash before signing (2026-08-24).** Operator,
  thinking through a vault with a lot of leaves and a small hardware-signer
  screen: "is there a way to have a verification of like saying the first
  few digits of the hash of the transaction you're signing and then the
  coordinator has that same hash on its screen and then when it goes over
  to the signer, you could almost just verify that same hash... there's no
  way they can fake the wrong hash." Correct and cheap to add: the fingerprint
  is the ordinary Bitcoin txid -- double-SHA256 over version/inputs/outputs/
  locktime, byte-reversed -- which deliberately excludes witness data, so for
  this app's Taproot-only vaults it's identical whether zero, some, or all
  required signatures are present yet, meaning the coordinator can show it
  for an unsigned PSBT and it still matches what the signer computes after
  signing. Verified byte-for-byte identical between the two independent
  implementations on a real PSBT fixture before shipping either side.
  DynastyTrust (`apps/web/src/components/PsbtQrDisplay.tsx`): new exported
  `psbtTransactionFingerprint(psbtHex)` parses the PSBT via
  `@scure/btc-signer`, hashes `Transaction.unsignedTx` (NOT the `.id` getter,
  which throws "Transaction is not finalized" for anything short of a fully
  signed PSBT -- exactly every PSBT this component ever displays, since its
  whole job is showing an unsigned or partially-signed one for someone to go
  sign), and returns the first 8 hex chars. Wired into the QR display via
  `useMemo`, rendered as two 4-char groups ("abcd efgh") in a gold-bordered
  box under the QR with copy naming both what a match proves (same bytes,
  catches a corrupted/swapped QR transfer) and what it doesn't (a compromised
  coordinator could show a false amount/address on its own screen while
  sending the real, matching bytes here -- this is a fast supplementary
  check, never a substitute for reading the real transaction details).
  SeedSigner fork (`stackingunderpressure/seedsigner`, same branch): new
  `PSBTTransactionCheckView`/`PSBTTransactionCheckScreen` inserted into the
  PSBT review flow immediately after `PSBTOverviewView`, computing
  `psbt_parser.psbt.tx.txid().hex()` via embit and showing the same first-8
  grouping with "Compare this to what your coordinator shows before
  continuing," then proceeding into the existing, unchanged leaf/spend-path
  routing. `tests/test_flows_psbt.py` updated at 5 call sites; full suite
  (273 tests) and the psbt/taproot/multisig-scoped subset (112 tests) both
  verified passing in that repo's actual test venv (which is wired to a
  second clone at a different path -- edits were made only in the correct
  branch's clone, temporarily mirrored into the test venv's clone to run
  pytest, then reverted there so nothing landed in the wrong place). All
  four DynastyTrust gates green, matching the documented 10/10 baseline
  exactly (one new intentional lint warning on `PsbtQrDisplay.tsx` --
  `react-refresh/only-export-components`, the same accepted pattern already
  used for `ToastProvider.tsx`/`KeyPicker.tsx`/`DialogProvider.tsx` when a
  component file also exports a plain function -- 0 lint errors either way).

- **Custom leaf-list builder: shape tabs became full readable stories
  with a "Build it" button, plus an always-visible checkbox menu of
  common paths (2026-08-24).** Operator: "all of the leaves are visible
  and not an add another leaf path but like check this box if you wanna
  add to leave that way, everyone can see the builders almost there for
  everybody all the way." Follow-up, confirming scope: only the custom
  leaf-list builder (the named-field one stays untouched), full
  configurability preserved regardless of how a path got added, and --
  the one hard requirement -- "make sure that they are the correct
  checkboxes and not pull up some weird pattern." Grounded against
  `LEAF_SHAPE_TABS` before writing anything: three of the seven shape
  tabs (`family-inheritance`, `passing-it-on`) turned out to be EXACTLY
  primary-leaf-plus-one-or-two secondary paths with nothing unique to
  that tab; the other five (`simple`, `deep-recovery`, `self-refreshing`,
  `long-horizon-family-vault`, `revocable-living-trust`) each modify the
  primary leaf itself or tell a genuinely single coherent story, so they
  stayed as one-click builds rather than being force-fit into checkboxes.
  New `COMMON_PATH_TEMPLATES` (3 entries: Recovery, Heirs/Inheritance,
  Heirs-decaying-over-time) carries the EXACT numbers the two retired
  tabs used (26,280 / 52,560 / 52,560+decay blocks) -- nothing invented,
  every default traces to a real previously-shipped tab, directly
  answering the "correct checkboxes" requirement. Each template gets a
  fixed id (`tmpl_recovery` etc.) instead of the usual counter-based
  one, which is what lets the checkbox's checked state track "is this
  exact template's leaf currently on the canvas" cleanly -- renaming or
  re-tuning the resulting path afterward doesn't affect the checkbox,
  only removing it does. The five surviving shape tabs became
  `ShapeStoryCard`s: full title + why-text + a "Build it" (or "Rebuild
  it" once active) button, all visible at once instead of a compact
  button row whose description only appeared after clicking. `applyTab`
  now scrolls the primary leaf card into view after building -- "make
  sure it takes you to the right place" -- via a ref on the primary
  `LeafCard`, so hitting Build it lands you looking at what was actually
  built, not still scrolled up at the story list. "+ Add another path"
  stays for anything not covered by a story or a checkbox. All four
  gates green, matching the documented 10/10 baseline exactly; live
  browser verification hit a pre-existing, unrelated Vite dev-server
  issue (tapit-attest's `opentimestamps` dependency fails Vite's dep-scan
  in dev mode specifically -- the production build, already gated,
  builds it cleanly) -- noted honestly rather than claimed as
  browser-verified.

- **Dashboard vault cards showed the same bogus "2/0 founders, 2/0
  heirs" quorum summary for a leaf-list vault -- same bug class,
  different file (2026-08-23).** Operator, screenshot of the live
  dashboard: "Key counts off in pic again." The "Onchain descriptor
  test" card (a real 2-leaf custom vault, "Grantor" quorum 1/1
  immediate, "Successor" quorum 1/1 after ~19yr) showed "2/0 founders,
  2/0 heirs, Recovery ~6mo" -- `founder_quorum`/`heir_quorum` (DB
  default 2) with empty `founder_keys`/`heir_keys` arrays and
  `recovery_after`'s bare default, the identical DB-default-driven
  pattern already fixed in `VaultDetail.tsx`'s `computePhase`/
  `rolePhaseHint`/`buildVaultLeaves`, `descriptor-backup.ts`'s
  `vaultBackupText`, and `LegacyRecoverySetup.tsx`'s `rolesForVault` --
  just never carried over to `Dashboard.tsx`'s own card summary, which
  reads those same named-field columns unconditionally with no branch
  for `vault.leaves`. Fixed with the same `Array.isArray(v.leaves) &&
  v.leaves.length > 0` discriminator: the card now renders one span per
  real leaf (`{label}: {quorum}/{keys.length}`, plus a compact
  `blocksToLabel`'d timing hint for an `after`-type leaf), matching the
  two-span pattern the file's own Bloc-vault branch already uses right
  above it. Two smaller instances of the same root cause caught in the
  same file while grounding this: `roleStatus`'s heir case computed
  "Inheritance unlocks in ~6mo" from the same bogus `inheritance_after`
  default for a leaf-list vault's heir-role member -- now falls back to
  the honest "Successor on standby" text for that shape instead of a
  countdown from a number that was never configured; and the dashboard
  summary cards' "soonest inheritance" figure (aggregated across every
  vault where the caller holds a heir role) now excludes leaf-list
  vaults from that comparison entirely rather than letting a bogus
  default win against a real named-field vault's real number.
  Deliberately NOT touched in this pass: `PendingRow`'s signed/quorum
  badge (`item.vault.founder_quorum`) for a pending proposal, which has
  the same class of gap but needs more than a frontend branch to fix
  correctly -- the `proposals-mine` endpoint's joined `vault` object
  only ever selects `founder_quorum`/`heir_quorum`, never `leaves`, and
  `Proposal.path`'s type is a closed union of the five named-field/
  Bloc/tranche path names with no room for an arbitrary leaf id, even
  though a leaf-list vault's proposals actually use the leaf's own id
  as `path` (per this vault shape's existing convention, see the
  Tapit circle-membership entry below). Not visible in the reported
  screenshot and not fixed blind -- noted here as a known follow-up
  rather than silently patched without the backend grounding it needs.
  All four gates green, matching the documented 10/10 baseline exactly.

- **Legacy Recovery: the standalone offline tool had no way to sign with
  a software-held mnemonic, only a pasted-in signature -- and a design
  question this surfaced about whether software keys should offer
  Legacy Recovery at all (2026-08-23).** Operator, after sealing a
  payload and testing recovery: "I sealed payload but when I go to test
  it in the recovery tool that software wallet can't sign and return
  the encryption key." Diagnosed precisely: the standalone tool
  (`tools/legacy-recovery/recover.ts`) deliberately imports nothing from
  `keystore.ts` -- no `listKeys`, no `revealMnemonic` -- since its whole
  point is working even if DynastyTrust's app and storage are both gone.
  That's correct for its stated purpose, but left a real hole: a
  software-held key (no hardware wallet at all) had no way to produce
  the recovery signature from inside that same tool, only the in-app
  "Retrieve a descriptor" page's "Sign locally with..." button could.
  Follow-up design question, put directly rather than assumed: should
  software keys even be allowed to seal a Legacy Recovery share, given
  this exact gap? Answered no -- the real requirement isn't "hardware
  vs. software," it's "does this exact seed still exist somewhere
  independent of wherever it currently lives" -- true of hardware wallets
  too (a Coldcard with no separately-written seed has the identical
  problem). Landed on: keep software keys eligible, close the actual
  gap, and be honest about the requirement at the point it matters.
  `recover.ts` gained a "sign locally with this seed phrase" field
  (mnemonic textarea, network reused from the existing select) that
  calls `signLegacyOnChainNonce` -- the exact same pure function the
  live app's seal step and recovery page already call -- decodes the
  scriptPubKey already pasted in to find the nonce, signs, and fills
  the signature field automatically. Nothing new stored anywhere: the
  standalone tool holds no state at all beyond the current tab, same as
  before. `LegacyOnChainV2Card`'s software-mode seal step
  (`LegacyRecoverySetup.tsx`) gained a warning directly above the
  "Seal payload" button: this only recovers later if the seed phrase
  still exists independent of this browser, and if it doesn't yet,
  write it down first -- since losing this browser already breaks the
  ability to spend from that key at all, not just Legacy Recovery.
  `scripts/verify-legacy-recovery-tool.mjs` extended with a third,
  real-browser Playwright pass driving the new field end to end (types
  a real mnemonic in, clicks sign, confirms the filled signature
  byte-matches an independently-computed one, then confirms recovery
  from it matches the original bundle exactly) -- not just type-checked,
  actually exercised in a headless Chromium against the rebuilt tool.
  Standalone tool rebuilt (`node tools/legacy-recovery/build.mjs`). All
  four gates green, matching the documented 10/10 baseline exactly.

- **Legacy Recovery's seal/publish progress had no durability at all --
  every field reset the instant the page unmounted (2026-08-23).**
  Operator: "it seems like it just disappears and then acts like you
  need to do it again ... we need to have it more durable where you can
  see all of the info ... and it's stay there until deleted or
  whatever." Grounded directly against `LegacyOnChainV2Card`
  (`LegacyRecoverySetup.tsx`): every piece of state -- which key,
  the derived address, the sealed OP_RETURN payload, a built-but-not-
  yet-broadcast publish transaction, even the xpub typed in for the
  hardware path -- was plain `useState` with zero persistence, so
  navigating away or reloading wiped it back to a blank form even
  though the underlying seal/publish had already succeeded. This was
  never about the recovery MECHANISM needing a database (the chain is
  still the only place the actual secret lives -- see
  legacy-onchain-recovery.ts's header), it was purely the UI's own
  in-progress state having nowhere to live between visits. New
  `apps/web/src/lib/legacy-recovery-progress.ts` persists that
  progress to `localStorage`, scoped per vault id + per role slot
  (`dynastytrust:legacy-recovery:<vaultId>:<role>`), with save/load/
  clear functions. Deliberately does NOT persist secret material: no
  password, no revealed mnemonic (already durable in keystore.ts's own
  encrypted store, never touched by this module), and critically no
  pasted hardware signature -- a signature is the exact input
  `deriveLegacyOnChainKey` turns into the AES decryption key, so
  keeping one around next to its already-persisted nonce and
  ciphertext would let anyone with browser storage access decrypt the
  sealed payload without the real key, defeating the mechanism's whole
  point. Once a seal succeeds the signature that produced it is simply
  never saved -- `payloadHex` is the artifact that matters from then
  on, and it's already meant to be public. `LegacyOnChainV2Card` now
  hydrates from storage on mount (re-checking the chain for an
  already-found candidate if an address was saved) and writes back on
  every meaningful change, guarded by a `hydratedRef` so the initial
  blank state can't clobber what was already saved before the load
  effect runs. A new "Start over" link (visible once there's anything
  to clear) calls `clearLegacyRecoveryProgress` and resets every field
  to its default -- the explicit "until deleted" the operator asked
  for -- with copy clarifying it only clears this browser's local
  record, never anything already published on-chain. Verified with a
  standalone round-trip script (save/load/clear, scoping confirmed
  per-vault and per-role) since exercising the full click-through
  needs a live authenticated vault this environment doesn't have --
  noted here rather than claimed as browser-verified. All four gates
  green, matching the documented 10/10 baseline exactly.

- **Legacy Recovery's on-chain payload shrunk from the full downloadable
  backup to just the descriptor -- roughly 70% smaller, cutting the
  publish fee by about two-thirds (2026-08-23).** Operator, after asking
  for a cost estimate on the on-chain OP_RETURN payload: "do you think we
  should drop it down to the descriptor only and the person can figure
  out how to recover the descriptor and we can save money by not having
  such a large job return." Measured first, not guessed: `vaultBackupText()`
  -- what `sealOnChainPayload`/`sealOnChainPayloadExternal` were encrypting
  and publishing -- carries a ~2,450-byte fixed block (headers plus the
  Sparrow/Nunchuk/timelock/Legacy-Recovery instructions paragraph,
  identical on every seal, vault-agnostic) on top of vault-specific data
  that ALSO duplicates every xpub a second time in a flat listing already
  redundant with the xpubs embedded in the descriptor's own key
  expressions. For a realistic 9-key vault (3 founders/3 backup/3 heirs)
  that's a ~5,330-byte plaintext bundle; for the operator's own small
  2-leaf "Onchain descriptor test" vault, ~2,760 bytes. This file's own
  RECOVERY INSTRUCTIONS text already states the real minimum needed to
  monitor and spend a vault: "1. The output descriptor. 2. At least one
  signer's seed phrase" -- everything else in the bundle is either
  redundant with the descriptor or generic boilerplate that doesn't need
  to be paid for and permanently written to the blockchain, since it can
  live for free in channels that already exist and already get saved
  locally ahead of time (the same durability assumption the on-chain
  share itself depends on). New `legacyOnChainDescriptorPayload()`
  (`descriptor-backup.ts`) returns just `vault.descriptor`, nothing else
  -- network doesn't need a separate field either, since it's already
  encoded in the descriptor's own xpub-vs-tpub key-version bytes, which
  Sparrow reads directly. Wired into both of `LegacyRecoverySetup.tsx`'s
  seal call sites (`handleSeal`, `handleSealHardware`) in place of
  `vaultBackupText(vault)` -- the downloadable full-bundle backup
  (`downloadVaultBackup`/`downloadVault`) is untouched, this only changes
  what gets encrypted and sent on-chain. No change needed to the
  encoding/encryption layer at all (`encodeOnChainPayload`/
  `decodeOnChainPayload`/AES-GCM) -- `bundleText` was always an opaque
  string as far as sealing and recovery are concerned, so a smaller
  string just produces a smaller payload, with zero format version to
  track (per the operator's earlier, explicit "no versions and this and
  that" instruction on this same mechanism). The instructions that used
  to ride along inside the encrypted payload moved to the two places that
  are already free and already meant to be saved ahead of time: a new
  "ONCE YOU HAVE THE DESCRIPTOR" section in `legacyOnChainRecoveryNoteText()`
  (the downloadable takeaway note) and matching static copy added to the
  standalone offline tool's `template.html`, both covering the same
  Sparrow-import / Nunchuk-BSMS / timelock guidance the on-chain bundle
  used to carry. `DescriptorRetrieval.tsx`'s result box was relabeled
  "Recovered descriptor" (was "Recovered descriptor bundle" -- now
  literally accurate) with a short explanatory line, matching what it now
  actually decrypts to. Cost effect, measured against the same 9-key
  vault: payload dropped from 5,361 bytes to 1,513 bytes (72% smaller),
  cutting the estimated publish cost (fee + the standard 1,000-sat
  billboard payment to the identity address) by roughly two-thirds at any
  fee rate -- e.g. from about 28,565 to 9,325 sats at 5 sat/vB, or 83,695
  to 25,975 sats at 15 sat/vB. Standalone tool rebuilt
  (`node tools/legacy-recovery/build.mjs`) and re-verified end to end
  against a real signed transaction. All four gates green, matching the
  documented 10/10 baseline exactly.

- **The downloadable vault backup -- and therefore every Legacy Recovery
  bundle sealed from it -- showed bogus "Founders: 2 of 0" / "Heirs: 2
  of 0" spending rules for a leaf-list vault (2026-08-23).** Caught while
  reviewing a real mainnet vault's backup text during the Legacy Recovery
  hardware-signing debugging above: a 2-leaf custom vault (`thresh(1,
  pk(A))` immediate, `thresh(1,pk(B))` after a fixed block) showed
  "Founders: 2 of 0 -- no waiting" and "Heirs: 2 of 0" in its "Spending
  rules" section -- the exact same DB-default-driven bug already fixed
  in `VaultDetail.tsx`'s `computePhase`/`rolePhaseHint`/`buildVaultLeaves`
  a few entries below, just never carried over to `descriptor-backup.ts`'s
  `vaultBackupText()`. This one mattered more than a display glitch: this
  exact function's output is `sealOnChainPayload`'s `bundleText` -- the
  content that gets encrypted and PERMANENTLY published on-chain as a
  Legacy Recovery share. Sealing before this fix would have baked the
  wrong spending-rules summary into an unchangeable, decades-durable
  record (the descriptor and miniscript policy text were always correct,
  independent of this bug -- only the human-readable summary was wrong).
  `VaultBackupLike` gained an optional `leaves` field (typed via the real
  `LeafSpec[]`), and `vaultBackupText` now branches with the same
  `Array.isArray(v.leaves) && v.leaves.length > 0` discriminator used
  everywhere else this shape needed one: `spendingRulesLines` lists each
  leaf's own label/quorum/key-count/timing (a new `leafTimingText`
  helper covers immediate/after/older + decay, matching the phrasing
  `buildLeavesTrustDoc` already established), and `keyListingLines` lists
  each leaf's own xpubs under its own heading instead of the fixed
  Founder/Heir sections. Named-field vaults are byte-for-byte unchanged.
  Verified directly against the real vault's actual leaf data (2 leaves,
  quorum 1 each) -- output now reads the real labels and the real block
  height instead of the phantom defaults. All four gates green, matching
  the documented 10/10 baseline exactly.

- **Legacy Recovery: the signed message stripped down to nothing but
  the nonce itself (2026-08-22).** Direct follow-up to simplifying the
  on-chain payload framing (same session, entry below): operator, after
  confirming the on-chain bytes were now genuinely just nonce +
  ciphertext, spotted the SEPARATE signed-message text still carried a
  label: "The text in the message should only be the 12 bytes no other
  text or characters nothing but nonce." Correct distinction to draw --
  the on-chain payload and the signed message are two different things,
  and this closes the same "no versions and this and that" gap in the
  second one. `legacyOnChainNonceMessage(nonce)` (`legacy-recovery.ts`)
  dropped its `"DynastyTrust Legacy Recovery v2\nnonce: "` prefix
  entirely -- the signed text is now just the nonce, hex-encoded, 24
  characters, nothing else. No domain-separation label is needed to stay
  safe: `legacyOnChainDerivationPath`'s fixed, otherwise-unused account
  number (900,000) already IS the domain separator, since nothing else
  ever asks a keyholder to sign anything at that account, so there's no
  other message this signature could be confused with or replayed
  against. `bitcoinMessageDigest`, `seedSignerMessageQrPayload`, and
  every UI call site needed no changes at all -- they all already treat
  the message as an opaque string built from the nonce, never assumed
  anything about its internal shape. **Breaking, same as the payload-
  framing change:** the exact bytes being signed changed, so a share
  already sealed under the old message text needs re-sealing; nothing
  else about the mechanism moved. `scripts/test-legacy-recovery.mjs`
  updated to assert the message is byte-for-byte the hex nonce and
  nothing more. Standalone tool rebuilt and re-verified end to end
  against a real signed transaction. All four gates green, matching the
  documented 10/10 baseline exactly.

- **Legacy Recovery: message-to-sign QR used the bare message text,
  which SeedSigner's camera-scan "Sign Message" input rejects outright
  (2026-08-22).** Operator, scanning the QR added in the previous fix:
  "It says on the seed signer that that QR form format for the message
  is not supported." Grounded directly against SeedSigner's actual QR
  decoder rather than guessing: `DecodeQR.detect_segment_type` and
  `SignMessageQrDecoder.add` (SeedSigner source) require the QR's exact
  literal content to be `signmessage <derivation path> ascii:<message>`
  -- no UR/CBOR framing, no other wrapper -- and every "show as QR"
  toggle this app has (`DescriptorRetrieval.tsx`'s recovery side, the
  new hardware-seal card, and the standalone offline tool) was encoding
  only the bare message, which SeedSigner's decoder doesn't recognize at
  all (it isn't a lenient parser -- an unmatched format is rejected, not
  passed through). New `seedSignerMessageQrPayload(derivationPath,
  message)` (`legacy-recovery.ts`) builds the exact wire string; wired
  into all three QR sites so a fix in one place can't drift from the
  other two again. The standalone tool's `recover.ts` had no notion of
  which network a share was published on at all (it never makes a
  network call, so nothing needed it before) -- gained a small Mainnet/
  Testnet select in `template.html` used only to fill in the derivation
  path's coin-type digit for the QR. `scripts/test-legacy-recovery.mjs`
  extended to lock the exact wire format in place, including a check
  that the message's own embedded newline survives the wrapper
  unmodified. Rebuilt the standalone tool and re-verified it end to end
  against a real signed transaction. All four gates green, matching the
  documented 10/10 baseline exactly.

- **Legacy Recovery: no "show as QR" option for the hardware-seal
  message-to-sign box (2026-08-22).** Operator, on the hardware seal
  flow: "This doesn't have qr for exporting message." Same class of gap
  as the xpub/signature scanner fix just above, in the opposite
  direction: `DescriptorRetrieval.tsx`'s recovery-side message box
  already has a "Show as QR (scan with an airgapped signer)" toggle
  (`QrImage`) alongside its Copy button, so a hardware wallet that
  offers "scan a message to sign" doesn't need the message typed in by
  hand -- `LegacyOnChainV2Card`'s equivalent seal-side box only had
  Copy. Added the identical toggle, reusing the same `QrImage`
  component, with the same "if it offers a scan message QR option, scan
  the code below instead of typing it in by hand" copy the recovery
  side already uses. Resets when a new nonce is generated, same as the
  other per-nonce state in that card. All four gates green, matching
  the documented 10/10 baseline exactly.

- **SLIP-132-prefixed xpubs (zpub, Zpub, ypub, ...) rejected outright as
  a "version mismatch" (2026-08-22).** Operator, after exporting a
  custom-derivation xpub from SeedSigner for the new Legacy Recovery
  hardware flow: "It exported it as a Z pub and we were expecting an ex
  pub and it says version mismatch." Root cause: `HDKey.fromExtendedKey`
  (`@scure/bip32`) validates the encoded version bytes strictly against
  whatever `networkVersions()` passes in -- always the plain BIP32
  xpub/tpub bytes -- so any SLIP-132 script-type-prefixed form (a
  hardware wallet's export screen commonly labels multisig/native-segwit
  accounts as Zpub/zpub/Ypub/ypub/etc. instead of the generic default)
  throws immediately, even though the underlying key data is
  byte-identical -- only the 4 leading version bytes differ. This same
  bug existed in TWO places, not just the one the operator hit:
  `legacyOnChainIdentityFromXpub` (new this session) and `importXpub`
  (`keystore.ts`, the vault-signing-key import path, present since that
  function was written) -- the latter had an even narrower symptom, since
  its own prefix regex (`/^[xt]pub|^[XY]pub/`) didn't even recognize
  zpub/ypub/vpub/upub as valid input at all, and a prefix that DID slip
  past that check would then fail `HDKey.fromExtendedKey` silently
  (caught and swallowed), leaving an empty pubkey that only surfaced
  later as a confusing "missing its pubkey" error at vault-compile time.
  Fixed with one shared function, not two patches: `normalizeXpub`
  (`keystore.ts`) decodes the base58check payload, checks the version
  bytes against the full SLIP-132 public-key table (mainnet and testnet,
  single-sig and multisig, all ten prefixes), and re-encodes with the
  plain xpub/tpub version bytes for the target network -- a pure
  notational conversion, never a different key, verified with a live
  round-trip in this session (encode a real xpub as a synthetic
  Zpub/Vpub, normalize it back, confirm byte-identical to the original,
  and confirm each of the ten version-byte constants independently
  encodes to its own documented SLIP-132 letter prefix). Wired into both
  call sites: `importXpub` now normalizes before deriving (and stores
  the normalized xpub, not the as-typed string -- an output descriptor's
  script type is already carried by its outer function, `wpkh(...)`/
  `wsh(...)`, never by the xpub prefix, so plain xpub/tpub is the
  correct, unambiguous form to persist) and dropped its own narrower,
  now-redundant prefix regex; `legacyOnChainIdentityFromXpub` normalizes
  before deriving the identity pubkey. `importXpub`'s previous silent
  `catch { /* non-standard version bytes */ }` around the whole
  derivation is gone too -- a genuinely bad xpub now throws a clear error
  at import time instead of quietly producing a broken key that fails
  later, matching this repo's fail-loudly-not-silently standard.
  `scripts/test-legacy-onchain-recovery.mjs` extended with a case
  proving a SLIP-132 "Vpub"-prefixed xpub derives the identical pubkey
  as its plain-prefixed form. All four gates green, matching the
  documented 10/10 baseline exactly.

- **Legacy Recovery: no QR scanner on the hardware-wallet xpub/signature
  fields, forcing manual retyping (2026-08-22).** Operator, after finding
  SeedSigner's custom-derivation xpub export (buried behind an Advanced
  settings toggle -- see the entry below): "I got it on static and then
  it just wants you to copy and paste. There's actually no scanner mode
  there." Correct and simple: `LegacyOnChainV2Card`'s hardware-mode xpub
  field and signature field were both built as plain `<Textarea>` paste
  boxes with no camera option, even though this app already has two
  tested, working scanner components built for exactly this -- `XpubQrScanner`
  (used in `VaultWizard.tsx`/`KeyManager.tsx`/`InviteClaim.tsx`) and
  `QrScanner` (used in `DescriptorRetrieval.tsx`'s equivalent signature
  field on the recovery side). Wired both in: a "Scan xpub QR" button
  toggles `XpubQrScanner` in place of the xpub textarea, and a "Scan
  signature QR" button does the same for the signature field with the
  plain `QrScanner`, matching the exact pattern `DescriptorRetrieval.tsx`
  already established. No new scanning logic -- this was purely a missing
  wire-up in one page, not a gap in the scanning infrastructure itself.
  All four gates green, matching the documented 10/10 baseline exactly.

- **Legacy Recovery: on-chain payload framing simplified to nonce +
  ciphertext, no magic bytes or version number (2026-08-22).** Operator,
  working through what has to be gotten right by hand 20 years from now:
  "I just feel like the first half of the blob is too complex to get
  right ... The key is already the gate. I want the decryption as simple
  as it can be safely. No reason to have versions and this and that. Just
  need a simple public steady value that you sign ... Not take three
  parts flour and two parts flubber and mix it for 88 mph." Landed on the
  design after ruling out two riskier alternatives first: signing a FIXED
  value (the lookup address itself) instead of a fresh per-seal nonce
  would have derived the exact same encryption key for every seal
  forever, which breaks catastrophically the moment there's ever a
  reseal (already a real, built feature -- see the stale-seal-detection
  entry below) or a second vault from the same seed: same key encrypting
  different data is a hard AES-GCM break, and since the recovery
  signature is already shown on screen as an accepted decades-out
  tradeoff, a fixed signed value would mean ONE exposure burns every past
  and future secret instead of just the one bundle it belongs to.
  Splitting the payload into two genuinely separate OP_RETURN script
  pushes (nonce push, ciphertext push) was also considered and rejected
  once grounded against `onchain-publish.ts`'s actual
  `btc.Script.encode(['RETURN', hexToBytes(opReturnDataHex)])` call --
  ordinary wallets' OP_RETURN UI (Sparrow, Electrum) takes one blob and
  emits one push, so a genuinely two-push format would silently break
  every time someone used the "publish from any wallet" option this app
  already ships and documents at length. The version actually built:
  `encodeOnChainPayload`/`decodeOnChainPayload` (`legacy-recovery.ts`)
  dropped the 4-byte magic tag and 1-byte version number entirely --
  the on-chain bytes are now just the 12-byte nonce (AES-GCM's own fixed
  nonce length, not an app invention) immediately followed by the
  ciphertext, nothing else, still published as a single OP_RETURN push
  so the "any wallet" publish path is unaffected. The magic+version
  existed only so a scanner could cheaply guess "is this ours" before
  attempting a decrypt; AES-GCM's own authentication tag already answers
  that exactly as reliably (a decrypt that doesn't authenticate fails
  cleanly, same as a wrong password), so nothing was lost by removing it
  -- confirmed with a new test proving unrelated junk longer than a bare
  nonce now parses as a structurally-valid-looking candidate (expected,
  not a gap) but still fails to decrypt via the AEAD tag, never silently
  produces wrong output. `extractOnChainCandidates` needed no change at
  all -- it already concatenates whatever pushes a scanned OP_RETURN
  holds into one blob before calling `decodeOnChainPayload`, so the
  simplified single-blob framing is fully backward-compatible with that
  call site. **Breaking, not additive: any payload already published
  under the old magic+version framing will NOT decode under this
  version** -- the old bytes' first 4 bytes ("DTL2") plus version now get
  mis-read as most of what the new decoder treats as the nonce, so a
  previously-sealed and broadcast share needs to be re-sealed and
  re-published under the new format; nothing sealed but not yet broadcast
  needs anything beyond re-sealing anyway, same as any other reseal.
  Standalone offline tool rebuilt (`node tools/legacy-recovery/build.mjs`)
  and re-verified end to end against a real signed transaction
  (`scripts/verify-legacy-recovery-tool.mjs`) -- required no source
  changes in `recover.ts` at all, since `decodeOnChainPayload`'s call
  signature didn't change, only its internals. All four gates green,
  matching the documented 10/10 baseline exactly.

- **Legacy Recovery: the hardware wallet that actually signed a vault's
  spends had no way to seal a Legacy Recovery share at all (2026-08-22).**
  Operator: "The hardware signer I used to make the vault isn't an option
  when trying to do long term recovery." Correct and structural, not a
  small oversight: `LegacyOnChainV2Card`'s key picker only ever listed
  `listKeys().filter(k => k.origin === 'software')` -- a hardware-wallet-
  imported key (`origin: 'imported_xpub'`) has no mnemonic in this browser
  by design, and sealing's only path (`sealBundleOnChain`) required one,
  since it both derives the identity keypair AND signs internally. Simply
  widening the filter would have offered a key sealing could never
  actually use. The recovery (unsealing) side already solved the
  equivalent problem for hardware wallets -- `DescriptorRetrieval.tsx`
  accepts a signature produced externally by a hardware wallet's own
  "Sign Message" feature and pasted back in, no local key needed -- but
  sealing has one extra requirement recovery doesn't: it has to know the
  identity PUBLIC key up front (to compute the address to publish to),
  whereas recovery just takes a manually-entered address and lets a wrong
  signature fail the AEAD decrypt honestly. Considered and rejected: ECDSA
  public-key recovery from the BIP-137 signature header (skips needing an
  xpub at all, but the header-byte convention for recovery id + compression
  varies across wallet vendors for P2SH-segwit/bech32 signing, and getting
  that subtly wrong in money-touching code is exactly the kind of mistake
  this repo's engineering doctrine warns against) -- rejected as needless
  risk when a strictly safer option existed. Built instead:
  `legacyOnChainIdentityFromXpub` (`legacy-recovery.ts`) derives the exact
  same identity pubkey `legacyOnChainIdentity` derives from a mnemonic, but
  from an account-level xpub instead -- valid because only the account
  level (`m/84'/coin'/900000'`) is hardened; the remaining `/1/0` levels are
  plain unhardened BIP32 child derivation, so a SEPARATE xpub exported at
  that exact account (the same kind of "export an xpub at a custom path"
  operation hardware wallets already support, and this app already uses
  for vault-signing-key import) reaches the identical child pubkey a
  hardware wallet's "Sign Message" feature signs against internally --
  with no ECDSA recovery, no header-byte parsing, reusing
  `verifyLegacyOnChainNonceSignature`'s existing, already-tested
  ordinary-verify check unchanged. `sealBundleOnChainExternal` seals given
  a nonce and a signature directly (skipping the mnemonic-derivation step
  `sealBundleOnChain` does internally); `sealOnChainPayloadExternal`
  (`legacy-onchain-recovery.ts`) wires both together and verifies the
  signature against the xpub-derived pubkey BEFORE sealing, so a wrong
  xpub or a signature over the wrong nonce fails loudly there rather than
  silently producing an unrecoverable share. `LegacyOnChainV2Card` gained a
  mode toggle ("Software key in this browser" / "Hardware wallet"): the
  hardware path asks for the account xpub (with the exact path spelled
  out, explicitly NOT the vault's own signing xpub), derives the address
  and checks the chain the same as before, then -- once ready to seal --
  generates a nonce client-side, shows the exact message to sign (the
  same digest DescriptorRetrieval.tsx already asks a hardware wallet to
  sign), and accepts the pasted-back signature via the same
  `parseUnlockSignature` the recovery side already uses (BIP-137 or bare
  64-byte). Everything downstream of "we have an address" -- the download
  note, the publish flow, paying-key selection, broadcast -- is unchanged
  and now shared by both modes, since none of it cared how the identity
  was derived. `scripts/test-legacy-onchain-recovery.mjs` extended with a
  full round-trip proof: an xpub derived from the SAME seed used
  elsewhere in the test produces the identical pubkey
  `legacyOnChainIdentity` does, an externally-produced signature seals a
  bundle that recovers byte-identical to the original, and sealing with a
  signature over the wrong nonce is rejected up front rather than
  producing a dead share. All four gates green, matching the documented
  10/10 baseline exactly.

- **Vault Detail phase card / role hint / spending-paths tree showed
  bogus "2 of 0" quorums and a phantom triggered inheritance path for
  generic leaf-list vaults (2026-08-22).** Operator, on a screenshot of
  a custom-shape "Onchain descriptor test" vault: "Key info is off here
  I think." Grounded the report against the actual data: `founder_quorum`
  (DB default 2), `founder_keys` (default `[]`), `heir_quorum` (default
  2), `heir_keys` (default `[]`), and `inheritance_after` (DB default
  52560) are never set at all for a vault created via `mode:
  "leaves-draft"` (`vaults.js`'s `isLeavesDraft` branch only ever writes
  `leaves`/`consent_keys`/`consent_quorum` -- every named-field column
  sits at its bare `20260615232213_vaults.sql` default). Three functions
  in `VaultDetail.tsx` -- `computePhase` (the phase banner), `rolePhaseHint`
  ("Your role"), and `buildVaultLeaves` (the `VaultStructureTree`
  "Spending Paths" cards) -- read those named-field columns unconditionally
  with no branch for a `vault.leaves`-shaped vault, unlike every other
  surface this codebase already retrofitted for the leaf-list shape (PDF/
  audit/tax exports, `trust-doc.ts`'s `buildLeavesTrustDoc`, Tapit
  circle-membership invites -- see the closed entries below). The result
  matched exactly what the screenshot showed: `founder_quorum=2` with
  `founder_keys.length=0` renders as "2 of 0" in both the phase banner and
  the role-hint line; `inheritance_after=52560` being less than the
  vault's real chain tip made the "INHERITANCE TRIGGERED" banner fire and
  reference "Heirs (Path 3)" even though `heir_keys` is empty, while
  `buildVaultLeaves` only ever pushes that leaf when `heir_keys.length >
  0` -- so it never actually appeared in the Spending Paths list the
  banner referenced. The Trust Document section's "1 of 1" was the one
  correct number in the screenshot, since `buildLeavesTrustDoc` already
  reads the real `leaves` array. Fixed all three functions with the same
  `Array.isArray(vault.leaves) && vault.leaves.length > 0` discriminator
  already used elsewhere: `buildVaultLeaves` now maps each real `LeafSpec`
  to a `VaultLeaf` directly (an `after`-type leaf's stored absolute height
  drives the existing `vaultLeafStatus` locked/unlocked logic same as
  before; an `older`-type leaf is duration-relative-to-last-spend, which
  this view has no chain data to evaluate, so it's shown as available with
  an explanatory note rather than guessed at). `computePhase` and
  `rolePhaseHint` both call the fixed `buildVaultLeaves` to build an
  honest summary from the real leaves instead of the phantom founder/heir
  numbers -- `rolePhaseHint` drops the personalized owner/heir/beneficiary
  persona text for this vault shape (a leaf's role is its own label, not
  one of the fixed `VaultRole` values, so guessing a persona would just
  trade one wrong guess for another) in favor of a plain "currently
  spendable" / "next to open" summary, which is honest rather than
  personalized. Named-field and Bloc vaults are byte-for-byte unchanged --
  this only adds the missing branch ahead of the existing logic, no
  existing rendering path was touched. All four gates green, matching the
  documented 10/10 baseline exactly (the two pre-existing VaultDetail.tsx
  typecheck errors that happen to sit inside `computePhase`'s color-literal
  assignments merely shifted line numbers, confirmed via a stash/typecheck/
  pop comparison against the unmodified file).

- **File downloads (vault backup, Tranche backup, Legacy Recovery note,
  keyring export, descriptor QR PNG) unreliable on mobile, blocking
  vault creation (2026-08-22).** Operator: "When creating a vault, the
  download backup file will not fire and is not working and then it
  will not let you continue because it's not firing." The operator is
  on an iPhone (confirmed from an earlier screenshot's status bar), and
  this is a well-known iOS Safari gap: a `Blob` + `URL.createObjectURL`
  + synthetic `<a download>` click is unreliable there in particular --
  it often opens the raw content in a new tab instead of saving a file,
  or does nothing at all -- and every one of the five download sites in
  this app hand-rolled that exact pattern independently, with the
  anchor never attached to the DOM before `.click()` and the object URL
  revoked synchronously right after (before some engines have actually
  started reading the blob). `VaultWizard.tsx`'s vault-creation
  "Backup" step was the one that actually blocked forward progress:
  `Continue to funding` stays disabled until `downloaded` is true, and
  the old code set `downloaded = true` synchronously the instant the
  button was clicked, regardless of whether anything actually
  downloaded -- so on a phone where the download silently failed, nothing
  told the operator why, but critically the button SHOULD have already
  looked "Downloaded" and let them continue; the fact that it visibly
  didn't states the failure was deeper than "no feedback," matching the
  report of it "not firing" at all. New `apps/web/src/lib/
  download-file.ts` is the one download implementation now used
  everywhere (`downloadVault`/`downloadVaultBackup`,
  `downloadDistributionWalletBackup`, `downloadLegacyOnChainRecoveryNote`
  in `descriptor-backup.ts`; `KeyManager.tsx`'s keyring export;
  `DescriptorQr.tsx`'s PNG download): where the Web Share API supports
  file shares (most modern phones, iOS included), it hands the file to
  the native share sheet -- far more reliable than a blob download on
  iOS, and gives a real "Save to Files" option -- falling back to the
  classic anchor-click download (now DOM-attached before the click, with
  the object URL revoke delayed rather than immediate) everywhere else.
  All five functions are now async and return whether the save actually
  happened (false only when a user explicitly cancels a share sheet;
  the anchor fallback has no way to detect success and always resolves
  true, same as its old fire-and-forget behavior). `BackupStep` now
  awaits the real result: `downloaded` is only set true on an actual
  success, a genuine failure surfaces a toast with a way to retry
  instead of a silently stuck button, and the button shows
  "Downloading..." while a share sheet is up. Every other call site
  (VaultDetail's two backup-download buttons, the Tranche backup
  button, the Legacy Recovery note button) just needed the `void`
  prefix already used elsewhere in this codebase for a fire-and-forget
  async call in an onClick handler -- none of them gate forward
  progress, so no behavior change beyond "more reliably actually
  downloads." All four gates green, matching the documented 10/10
  baseline exactly.

- **QR scanning reliability + live feedback, fixed everywhere at once
  (2026-08-22).** Operator: "When scanning qr it is very finicky is
  there any improvements we can do to make it better and show better
  progress or if it's even reading the xpub. Fix every where not just
  one place." Audit found four independent hand-rolled camera-scanning
  implementations across the app (`QrScanner.tsx`, `PsbtQrScanner.tsx`,
  `XpubQrScanner.tsx`, plus the standalone offline tool's own copy in
  `tools/legacy-recovery/recover.ts`) -- each with its own copy-pasted
  `getUserMedia`/`requestAnimationFrame`/jsQR loop, no video quality
  constraints beyond `facingMode: 'environment'`, and zero on-screen
  feedback before a code either decoded or the whole thing errored out.
  Two root causes, both fixed at the source instead of patched per
  site: (1) the DEFAULT unconstrained camera stream on many phones is
  low enough resolution that a dense QR (a descriptor-bearing xpub
  export, a UR PSBT fragment) is genuinely too blurry for jsQR to ever
  lock onto -- not a decoder bug; (2) a scanner that hadn't found a code
  yet showed nothing but the raw video feed, so "is it even reading"
  had no honest answer on screen. New `apps/web/src/components/
  useQrCameraLoop.ts` is the ONE camera-capture-plus-decode
  implementation now shared by all three React scanners: requests an
  ideal 1280x1280 stream with continuous autofocus where supported,
  falling back to a plain request if a browser rejects the richer
  constraint set outright (some throw `OverconstrainedError` instead of
  silently ignoring an unsupported `advanced` entry); reads its
  `onFrame` callback via a ref rather than a `useEffect` dependency, so
  a fresh inline handler on every parent re-render (the ordinary React
  pattern, and what all three components were already doing) can never
  tear down and restart the camera mid-scan; and exposes `scanning` +
  `elapsedMs` so every caller can show a live "Scanning... Ns" line
  (new `QrScanStatus.tsx`) that starts the moment the camera opens, not
  only once a fragment decodes -- past 5 seconds it adds a concrete
  nudge (fill the frame, hold steady, check the lighting) aimed at the
  two things that actually cause most failed scans. `QrScanner.tsx`,
  `PsbtQrScanner.tsx`, and `XpubQrScanner.tsx` were all rebuilt on the
  shared hook, keeping each one's own decode logic (UR reassembly,
  PSBT-magic detection, `parseXpubText`) layered on top -- the
  duplicated camera plumbing is gone, a future camera fix now lands in
  one file instead of three. Separately, `InviteClaim.tsx`'s hardware-
  key-import scanner was still wired to the plain `QrScanner` (no UR
  support, and its own hand-rolled `applyScan` didn't even parse a
  BIP-380 `[fingerprint/path]xpub...` key-origin string, just dumped
  whatever text it scanned into the xpub field) despite `XpubQrScanner`
  -- built for the exact same "scan an xpub" job in `KeyManager.tsx`/
  `VaultWizard.tsx` -- already handling key-origin strings, bare xpubs,
  JSON, and UR-reassembled multi-fragment scans correctly. Swapped to
  `XpubQrScanner` directly rather than teaching the dumb component UR
  parsing a fourth time; this was very likely the direct cause of "is
  it even reading the xpub" for that page specifically. The standalone
  offline tool's hand-rolled scanner (no React runtime available to
  share the hook with) got the equivalent fixes applied by hand: the
  same resolution/autofocus constraints with the same fallback, and a
  live status line wired into `template.html`
  (`#signature-scan-status`, replacing the now-unused hidden
  `#signature-scan-canvas` element -- the canvas is created offscreen
  in JS instead, matching the hook's approach). Rebuilt and re-verified
  against a real signed transaction (`verify-legacy-recovery-tool.mjs`,
  unaffected by this change since it drives the non-camera decode path
  -- camera capture itself can't be exercised headlessly). All four
  gates green, matching the documented 10/10 baseline exactly.

- **Legacy Recovery: standalone tool silently failed to decode when given
  the raw payload hex instead of the real scriptPubKey (2026-08-22).**
  Caught live: the operator pasted the hex from the newly-added "Seal
  payload" button (previous entry) into the standalone recovery tool's
  scriptPubKey field to test the flow, and the "Message to sign" box
  never populated -- no error, just the placeholder text sitting there.
  Root cause: `decodeScriptPubkey()` in `tools/legacy-recovery/recover.ts`
  only ever tried unwrapping the input as a Script (expects the OP_RETURN
  opcode `6a` plus a push-length byte wrapped around the payload, exactly
  what a block explorer shows) -- it had no path for the bare payload
  bytes the "Seal payload" step hands out for pasting into OTHER wallets.
  Those two hex strings are trivially confusable (both just look like a
  wall of hex) and this is a recovery tool, so a silent wrong-field
  paste failing with no explanation is exactly the kind of "mess up" the
  whole nonce-signing/no-index redesign (earlier entries) was built to
  eliminate. Fixed with a fallback, not a warning: `decodeScriptPubkey`
  now tries the Script-unwrap first, and if that fails, tries
  `decodeOnChainPayload` directly on the raw bytes before giving up --
  so both the real scriptPubKey AND the bare "Seal payload" hex work
  in that field, whichever one someone has on hand. Field label and the
  "doesn't decode" error message both updated to name both accepted
  formats. `scripts/verify-legacy-recovery-tool.mjs` extended to prove
  BOTH input paths recover byte-identically against the same real signed
  transaction, not just the scriptPubKey one -- rebuilt and passing. All
  four gates green.

- **Legacy Recovery: seal and publish split into two independent steps
  (2026-08-22).** Operator, working through the mechanism out loud: "we
  have to know the nuts which is when our web browser creates the
  transaction... I feel like [it] not the number we use once independent
  of the transaction... needs to be put in the return right before
  hand... the first one is the one that you are signing... the second
  one is the part of the [decrypt]... that way the transaction can be
  anywhere, not have to be created on our browser at the exact time of
  creation. It could be done from any transaction being sent from
  anywhere as long as that [OP_]return['s] messages in there." Correct
  on every count, and confirmed directly: sealing (nonce -> sign ->
  derive key -> encrypt, producing the OP_RETURN payload bytes) and
  publishing (getting those exact bytes into a broadcast transaction)
  were never actually coupled at the cryptography level -- `sealOnChain
  Payload` already returns a pure, static blob of hex with no side
  effects, `buildAndSignPublishTx` already takes that hex as a plain
  parameter. The only reason it felt tied to "this browser, right now"
  is that `LegacyRecoverySetup.tsx`'s single "Build and sign" button
  called both in one breath and never showed the intermediate value.
  Operator's follow-up confirmed the outside-wallet flow precisely: "I
  just put the data into the return and... set to the address that's
  generated by the key... there's nothing else I have to do correct...
  It's findable at that moment... that's all I have to have." True with
  one caveat surfaced and explained: the transaction also has to pay the
  recovery address itself (any amount at or above the 294-sat dust
  floor) as one of its outputs, alongside the OP_RETURN -- not because
  the cryptography needs it, but because recovery's chain lookup works
  by asking "what's this address's history," so a transaction that
  carries the right payload but never touches that address wouldn't
  surface when someone later looks it up. `LegacyOnChainV2Card` now has
  a real "Seal payload" button (`handleSeal`, calling the unchanged
  `sealOnChainPayload`) that does nothing but reveal the mnemonic, seal,
  and display the resulting hex in a copyable textarea -- no network
  call, no transaction. Underneath, the existing payer-key builder
  (unchanged mechanics, still `buildAndSignPublishTx` with `payTo`) is
  now reframed as one option among two: use DynastyTrust's own builder,
  or copy the sealed hex into Sparrow, Electrum, or any other wallet
  that supports a custom OP_RETURN output, funded from wherever, built
  and broadcast whenever -- both paths converge on the identical
  recovery outcome since nothing about `extractOnChainCandidates` or
  `recoverViaOnChainPath` cares which tool produced the transaction.
  `handleBuildPublishTx` now consumes the already-sealed `payloadHex`
  from state instead of calling `sealOnChainPayload` inline, which also
  fixes a latent inconsistency risk: sealing twice produces two
  DIFFERENT payloads (a fresh random nonce each time), so the old
  inline-reseal-per-build-click pattern could in principle have sealed
  one payload while showing the user a different one from an earlier
  attempt; now there is exactly one sealed value in play at a time, and
  the UI warns against mixing an old copied hex with a freshly re-sealed
  one. No changes to `legacy-recovery.ts` or `legacy-onchain-recovery.ts`
  -- this is purely a workflow/UI change exposing capability the crypto
  core already had. All four gates green, matching the documented 10/10
  baseline exactly; no test-script changes needed since the existing
  on-chain round-trip tests already build transactions from `payloadHex`
  as a standalone value, proving the same thing this UI change now lets
  a human do by hand.

- **Legacy Recovery: sign the on-chain nonce instead of a remembered
  sentence, and drop the vault index entirely (2026-08-22).** Two
  connected operator design calls, same session as the path-reshape
  above. First: "Why do I have to... why can't I just put the op return
  in the first message... Why cant the first part of op return be the
  numbers you sign and the other part be the part you decrypt" -- correct
  read of the wire format (magic+version, then the nonce, then the
  ciphertext -- the nonce genuinely IS "the first part," the ciphertext
  genuinely IS "the second part"), and correct diagnosis of the actual
  design flaw: the fixed sentence
  (`DynastyTrust Legacy Recovery v2\nvault index: N`) had to be
  correctly reconstructed by a person, by hand, possibly decades later,
  when the AES-GCM nonce that already had to be published on-chain
  anyway could serve as the signed content instead -- read straight off
  the found transaction, nothing to get wrong. Answered directly why
  signing the WHOLE OP_RETURN can't work (raised as the natural
  follow-up): the ciphertext is the OUTPUT of encrypting with the key
  that signing produces, so at sealing time the ciphertext doesn't exist
  yet -- nothing that depends on it can be the thing signed to derive it.
  The nonce is chosen before encryption, so it's the one piece of the
  eventual payload actually available to sign up front, at both sealing
  and recovery time. Second, on confirming the build: "Yes top one but
  we need to drop having to put a number with it. 99.999999% of the time
  those one keys have one job one vault not ten per backup. I want no
  mess ups from user in last case recovery scenario" -- read as: optimize
  the mechanism against user error in a last-resort, decades-later
  recovery scenario, not against the rare case of one seed publishing
  Legacy Recovery for more than one vault. `legacy-recovery.ts`'s
  derivation path is now ONE fixed constant per network
  (`legacyOnChainDerivationPath(network)`, no index parameter --
  `m/84'/coin'/900000'/1/0`, `LEGACY_ACCOUNT_NUMBER` replacing the old
  `LEGACY_ACCOUNT_OFFSET`), so a seed always lands on the same single
  address regardless of how many vaults it publishes for.
  `legacyOnChainUnlockMessage(vaultIndex)` is gone, replaced by
  `legacyOnChainNonceMessage(nonce)` (a fixed prefix plus the nonce as
  hex); `signLegacyOnChainUnlock`/`verifyLegacyOnChainSignature` became
  `signLegacyOnChainNonce`/`verifyLegacyOnChainNonceSignature`, both
  taking the nonce bytes instead of a vault index;
  `deriveLegacyOnChainKey` dropped its index-tag parameter entirely (the
  signature is already unique per seal, since it's over a fresh random
  nonce each time -- no further domain separation needed).
  `sealBundle` gained an optional third `nonce` parameter (defaults to a
  fresh random value, same as before, when omitted) so
  `sealBundleOnChain` can generate the nonce FIRST, sign it, derive the
  key from that signature, and only then encrypt with that exact
  key+nonce -- the order the chicken-and-egg problem above actually
  requires. `legacyOnChainLookupAddress`/`sealOnChainPayload` both
  dropped their `vaultIndex` parameters to match. Degrades gracefully
  in the rare multi-vault-per-seed case rather than breaking silently:
  both publishes land at the same address as separate transactions, and
  because the key is nonce-specific (not vault-specific), each
  transaction's own nonce still only ever unlocks its own ciphertext --
  nothing decrypts to the wrong vault's data, recovery just needs to
  find the right transaction, the same way it already has to for a
  re-sealed vault's older vs. newer publish. Frontend:
  `LegacyRecoverySetup.tsx` lost its entire "vault index" field and
  `defaultVaultIndex` role-position guess; `DescriptorRetrieval.tsx`
  lost its vault-index field too and gained a real sequencing change --
  since the message to sign now depends on the nonce found ON the
  transaction, "derive address" and "sign" are no longer one combined
  step; deriving the address happens first, checking the chain finds
  the nonce, and only then can a "Sign locally with this key" button
  (new) or an external hardware wallet actually sign anything.
  `descriptor-backup.ts`'s recovery note dropped `vaultIndex` and
  `unlockMessage` fields entirely -- there's no message to print ahead of
  time any more, only the address and path, with instructions to let the
  chain lookup compute the message at recovery time. The standalone
  offline tool (`tools/legacy-recovery/`) had its field order flipped:
  paste the scriptPubKey FIRST, the tool decodes it and computes the
  message from the nonce it finds, then sign -- previously vault index
  came first and drove the message. All three test scripts
  (`test-legacy-recovery.mjs`, `test-legacy-onchain-recovery.mjs`,
  `verify-legacy-recovery-tool.mjs`) rewritten around the new nonce-first
  API and the fixed single address; the last one re-verified against a
  real signed transaction, byte-identical. One typecheck regression
  surfaced and fixed during this pass: `sealBundle`'s new explicit
  `nonce: Uint8Array` parameter annotation widened to the
  `Uint8Array<ArrayBufferLike>` variance this file already has a
  documented pattern for (`asBufferSource()`); applying that same
  pattern to the new `iv: nonce` call site restored the exact 10/10
  pre-existing typecheck/lint baseline. All four gates green.

- **Legacy Recovery: derivation path reshaped from fully-hardened to
  standard-shaped with an offset account (2026-08-22).** Operator asked
  to confirm a described recovery flow ("you put the derivation path at
  9999... it will show an address, you sign, then you have your
  descriptor -- is that correct?"). Grounding against SeedSigner's actual
  source (not memory) found the described flow does NOT work: SeedSigner's
  message-signing UI (`parse_derivation_path()`) only recognizes the
  ordinary 5-level BIP44/49/84/86-shaped path (hardened purpose/coin/
  account, then UNHARDENED change/index) and hard-rejects a custom
  hardened path like the old `m/9999'/coin'/N'/1'` with "Signing messages
  for custom derivation paths not supported" -- before ever showing an
  address or accepting a signature. The underlying signing math is
  path-agnostic; the rejection is purely a UI-layer whitelist gate, but
  that gate meant the mechanism's own worked example couldn't actually be
  carried out on the hardware it exists to support. Operator's follow-up,
  "what's the downside to moving to a regular derivation path, still
  hardened but normal," got a direct answer: an unhardened change/index
  level means anyone holding the ACCOUNT-level xpub (not the master) can
  compute that address, unlike the old fully-hardened path where nothing
  short of the seed could. Operator then asked about forking SeedSigner
  instead to accept the custom path -- researched and found technically
  feasible (~30-60 lines: a whitelist-gate fix plus deriving through the
  full hardened private-key chain instead of extending a cached xpub,
  testable without hardware via SeedSigner's own pytest suite) but
  recommended against as the FOUNDATION of recovery: reshaping the
  canonical path and forking firmware to accept the old shape are
  mutually exclusive fixes (only one path shape can be the one actually
  published on-chain), and depending on a specific patched firmware fork
  surviving decades is a worse fit for "works decades from now regardless
  of what still exists" than closing the narrower xpub-exposure risk
  directly. Operator agreed ("Yes") to the standard-shaped path.
  `legacy-recovery.ts`'s `legacyOnChainDerivationPath` now returns
  `m/84'/coin'/(900000+N)'/1/0` -- the ordinary BIP84 (native segwit)
  5-level shape, hardened purpose/coin/account and unhardened change/index,
  recognized by any hardware wallet's message-signing feature as a normal
  account. The fixed `LEGACY_ACCOUNT_OFFSET` (900,000) is the mitigation
  for the xpub-exposure question above: it keeps this "recovery account"
  far outside any real wallet's actively-used low account numbers
  (routinely exported to watch-only trackers/tax tools) or typical
  account-level gap-limit auto-discovery ranges, so an attacker would need
  the SPECIFIC account-level xpub at that exact offset+index, not just
  "some xpub from this wallet." Change=1 (the internal chain, never a
  normal receive address) is a further, minor precaution. The old
  `LEGACY_PURPOSE = "9999'"` reserved-purpose constant is gone (private,
  now `"84'"` -- a real BIP84 purpose, not a reserved one).
  `scripts/test-legacy-recovery.mjs`'s hardcoded path assertions,
  `DescriptorRetrieval.tsx`'s displayed path (now computed via
  `legacyOnChainDerivationPath` instead of a hardcoded string, so it can't
  drift from the real function again), and `tools/legacy-recovery/
  template.html`'s warning-box copy were all updated to match; the
  standalone offline tool was rebuilt (`node tools/legacy-recovery/
  build.mjs`) and re-verified end to end against a real signed transaction
  (byte-identical recovery). `LegacyRecoverySetup.tsx` needed no change --
  it already computed the path via the function, never hardcoded it.
  Nothing else about the mechanism changed: the unlock message, the
  AES-256-GCM sealing, the OP_RETURN payload framing, and the one-
  transaction billboard-payment publish flow (previous entry) are all
  untouched -- only the path SHAPE moved, not the account-level hardening
  that still requires the seed (not the master xpub) to derive. All four
  gates green; typecheck/lint match the documented pre-existing baseline
  exactly (10 pre-existing typecheck errors, 10 pre-existing lint
  warnings), none in any file this change touched.

- **Legacy Recovery on-chain publish collapsed from two transactions to
  one (2026-08-22).** Operator: "Why do I have to fund a UTXO to that
  address and then craft the transaction and then resend it why can't
  I just put the op return in the first message that funds it with a
  small amount of that that's never meant to leave just be the
  billboard." Correct, and the original design had no real reason for
  the two-step shape -- it just happened to route the publish
  transaction's INPUT through the identity address, which meant that
  address had to hold a UTXO before anything could spend from it, and
  spending required the identity key to sign a real Bitcoin
  transaction. Neither is necessary: the scanner
  (`extractOnChainCandidates`) only needs the identity address to
  appear SOMEWHERE in a transaction's outputs to find it -- it never
  cared whether that transaction spent FROM the address too. Redesigned
  so the identity address is purely a payee: `onchain-publish.ts`'s
  `buildAndSignPublishTx`/`buildAndSignPublishTxFromKeypair` gained an
  optional `payTo: { address, amountSats }` third output (dust-floor
  checked at 294 sats, fee math and the undersized-UTXO error message
  both updated to account for it) alongside the existing OP_RETURN
  output and self-change. `legacy-onchain-recovery.ts`'s
  `sealAndBuildOnChainPublishTx` (which forced the identity key to be
  both the signer and the spender) is gone, replaced by
  `sealOnChainPayload` -- pure sealing, no transaction, no keypair
  beyond the identity's own signature. `LegacyOnChainV2Card`
  (`LegacyRecoverySetup.tsx`) now asks for a SEPARATE "paying key" (any
  other already-funded local key) alongside the existing identity-key
  selector, fetches UTXOs at the payer's own address instead of the
  identity address, and builds one transaction: OP_RETURN + a small,
  editable "billboard" payment (1000 sats default, never meant to move
  again) to the identity address + change back to the payer. Net
  effect: one signature, one broadcast, and the identity key's only
  remaining job across its entire lifecycle is signing the recovery
  MESSAGE, years later -- it never touches transaction-signing logic at
  all, which is also a smaller attack surface for that key than before.
  `scripts/test-onchain-publish.mjs` gained payTo-path coverage
  (correct output count/amounts, dust-floor rejection);
  `scripts/test-legacy-onchain-recovery.mjs` and
  `scripts/verify-legacy-recovery-tool.mjs` (the latter against a real
  signed transaction, same as before) were both rewritten around the
  new two-function split with a genuinely separate payer key, proving
  the identity address only ever needs to be an output. All four gates
  green.

- **Original (v1) Legacy Recovery mechanism retired entirely
  (2026-08-21).** Operator, after the v2 on-chain mechanism shipped
  (previous entry): "I don't think we need to keep anything of the old
  version. I just didn't like it. None of it worked. None of it's gonna
  be used. It's just gonna be clutter that's in the way. I just want the
  new signature based signing." Read as full authorization to delete,
  not deprecate -- the whole hybrid XOR/Shamir, database-backed design
  is gone, code and schema alike. Deleted: `legacy-seal.ts` (v1
  orchestration), `netlify/functions/vault-legacy.js` and
  `legacy-lookup.js` (v1 storage/lookup endpoints), the `api.legacy.*`
  client block, `descriptor-backup.ts`'s `LegacyRecoveryPackageLike`/
  `legacyRecoveryPackageText`/`downloadLegacyRecoveryPackage`, and the
  `shamir-secret-sharing` dependency (`npm install` pruned it from the
  lockfile). `legacy-recovery.ts` dropped every v1-only export
  (`deriveLegacyLockBytes`, `legacyIdentityPubkeyFromXpub`,
  `detectXpubNetwork`, `signLegacyUnlockMessage`,
  `verifyLegacyUnlockSignature`, `deriveLegacyLockBytesFromSignature`,
  `lockShare`/`unlockShare`, `splitLegacySecret`/`combineLegacySecret`,
  `splitLegacySecretHybrid`, `recoverViaFastPath`/
  `recoverViaFallbackPath`, `generateLegacySecret`,
  `descriptorFingerprint` -- the last was v1's stale-seal label, moot
  once the sealed-bundle-in-a-database it labeled no longer exists) --
  file is roughly half its former size, down to shared primitives
  (`bitcoinMessageDigest`, `parseUnlockSignature`, `sealBundle`/
  `unsealBundle`) plus the on-chain mechanism, unchanged.
  `LegacyRecoverySetup.tsx` and `DescriptorRetrieval.tsx` both lost
  their entire v1 half (role-assignment/seal flow, xpub-lookup flow,
  "download recovery package") and now show only the on-chain
  publish/recovery cards that already existed alongside v1. The
  standalone offline tool (`tools/legacy-recovery/`) dropped its
  three-tab layout for a single flow -- no tabs needed with one
  mechanism -- and its Playwright verification script
  (`scripts/verify-legacy-recovery-tool.mjs`, not part of `npm test`)
  now drives that flow against a real signed transaction rather than
  the old fast/fallback paths.
  `supabase/migrations/20260821150000_drop_legacy_recovery_v1.sql` drops
  `vault_legacy_bundles`/`vault_legacy_shares`/
  `vault_legacy_onchain_shares` outright (applies automatically on push
  to main, same as every other migration here) -- the two prior
  migrations that extended those tables
  (`20260818203809_legacy_shares_signature_unlock.sql`,
  `20260820120000_legacy_recovery_descriptor_fingerprint.sql`) are left
  in place as history, never edited or deleted, per migration
  convention. `scripts/test-legacy-recovery.mjs` dropped every v1
  assertion, keeping only the on-chain mechanism's round-trip/
  determinism/tamper-detection proofs. All four gates green; typecheck/
  lint match the documented pre-existing baseline exactly, both before
  and after -- confirming the removal didn't disturb anything else.

- **Legacy Recovery v2: "all you need is your key" -- a second,
  database-free on-chain recovery mechanism (2026-08-21).** Operator,
  after using v1: "We need to look at the long term back up. I tink we
  mad it harder to back up not easier... The whole idea was that you
  would have only your key and somehow you would be able to see your
  description on chain... I just like to know any solution better than
  this because this is just redundant doing the same thing over and
  over." v1 (still fully intact, never touched or weakened -- anything
  already sealed under it keeps recovering exactly as before) needs a
  threshold of shares plus, for its fast path, a database round trip;
  the operator wanted a version where ONE key, alone, is the entire
  backup. Plan vetted for holes before any code was written, per the
  operator's explicit request, catching two design problems along the
  way: an early sketch derived the on-chain lookup address from the
  vault's own account xpub, which the operator's "I don't want to be
  leaking a information about the key" caught as a real linkability
  leak (anyone holding that xpub could watch for or discover the
  publication); and an ECDH envelope-encryption design was dropped as
  unneeded complexity once unlinkability already forced one publish per
  keyholder anyway. Final design: `legacyOnChainDerivationPath` in
  `legacy-recovery.ts` derives a FULLY HARDENED path,
  `m/9999'/<coin>'/<vault index>'/1'` (vault index = that person's own
  small per-vault counter, distinct from v1's `9999'` sub-path by its
  trailing `1'` vs v1's `0'`) -- hardened means it is computable ONLY
  from the real seed, never from this vault's xpubs, descriptor, or
  DynastyTrust's whole database. A deterministic (RFC 6979) ECDSA
  signature over a fixed message at that path IS the AES-256-GCM key
  directly (`deriveLegacyOnChainKey`, SHA-256 with a domain-separation
  tag) -- no ECDH, no envelope, and the same signature doubles as "prove
  key ownership," so recovery is nothing but signing a message
  (verbatim ask: "sign something and decrypts instead of entering
  phrase") -- works identically for a mnemonic (computed locally) or a
  hardware wallet's native "Sign Message" feature against a custom
  path, no seed phrase ever typed into any tool. The full encrypted
  bundle publishes as a single OP_RETURN (Bitcoin Core 30's 100,000-byte
  relay limit makes this trivial, unlike v1's small on-chain pad) --
  `legacy-onchain-recovery.ts` orchestrates seal + build + sign
  (`sealAndBuildOnChainPublishTx`) and scan + extract
  (`fetchLegacyOnChainCandidates`/`extractOnChainCandidates`, via
  `@scure/btc-signer`'s `Script.decode`, real-transaction round-trip
  tested in `test-legacy-onchain-recovery.mjs`, not just a fixture).
  Genuinely no database at all -- the chain IS the storage, so there is
  nothing here for a DynastyTrust outage or a stale row to break.
  Shipped in explicit operator-approved stages, each independently
  gated: (1) crypto core, unit-tested in isolation
  (`test-legacy-recovery.mjs`'s new v2 section: path
  determinism/uniqueness/non-collision-with-v1, signature determinism,
  key-derivation domain separation, full seal/unseal round-trip, AEAD
  tamper/wrong-key rejection); (2) on-chain publish/lookup plumbing;
  (3) `LegacyRecoverySetup.tsx` gained a per-role "recover with just
  this key" card (derive address, check the chain, guided UTXO-fetch-
  then-build-then-broadcast mirroring the existing v1 flow's pattern,
  plus a "download recovery note" -- unlike v1's package, nothing in it
  is secret, so it's safe to keep anywhere) and
  `DescriptorRetrieval.tsx` gained a "Sign to recover" section (no xpub
  match needed -- v2's hardened path means there is nothing a
  server-side lookup could match against, so the address itself IS the
  lookup); (4) the standalone offline tool
  (`tools/legacy-recovery/`) gained a fourth tab reusing the SAME tested
  functions (no second hand-typed implementation), rebuilt via
  `node tools/legacy-recovery/build.mjs`. All four gates green at every
  stage; typecheck/lint match the documented pre-existing baseline
  throughout.

- **Family D closed: numeric-bounds validation at every JSON body
  boundary reaching CLTV/fee/quorum arithmetic (2026-08-21).** The
  original Kimi K3 scan's per-finding text for this family wasn't
  preserved verbatim from an earlier session, so this was re-derived
  fresh via a research-agent audit of the current code rather than
  patched from memory (per this file's own grounding rule) -- the real
  gap matched the family's description either way. New
  `netlify/functions/_numeric.js`: `checkNumberBounds()`/
  `isFiniteNumber()` plus centralized `MIN_FEE_RATE_SAT_VB`/
  `MAX_FEE_RATE_SAT_VB` (previously duplicated verbatim in three
  files); `_chain.js` gained `MIN_RECOVERY_BLOCKS`/`checkTimelockFloor()`
  alongside the existing `relativeToAbsolute()`. Four batches: (1) the
  same MIN_RECOVERY_BLOCKS timelock-bypass bug already fixed for
  `compile.js`'s `recovery_after` had never been propagated to its
  siblings -- `inheritance_after` (`compile.js`, `vaults-compile.js`,
  plus `second_inheritance_after`), Bloc's `parent_solo_after`/
  `kids_decay_start_after` (`compile-bloc.js`, `vaults-compile-bloc.js`,
  which didn't even import the constant), and the generic leaf-list's
  `After`-type `unlock.blocks` (`compile-leaves.js`, the newest vault
  builder, including the Revocable Living Trust template) all had only
  a truthy check or no check at all -- `inheritance_after: 1` passed
  every existing check on a Gift Locker vault. (2) Every `fee_rate`/
  `amount_sats` range check across `psbt-binary.js`/`-bloc.js`/
  `-tranche.js` and `proposals.js` was written as `x < MIN || x > MAX`
  without first confirming `x` is a real finite number -- `NaN < MIN`
  and `NaN > MAX` both evaluate false, so non-numeric input silently
  passed. `proposals.js` mattered most here: no Rust compiler sits in
  its path, so `amount_sats`/`fee_sats`/`fee_rate`/`utxo_age_blocks`/
  `total_vault_sats` wrote straight to the `proposals` table -- which
  the audit PDF, tax summary, and activity export all treat as the
  permanent record -- with no backstop at all beyond whatever
  Postgres/PostgREST does with an out-of-type value. (3)/(4) Defense-
  in-depth for quorum/tranche fields Rust already bounds at compile/
  spend time but that had no check of their own at write time:
  `distribution-wallets.js`'s `trustee_quorum` and per-tranche
  `unlock_block` (whose `typeof` check accepted NaN, silently
  defeating `psbt-binary-tranche.js`'s own unlock gate), the
  `kids_decay` path's `quorum` in `psbt-binary-bloc.js`, and
  `compile-leaves.js`'s per-leaf `quorum`. `governance.js` (read-only
  audit/status endpoint, not fund-moving) got the same
  `amount_sats`/`utxo_age_blocks`/`total_vault_sats` fix for
  consistency. `OlderThan` (decay-ladder) leaves were deliberately left
  untouched throughout: their block count is a duration forwarded
  unconverted, so Rust's own `MAX_RELATIVE_BLOCKS` check runs against
  the real value and was never a no-op -- only the `After`/CLTV-shaped
  fields had the conversion-order bug. All four gates green across
  every batch; `netlify/functions/*.js` aren't covered by the
  eslint/tsc gates (plain JS, no build step), verified with
  `node --check` on every edited file instead.

- **Security audit follow-up: three operator design calls resolved
  (2026-08-21).** Full Kimi K3 automated security scan (146 findings)
  triaged and the confirmed-real ones fixed across this session and the
  prior one; three findings were product/design questions rather than
  bugs, put to the operator directly rather than "fixed" unilaterally:
  (1) **Tranche trustee escape hatch has no CLTV gate** -- confirmed as
  coded, not missing: `trustee_quorum` can move a beneficiary's tranche
  before its unlock height, and `psbt-binary-tranche.js`'s own error
  message says "Use the trustee escape hatch to move funds before then."
  Operator confirmed this is intentional (real-world trustee discretion,
  same structural pattern as the standard vault's founders' Recovery
  path) -- left as-is, no code change; recorded here so a future scan
  doesn't re-flag it. (2) **The signing gate's synthetic approvals axis
  was vacuous** -- `ceremonyFromProposal` was feeding the gate a single
  hardcoded `approveVoterIds: ["proposal-exists"]`/`approvalsRequired: 1`
  that any signable proposal trivially satisfied; no real per-member
  approval-vote feature exists anywhere in this app to build a genuine
  check from. Operator chose to drop the axis entirely rather than build
  the feature or leave the vacuous check in place --
  `SigningCeremony.approvalsRequired`/`approvalsCollected` and
  `CeremonyBridgeInput.approveVoterIds`/`approvalsRequired` removed from
  `packages/policy-engine/src/index.ts` (dist rebuilt + committed, this
  package's dist IS git-tracked), the two `NOT_GREEN` denial checks
  removed from `evaluateSigningGate`, `VaultDetail.tsx`'s call site and
  `scripts/test-policy.mjs`/`test-liveness-gate.mjs` updated to match.
  The gate's other axes (PSBT-exact-match, ceremony status, duress,
  governance, liveness) are unaffected and still enforce for real; quorum
  itself is enforced on-chain by the Taproot script's own required
  signature count, which this axis was never actually checking anyway.
  (3) **Legacy Recovery's on-screen unlock-signature exposure** --
  `signLegacyUnlockMessage`'s deterministic-ECDSA-signature-as-secret
  design is confirmed intentional (see the Legacy Recovery history
  below), and the retrieval page's "review the signature" step showing
  that value on-screen before use is accepted as inherent to a
  decades-out manual recovery flow, not something to mask. No code
  change. All four gates green throughout.

- **PDF/audit/tax exports + Tapit circle-membership invites for the
  custom leaf-list vault shape (2026-08-19).** Direct follow-up to the
  Revocable living trust entry below -- items 8 and 9 in Open gaps above
  were left open in that same session per the operator's instruction to
  "keep a list of the things we need to work on" rather than fixed
  silently; this pass closes both. Full detail lives in the strikethrough
  entries for items 8 and 9 above, not repeated here. Net effect: a
  custom leaf-list vault (living-trust-shaped or otherwise) now gets
  correct legal/tax documents instead of "0 of 0 signatures required,"
  and its Tapit circle members can actually be invited over the
  encrypted-messaging pipeline, matching what already worked for the
  named-field and Bloc vault shapes. All four gates green.

- **Revocable living trust shape + trust-wording toggle + trust-doc
  generation for the custom leaf-list builder (2026-08-19).** Operator
  asked, after the custom leaf-list builder shipped, whether the "heart of
  the trust part" -- lawyer docs, the judicial-system side, membership
  invites over encrypted messaging -- had kept pace with it. Grounding
  confirmed two real gaps (now items 8 and 9 in Open gaps above, left
  open and documented rather than fixed silently or ignored per the
  operator's explicit instruction to "be honest about where we haven't
  found where we go"). Also built what the operator asked for as the
  positive half of that same request, both options rather than picking
  one: (1) a new "Revocable living trust" entry in `VaultWizard.tsx`'s
  `LEAF_SHAPE_TABS` -- the most common US estate-planning trust, mapped
  onto three existing leaf primitives with trust-terminology labels:
  Grantor(s) (immediate), Successor Trustee incapacity backstop (the
  existing `older()` self-refreshing pattern, with copy that says plainly
  this is a proxy for a real incapacity determination, not the same
  thing, and that a real determination should be handled by a deliberate
  `vaults-rotate.js` handoff rather than waiting out the on-chain clock),
  and Successor Trustee distributing to Beneficiaries (a longer `after()`
  leaf). (2) A separate, complementary "Use trust wording" checkbox
  (`applyTrustLabels` in `VaultWizard.tsx`) that relabels whichever paths
  an operator has already hand-built with the same Grantor / Successor
  Trustee / Beneficiary terms, based on each path's own timing (immediate
  -> Grantor, "if untouched" -> incapacity backstop, longest `after()` ->
  distribution to Beneficiaries) rather than which shape tab was used --
  reversible, since toggling it off restores the labels captured right
  before it was turned on. (3) The actual missing connection: the
  leaf-list compile path in `VaultWizard.tsx`'s `runCompile` had a
  comment explaining why it left the generated trust doc blank ("no
  template to draw from the way Standard/Bloc do") -- that comment was
  wrong, there was a template to write, it just hadn't been written yet.
  `apps/web/src/lib/trust-doc.ts` gained `buildLeavesTrustDoc`, generating
  real purpose/distribution-rules/succession-notes prose from each path's
  actual mechanics (quorum, key count, immediate/after/older timing, decay
  ladder), the same way `buildStandardTrustDoc`/`buildBlocTrustDoc` already
  do for the other two shapes -- wired into the same `saveGeneratedTrustDoc`
  call every other vault shape already uses, so every vault built through
  the custom builder, living-trust-shaped or not, now gets a real starting
  trust doc instead of a permanently blank one. All four gates run before
  commit.

- **Legacy Recovery: stale-seal detection (2026-08-20).** Operator, thinking
  through a 20-year-out edge case: a vault gets recompiled (same leaf shape,
  different actual keys) after its Legacy Recovery bundle was already sealed
  and an on-chain pad already published -- "I'm not sure how to label that or
  make sure the person in the future doesn't get confused." Grounding
  confirmed the gap was real: `vaults-compile.js`/`compile-leaves.js` never
  touched `vault_legacy_*` at all, despite `vault_legacy_recovery.sql`'s own
  comment claiming the bundle gets "overwritten whenever the vault
  recompiles." The crypto itself already fails safely -- a stale locked
  share or on-chain pad only ever reconstructs the secret for the bundle it
  was sealed alongside, so recovering against a re-sealed vault just fails
  to decrypt (an honest error), never a silently wrong descriptor -- but
  nothing told the owner it had happened, and nothing told a future finder
  which vault-version a package belonged to. `legacy-recovery.ts` gained
  `descriptorFingerprint` (8 bytes of SHA-256 as 16 hex chars, unit-tested
  in `test-legacy-recovery.mjs`) -- a label, not a security mechanism.
  `legacy-seal.ts`'s `sealVaultLegacyRecovery` now takes the vault's raw
  `descriptor` and hashes it at seal time; `vault-legacy.js`'s POST stores
  it as `vault_legacy_bundles.sealed_descriptor_hash`
  (`20260820120000_legacy_recovery_descriptor_fingerprint.sql`, nullable --
  a bundle sealed before this migration has no retroactive fingerprint,
  treated as "unknown version," never "current") and its GET returns it.
  `LegacyRecoverySetup.tsx` recomputes the vault's CURRENT fingerprint on
  every load and shows a red "this vault's descriptor has changed since
  Legacy Recovery was last sealed -- reseal now" banner when it no longer
  matches the sealed one, plus a small mono line showing the sealed
  version/date next to the roles for a normal, matching seal.
  `descriptor-backup.ts`'s `LegacyRecoveryPackageLike` gained
  `descriptorFingerprint`/`sealedAt`, stamped near the top of every
  downloaded recovery package with an explicit note: this package still
  correctly recovers the version it was sealed for, but may not be the
  vault's current one, so compare the stamp against DynastyTrust's live
  page if it's still reachable. The standalone offline tool
  (`tools/legacy-recovery/`) was deliberately NOT changed -- the fingerprint
  is plain informational text for the human reading the package, not a
  field the recovery tool consumes -- but it was rebuilt
  (`node tools/legacy-recovery/build.mjs`) per standing instruction since
  `legacy-recovery.ts` changed. All four gates green; `legacy-recovery`
  test suite extended with round-trip + collision checks for the new
  fingerprint function.

- **Standalone protector leaf/timelock/quorum retired (2026-08-19).**
  Operator: "I don't like the protector path. I only like it as an added
  key to a quorum so as to keep a leaf honest not a leaf all of its own"
  -- followed by, on which leaf it should co-sign: "Just as a suggested
  signer just like trustee. Prolly not use much so don't need it." Read
  as authorization to remove the dedicated mechanism entirely: an
  independent overseer, if wanted, is just another key added directly to
  `founder_keys` -- no separate field, leaf, or timelock needed, since
  that person then counts toward the existing founder quorum like any
  other trustee. Removed `protector_keys`/`protector_quorum`/
  `protector_after` from `DynastyPolicy` and the protector branch from
  `build_multileaf` (`policy_compiler.rs`), the protector fields/path from
  `compiler/src/main.rs`'s compile and psbt-binary handlers, and the
  matching plumbing from every Netlify function that touched them
  (`compile.js`, `vaults.js`, `vaults-compile.js`, `vaults-rotate.js`,
  `psbt-binary.js`, `invites.js`, `invites-lookup.js`, `vault-audit-pdf.js`,
  `assistant.js`). Frontend: dropped the "Add a protector" toggle and its
  key picker from `VaultWizard.tsx`, the spend-path option and
  countdown/reminder banners from `VaultDetail.tsx`, and the config fields
  from `StandardConfig`/`VaultTemplate` (`vault-templates.ts`) -- the
  Generational Trust template's "independent protector" story is now "seat
  an overseer as one of the 5 trustee keys instead." A same-session audit
  of this mechanism (governance-layer protector tracking, an ordering
  guardrail) is reverted along with it -- see commit `66130c7`, cleanly
  undone via `git checkout 66130c7~1` for the three files it touched
  outside `policy_compiler.rs`. `vaults.protector_keys/protector_quorum/
  protector_after` columns are deliberately left in the DB schema, unused
  -- dropping them is a separate, destructive call the operator didn't
  ask for. Any vault compiled before this change that actually used the
  protector leaf keeps spending exactly as before; the Taproot tree
  already on-chain does not change retroactively. All 158 protocol +
  compiler tests pass; frontend typecheck/lint/build clean against the
  pre-existing baseline (documented below).

- **Dead BSMS/Policy Builder reference in the downloadable vault backup
  (2026-08-17).** `descriptor-backup.ts`'s Nunchuk recovery instructions told
  a future reader to go find "the BSMS export on the Policy Builder page" --
  that page was retired when `VaultWizard` absorbed it, and `VaultWizard`
  never grew a BSMS export of its own, so the instruction pointed at
  something that no longer exists at all, not just a renamed page. Since
  this file is explicitly meant to work when DynastyTrust itself is
  unreachable, a dead in-app pointer there is a real gap, not cosmetic.
  Fixed to the instruction that was already correct as the doc's own
  fallback: import the descriptor into Sparrow, then use Sparrow's own BSMS
  export to hand off to Nunchuk -- now the primary and only instruction,
  since DynastyTrust doesn't export BSMS directly. Also removed the stale
  "PDF vault backup -- function exists, no UI button" line from Open Gaps
  above: grounding for this fix found the button already wired in
  `VaultDetail.tsx` (`api.pdfUrl` + "Download PDF"), alongside a working
  descriptor QR code (`DescriptorQr.tsx`, "Show QR") -- both were already
  done, the doc just hadn't caught up.

- **The 2026-08-06 fix below was incomplete -- server-side copy still had the
  bug (2026-08-16).** `apps/web/src/lib/descriptor-keys.ts`'s `upgradeDescriptor`
  was the only copy fixed on 2026-08-06. `netlify/functions/vaults-compile.js`
  has its OWN separate, duplicate `upgradeDescriptor` function -- and that one
  runs first, server-side, consuming the raw pubkey substrings before the
  browser ever sees the descriptor. So the browser's `/0/0` fix was a silent
  no-op for every standard-shape vault compiled through `/api/vaults-compile`
  the entire time. Caught by tracing a real, live Gift Locker vault's
  descriptor, which still showed `/0/*`. Both copies now emit `/0/0`. Good
  news for anyone whose vault already has the stale text: the address was
  NEVER wrong -- `/0/*` and `/0/0` derive the identical key at index 0, so
  this is purely a descriptor-notation bug, not a fund-safety one. Run
  `supabase/migrations/20260816194321_repair_ranged_descriptor_notation.sql`
  once to patch the
  stored `descriptor` text in place; no recompile, no address change, no
  funds touched. `Bloc`/`Tranche` (`vaults-compile-bloc.js`,
  `distribution-wallets.js`) never called `upgradeDescriptor` at all -- a
  separate, already-known, still-open limitation, not touched by this fix.

- **Fixed, non-ranged key-origin descriptor (2026-08-06).** `upgradeDescriptor`
  now emits `[fp/path]xpub/0/0`, not a `/0/*` wildcard range. This vault is a
  single fixed address by design (see "Address type" above) -- a ranged
  descriptor let Nunchuk/Sparrow offer a second receive address at index 1+
  that our own compiler has no way to build a spend for (it only ever knows
  the exact `/0/0` key baked into the leaf script), so funds sent there would
  be spendable by the hardware wallet directly but invisible to this app's own
  coordinator. A fixed key expression makes every wallet that imports the
  descriptor show the exact same one address we do.

- Descriptor upgrade to Nunchuk/Sparrow key-origin form. `upgradeDescriptor`
  and `buildKeyOrigins` now run right after `api.compile()` returns, so the
  descriptor shown in the copy field and stored in Supabase is
  `pk([fp/path]xpub/0/0)`. Uses `masterFingerprint` when the keystore has
  it (software keys) and falls back to the child `fingerprint` otherwise.

- **Nunchuk key-material parity**: every pubkey sent to the compiler is
  `xpub/0/0` (first receive-chain child), not the account-level pubkey.
  Without this fix, the compiler's address and the upgraded descriptor's
  first address disagree (the descriptor was wildcard-ranged at the time
  of this fix; fixed to non-ranged 2026-08-06) -- Nunchuk import would see an
  empty balance at the address our app funded. The fingerprint is also
  now BIP32 standard (`HASH160(pub)[0..4]`) instead of the non-standard
  raw-first-4-bytes shape. `psbt-signer.ts` signs with the `/0/0` child
  private key to match the leaf-script pubkey. `repairPubkeys()` on
  boot, plus a self-heal pass in VaultDetail, migrate local keys and
  `vault_members` rows automatically. **Any vault compiled before this
  fix is permanently broken vs. Nunchuk -- the descriptor + address
  pair was wrong and is immutable. Recompile from a fresh draft.**

