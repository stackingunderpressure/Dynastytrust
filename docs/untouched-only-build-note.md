# Build note: let "if untouched for" be a vault's only later path

Operator, 2026-11-24, after the compile step refused his vault: "Why also we
have to have an absolute path?" ... "I don't understand the problem with 1 of
2 first path and a relative lock for a fall back. I might want a 2 month
deadman switch or 13 month one. Either way I can move my coins to avoid the
trigger. I might have an absolute recovery on another leaf. Just want to stay
nimble and educate consequential decisions plainly."

## What would be built

The compiler stops refusing a vault whose only later path is "if untouched
for" (a dead man's switch). The vault builder teaches what that means, plainly,
at the moment it is chosen, instead of refusing it at the end.

## Why the rule existed, and why it can go

It is our rule, not Bitcoin's. `older()` is valid alone; BIP 68 allows up to
65,535 blocks (~15 months) and our cap stays 60,000 (~13.7 months). The rule
dates from when "later" meant multi-year inheritance, which only a fixed date
can express. A 2- or 13-month dead man's switch is a different, legitimate
design: the owner keeps it shut by moving the coins; if they stop, the path
opens after the wait. The real risk is a person not understanding that -- an
education problem, which is what this change answers.

## Blast radius (read from the code)

- `protocol/src/policy_compiler.rs` `verify_leaf_policy`: the
  has_relative && !has_absolute refusal goes; its test
  `relative_leaf_cannot_be_the_only_non_immediate_fallback` flips to
  "accepted"; the `RelativeTimelockNeedsAbsoluteFallback` error and the doc
  comments that state the rule.
- Two compilers must change TOGETHER: the Fly compiler the website uses
  (`deploy-compiler.yml`, deploys on push to main when compiler/ or protocol/
  change) and the compiler wasm in the web app (rebuild + manifest). If only
  one ships, the website and a phone disagree on which vaults are valid.
- `scripts/fixtures/vault-rules-leaves.json`: check for a recorded refusal of
  this shape (none seen; the "older" case recorded there has a dated path).
- Spending: already works -- slice 5 builds per-coin `older()` spends, and
  today's Bitcoin Core proof spent an "if untouched" path with Core alone.
- Words that state the old rule: CLAUDE.md (absolute-timelock section, lines
  ~277), Sage's fact sheet (`netlify/functions/assistant.js`, item 1: "a
  vault may never rely on it as its only way back in"), and the held
  Shape-step refusal (`6c9409a`, on the branch, NOT live) -- that refusal is
  replaced by the explanation below; its fix to the error-message matching
  stays.
- Vault builder (`VaultWizard.tsx`): when the only later path is "if untouched
  for", a plain card says what it means for this vault, computed from its
  numbers: moving the coins restarts the clock; if the coins sit untouched for
  <wait>, <who> can spend them alone; nothing opens on a date; the wait can
  never exceed about 13.7 months.
- Backups and the trust document already describe "if untouched" honestly
  ("resets on any spend from any path"); check, expected unchanged.
- Existing vaults: unaffected (nothing changes for a compiled vault).
- SeedSigner: the fork's spend-path screen has not been seen on an
  untouched-only vault.

## Deliberately left out

Changing the 60,000-block cap; reminders that warn the owner before a dead
man's switch opens (a natural next slice); any change to fixed-date paths.

## Decisions (operator's chips, 2026-11-24)

1. Teach it with a **plain card + tick box** (like the must-sign warning).
2. **Retire Fly first** (docs/retire-fly-build-note.md), so the rule lives
   in one compiler; then this; one release after the operator's OK.

## Built (2026-11-24, branch only)

- Rust: the refusal and its error are gone; the test now proves an
  untouched-only vault compiles to `older(52560)` with no `after()`.
  Compiler wasm rebuilt; all 231 recorded compiler answers still identical
  (no recorded request had this shape).
- Builder: the held Shape-step refusal (6c9409a) is removed; on the keys step
  a "This vault is a dead man's switch" card, computed from the vault's own
  paths (`lib/path-risk.ts` `deadMansSwitchLines`, shortest wait first, plain
  words), and an "I understand" tick that gates Continue and clears itself if
  those paths change. Its error-message matching fixes stay.
- Sage's fact sheet and CLAUDE.md now state the new rule.
- Proof: Bitcoin Core 32.1 ranged proof re-run on a vault with NO fixed-date
  path: 7/7, the switch refused while young and mined after the wait, by our
  stack and by Core alone.
