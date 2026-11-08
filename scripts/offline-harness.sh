#!/usr/bin/env bash
# Offline, deterministic end-to-end vault proof: builds and runs the REAL Rust
# compiler locally (no Fly, no network, no Bitcoin node), then drives every
# spending path of every vault shape through compile -> build PSBT -> sign with
# the real browser signer -> finalize, asserting each produces a valid tx and
# that timelocks / quorums / consent gates are actually enforced.
#
# One command:  bash scripts/offline-harness.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[harness] building the compiler (cached after first run)..."
cargo build -p dynastytrust_compiler >/dev/null 2>&1

PORT=8899
SECRET=testsecret
COMPILER_SECRET="$SECRET" PORT="$PORT" ./target/debug/dynastytrust_compiler >/tmp/dt-harness-compiler.log 2>&1 &
CPID=$!
trap 'kill "$CPID" 2>/dev/null || true' EXIT

echo "[harness] waiting for the compiler..."
for _ in $(seq 1 40); do
  if curl -sf -H "Authorization: Bearer $SECRET" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

COMPILER_URL="http://127.0.0.1:$PORT" COMPILER_SECRET="$SECRET" \
  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs \
       scripts/offline-vault-harness.mjs
