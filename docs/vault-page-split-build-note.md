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
