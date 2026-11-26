# Build note: split the vault page, Send screen first

Status: NOTE ONLY. No code until the operator says go.

## The ask (operator, 2026-11-26)

"Vault page size a concern?", then the chip: "Build Note, Send first".

## Why

`apps/web/src/pages/VaultDetail.tsx` is 9,147 lines and holds 58 functions.
It has changed in 47 commits since 2026-08-30. The repo's own limit is 800
lines for a file. On 2026-11-25 the rule for counting child-key signatures
was fixed on the request page and on the server, but the copy of the same
rule inside the Send screen was missed. The screen walk caught it a day
later. A rule living in two places, with only one updated, is the typical
big-file bug. The size also makes an outside auditor pay to read one huge
file.

## What would be built (slice 1: Send only)

A pure move with no change in behaviour:

- `apps/web/src/pages/vault-detail/SendTab.tsx`: `SendTab` (lines
  1525–2977, 1,453 lines). Its types `SendStep`, `SendPrefill` and
  `SigningState` go with it, and `SendPrefill` is exported because the
  page and Overview use it.
- `apps/web/src/pages/vault-detail/UtxosSection.tsx`: the coins list
  (from line 8817). Overview, Send and the Dynasty Bloc overview all use
  it, so it gets a home of its own.
- `apps/web/src/pages/vault-detail/ExternalPsbtInput.tsx`: the
  paste-a-signed-PSBT box. It's used by Send and the tranche claim.
- `apps/web/src/pages/vault-detail/format.ts`: `satsToBtc`,
  `blocksToLabel`, `advanceDueDate` and `psbtBindingHash`. These are used
  by Send and by the rest of the page; today they are defined once, at the
  top of the page, and they keep that one definition.
- `VaultDetail.tsx` imports them. It shrinks by roughly 1,900 lines, to
  about 7,200.

If `SendTab.tsx` itself is still over 800 lines after the move (it will
be, at about 1,450), its signing screen splits into its own file
(`SendSigning.tsx`) in the same slice. That's still a move: same props,
same state.

## How we know nothing changed

- **Before the move:** the full `npm test`, lint, build, typecheck (10
  pre-existing errors) and `npm run walk:screens` all pass. They pass on
  today's code.
- **After:** the same commands must give the same results: the same test
  counts, still 10 typecheck errors, and the walk's 7 taps all on screen.
- The diff is checked for moves only: every line removed from
  `VaultDetail.tsx` appears unchanged in the new files, apart from import
  and export lines. A script compares the two and reports any line that
  changed.
- The production bundle is built before and after, and its size is
  compared. A large jump means something got pulled in twice.

## Decisions that are the operator's

None new: the scope ("Send first", one tab at a time) is the chip already
answered. The folder name (`pages/vault-detail/`) follows how the page is
already named. Each later tab gets its own short line in this note and the
same checks, and ships only on the operator's word.

## Blast radius

- Files: `VaultDetail.tsx` (imports, removed blocks) plus four or five new
  files. Checked 2026-11-26: the only import of `VaultDetail` anywhere is
  `App.tsx` (the default export, unchanged). About 25 other files mention
  it, but only in comments. Two of those are test comments
  (`test-dust-change.mjs`, `download-local-proof.mjs`) that say "SendTab in
  VaultDetail.tsx", and they get updated to the new file.
- Tests that read `VaultDetail.tsx` as text:
  `scripts/test-no-viewport-traps.mjs` and `scripts/test-readability.mjs`
  scan files by folder. Both must still cover the new files; this gets
  checked, not assumed. Any test that greps `VaultDetail.tsx` for a
  string gets pointed at the new file.
- The screen walk (it reads the screen, not the file) needs no change.
- Server, money logic, Tapit and anything users are told: untouched.

## Deliberately left out

- Moving the other tabs: each is its own slice, in order of size and risk
  (History and signing next, then Members, Activity, Requests, Messages,
  Trust, Overview).
- Any clean-up, renaming or "while I'm here" fix inside the moved code.
  Anything found goes in a list for later.
- Splitting `ProposalDetail.tsx` (1,443 lines).

## The whole plan (operator asked "Is there more? Give me the plan", 2026-11-26)

Sizes are measured from the file today. Each slice is a move only, with the
same checks (tests, typecheck count, screen walk, the moved-lines script and
the bundle size), and each ships on the operator's word.

| Slice | What moves out | Lines | Page after |
|---|---|---|---|
| 1 | Send screen (1,453) + coins list (332) + paste-a-signed-PSBT box + shared helpers | ~1,900 | ~7,200 |
| 2 | History and spend requests: HistoryTab, ProposalCard (248), MyKeyModal (139) | ~700 | ~6,500 |
| 3 | Distributions (money-touching): TrancheClaimModal (422), DistributionWalletCreator (306), DistributionWalletsSection | ~950 | ~5,550 |
| 4 | Overview's vault pictures: VaultStructureTree (282), VaultPhaseCard (149), the leaf builders, ActionGuide (274), SuccessionBanner (143), DraftReadinessCard (279) | ~1,300 | ~4,250 |
| 5 | Trust document and stipends: TrustDocSection (244), StipendsSection (178), StipendEditor (184) | ~600 | ~3,650 |
| 6 | The other tabs: Members (317), Messages (319), Requests (195) + NewRequestModal (179), Activity | ~1,300 | ~2,350 |
| 7 | The rest: RotateVaultModal (174), BlocOverviewTab (182), Overview itself (488), smaller pieces; the page shell (598) stays | ~1,500 | ~800 |

End state: `VaultDetail.tsx` is just the page shell (header, balance, tabs),
about 800 lines. Each tab and section lives in its own file under
`pages/vault-detail/`, every one under 800 lines, and the Send screen's
signing step is split off if needed.

Not in this plan, and for the operator to decide after it: three more files
are over the 800-line limit. These are `VaultWizard.tsx` (2,916),
`KeyManager.tsx` (1,489) and `ProposalDetail.tsx` (1,475). They would get
the same treatment later.

## Built (2026-11-26): all seven slices

Each slice was applied by a tool (`split.py`, kept with the session's
scratch files). It copies every top-level block byte for byte and asserts
it, so the only edits are an added `export` and the relative path of one
dynamic `import("../lib/supabase")`, one folder deeper. Imports were worked
out per file, and unused ones were pruned by the linter. After every slice:
npm test exit 0; typecheck the same 10 pre-existing errors (some now
reported from the moved files); lint 0 errors / 9 warnings; build ok;
`walk:screens` OK, 7 taps. Commits: d0cd9a7, 2cdd226, 1e32662, 7681f39,
5c32797, 95136a1, f7b731e.

Bundle check: the production build before the split (`d0cd9a7~1`) and after
it have the same JS files at the same byte sizes. For example, `index` is
1,484,471 bytes in both, and `PDFButton` is 428,567 in both. Only the hash
names differ.

Result: `VaultDetail.tsx` went from 9,147 lines to 671. There are 24 files
in `pages/vault-detail/`, and all but one are under 800 lines. The
exception is `SendTab.tsx`, at 1,527 lines. It is one function, so cutting
it smaller means splitting inside a function. That is not a pure move, so
it is left for its own Build Note.

Two small plan changes made while building:
- `autofillTrustDocIfEmpty` went to `shared.ts` in slice 4 instead of
  `TrustDoc.tsx`, because the draft card uses it.
- The leaf helpers went to `leaves.ts`, separate from the components in
  `VaultLeaves.tsx`. That keeps the hot-reload lint warnings at the same
  count.
