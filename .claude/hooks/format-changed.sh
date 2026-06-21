#!/usr/bin/env bash
# Fleet guardrail standard — PostToolUse formatter (Edit|Write|MultiEdit).
# Best-effort: run eslint --fix on the file the tool just touched so style
# never becomes a gate failure. Always non-blocking; never fails the tool call.
input=$(cat)
file=$(printf '%s' "$input" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const p=(j.tool_input&&(j.tool_input.file_path||j.tool_input.filePath))||'';process.stdout.write(p)}catch{}});" 2>/dev/null)
case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mts|*.cts)
    if [ -f "$file" ]; then npx eslint --fix "$file" >/dev/null 2>&1 || true; fi
    ;;
esac
exit 0
