# GUARDRAILS — the fleet standard

This repo runs the Asymmetric Industries fleet guardrail standard: the
best-of-what-we've-learned, made mechanical so it holds whether or not a human
is watching, and safe enough to point autonomous loops at. Every existing repo
is being brought to this standard and every app spawned through AppCommander
inherits it from birth.

The whole thing rests on one principle: **a gate you trust the agent to run is
not a gate.** The verifier must be external to the thing being verified, the
tests must be protected from the thing trying to pass them, and the doctrine
must not claim protection it doesn't have.

## The pieces

### 1. External CI verifier — `.github/workflows/ci.yml`
Re-runs every gate (`typecheck`, `lint`, `test`, `build`, plus the two scripts
below) in a fresh checkout on GitHub's runner, independent of whatever a
session claimed in its comms. This is the one verifier a loop cannot fool,
because it doesn't run in the agent's sandbox. Report-only today; flip it to a
**required status check** in branch protection once the repo is reliably green.

### 2. Test-baseline tripwire — `scripts/test-baseline.mjs` + `.test-baseline.json`
Counts test files and test cases and fails if either drops below the committed
baseline. This is what stops the worst loop cheat — deleting or gutting a
failing test to go green. The floor only ratchets up: when you legitimately add
tests, re-baseline with `npm run test:baseline:write`. Runs in CI and in the
Stop hook.

### 3. Doctrine drift-check — `scripts/doctrine-check.mjs`
Scans the doctrine docs (`CLAUDE.md`, `GUARDRAILS.md`, `AGENTS.md`) for any
reference to a `.claude/hooks/*.sh` or `scripts/*` mechanism and fails if it
isn't on disk. A doctrine that promises a hook that doesn't exist is worse than
an honest blank, because it tells the next session it's protected when it
isn't. This keeps the map matching the territory.

### 4. The hook kit — `.claude/settings.json` + `.claude/hooks/`
- **SessionStart** (`session-start.sh`) — installs deps so the gates can run,
  and injects grounding: read before editing, the pure libs are the single
  source of truth, run `npm run verify` before done, never weaken a test.
- **UserPromptSubmit** (`grounding-gate.sh`) — a non-blocking grounding nudge
  on every prompt.
- **PostToolUse** (`format-changed.sh`) — best-effort `eslint --fix` on the
  file just edited, so style never becomes a gate failure. Never blocks.
- **Stop** (`stop-check.sh`) — runs the fast test-baseline tripwire every time
  the session comes to rest, so a removed test is flagged immediately. Heavy
  gate truth stays with CI and `npm run verify`; this hook never blocks.

## The one command
`npm run verify` runs the full local gate suite: typecheck, lint, test, build,
test-baseline, doctrine-check. Run it before claiming a session is done. CI
re-runs the same thing as the external, unfoolable check.

## The rules for loops
- Loops produce a **reviewed branch**, never a deploy. `main` is the human's
  deliberate merge.
- Never delete or weaken a test to pass. The baseline tripwire and CI catch it.
- Loops never touch irreversible paths (signing, keys, broadcast, money). Those
  stay human-in-the-loop regardless of how green the gates are.
- If the code contradicts the plan, stop and surface it. Ambiguity escalates;
  it is not resolved by guessing.
