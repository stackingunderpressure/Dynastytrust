#!/usr/bin/env bash
# Fleet guardrail standard — Stop. Fast, non-blocking honesty check.
# Runs the test-baseline tripwire every time the session comes to rest, so a
# deleted or gutted test is flagged the moment it happens rather than waiting
# for CI. It stays fast (a file scan, milliseconds) on purpose — the heavy gate
# truth (typecheck/lint/test/build) is CI's job and the session's own
# `npm run verify`. This hook never blocks; it warns to stderr.
if [ -f scripts/test-baseline.mjs ]; then
  if ! node scripts/test-baseline.mjs >/tmp/stop-baseline.log 2>&1; then
    echo "GUARDRAIL WARNING: test-baseline tripwire failed — a test may have been removed or gutted this session. Review before pushing:" >&2
    cat /tmp/stop-baseline.log >&2
  fi
fi
exit 0
