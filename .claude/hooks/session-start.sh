#!/usr/bin/env bash
# Fleet guardrail standard — SessionStart. Install so gates can run; ground hard.
if [ ! -d node_modules ]; then npm install --no-audit --no-fund >&2 2>&1 || true; fi
cat <<'CTX'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"GUARDRAILS (read GUARDRAILS.md + CLAUDE.md): This is money-touching, irreversible Bitcoin software. Ground in the real code before touching it — read the function before you call it; when the task names cryptography, timelocks, descriptors, or signing, read lib/psbt-signer.ts and lib/keystore.ts first. Verify, never trust, including yourself. Keys and mnemonics never leave the browser unencrypted, never get logged or committed. Before claiming done, run `npm run verify`; typecheck has documented PRE-EXISTING errors (keystore/VaultDetail/ProposalDetail) — distinguish those from any you cause. NEVER delete or weaken a test to go green. Do not push to main."}}
CTX
