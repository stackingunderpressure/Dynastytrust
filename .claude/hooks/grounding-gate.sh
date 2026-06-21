#!/usr/bin/env bash
# Fleet guardrail standard — UserPromptSubmit. Non-blocking grounding nudge.
cat <<'CTX'
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Ground before editing: read the actual files you will change and the surrounding code; work from the repo as it is, not from memory. Verify, never trust — including your own prior reasoning. If the code contradicts the plan, surface it before acting. Run `npm run verify` before claiming done; never weaken or delete a test to pass."}}
CTX
