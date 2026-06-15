# Quarterback Workflow & Build-Fee Discipline (2026-06-15)

Operator directive, binding on every session and every agent working in this
repo or the sibling `tapit-wallet` repo. This OVERRIDES any conflicting
"direct-to-main" language in CLAUDE.md or the carpenter doctrine. When in doubt,
this file wins on workflow; the architecture lives in
`docs/build-map-and-cut-lists.md` and `docs/sovereignty-education-bot.md`.

## The operator's decision filter (the five flavors)

Any choice a builder faces is resolved by these, in the operator's words. They
replace most need for the operator to weigh in:

1. **Make it frictionless.** The surface is the product; a person taps and it
   just works.
2. **Make it secure.** Safe beats fast; the user's keys never leave their wallet
   unencrypted.
3. **Don't go the easy cheap way.** No shortcuts that cost sovereignty or
   correctness.
4. **Don't trust -- verify.** Ground every claim in code and on-chain reality;
   tap-to-confirm shows the real value; no blind taps, no "it probably works."
5. **Build it like Bitcoin would be proud of every step.** Each cut should be
   something a serious Bitcoiner would respect.

If a decision is fully answered by these, proceed without asking. Use chip-form
(AskUserQuestion) only when the flavors genuinely do not resolve it.

## The roles

- **Quarterback (the orchestrating session).** Holds the whole map, enforces the
  rails and the flavors, keeps the cross-repo dependency order straight, runs
  each repo's gates, decides what is cut first, fans out parallel agents for
  independent work, integrates their results, and controls when anything is
  pushed or merged.
- **Auditor (a fresh-eyes agent).** Spawned periodically -- after each phase or
  every few cuts -- read-only. Checks the accumulated diff against the roadmap,
  the risk register (the honest lines in `build-map-and-cut-lists.md` section 6),
  the five flavors, and green gates; reports drift; the quarterback corrects
  before continuing. The quarterback may also self-audit, but an independent
  auditor pass is the checks-and-balances default at phase boundaries.

## The branch + merge rule (the build-fee discipline)

This exists because a Netlify production build fires (and bills) on every push
to the production branch, and the old `tapit-wallet` Stop hook was pushing the
working branch to `main` on every session close -- a build every time.

- **All work happens on the working branch.** The active branch is
  `claude/<topic>-<id>`. Never push to `main` as part of routine cutting.
- **Nothing auto-pushes to main.** The `tapit-wallet` session-close hook was
  changed to push the working branch only and to tag its checkpoint commit
  `[skip ci]`. DynastyTrust has no such hook; just never push main here.
- **Batch the merges.** Code and context accumulate on the branch across many
  cuts; the merge to `main` happens deliberately, in a few big batches, ONLY on
  the operator's explicit go -- so the production build (and fee) fires once per
  batch, not once per cut.
- **`[skip ci]` on routine branch commits** is belt-and-suspenders: even if
  branch deploys are enabled, those commits will not build. The deliberate
  merge-to-main commit OMITS the marker so that one build runs.
- **The one thing only the operator can do** (dashboard, not repo): in Netlify,
  disable Branch Deploys and Deploy Previews for these working branches (or pause
  auto-publish) so the production branch is the sole build trigger. The repo-side
  levers above are the safety net regardless.

## Cadence each cut follows

1. Cut on the working branch, honoring the design system and the rails.
2. Run the repo's gates (lint / typecheck / build / test) locally; they stay
   green or are honestly marked.
3. Commit atomically with `[skip ci]` in the message.
4. Push the working branch (batched -- do not push every micro-commit).
5. Hand state to the quarterback. The quarterback integrates and, at phase
   boundaries, runs the auditor.
6. Merge to main only on the operator's explicit command, in a batch.

## The rails that never bend (from the risk register)

No control: the bot proposes, the human disposes; no key ever enters a bot's
context; no value commits without a human tap. An attestation is never a spend
signature. Timelocks are absolute (refresh, not a self-resetting timer). Big
quorums go off-chain (FROST), not in the raw script. Frontier crypto (FROST
resharing, PTLC/adaptor) uses vetted constructions only, never hand-rolled. The
fast path can stall; the timelock is the guarantee. An in-flight ceremony is
abortable under a duress signal. The banner shows the meaning, never just the
hex. Pay with value, never with a piece of spending control.
