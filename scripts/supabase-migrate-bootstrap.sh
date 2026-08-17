#!/usr/bin/env bash
# supabase-migrate-bootstrap.sh -- ONE-TIME adoption step, run by hand
# via workflow_dispatch, never automatically. Marks every migration
# file currently in supabase/migrations/ as already-applied in the
# tracking table WITHOUT running any of their SQL.
#
# Why this exists: every file in supabase/migrations/ at the time this
# script was written had already been applied to the live database by
# hand (pasted into the Supabase SQL editor) before supabase-
# migrate.sh's tracking table existed. Without this step, the first
# real deploy run would try to re-run all of them from scratch --
# most are idempotent (if not exists / drop-then-add) and would no-op
# harmlessly, but at least one historical migration
# (20260615232216_realtime.sql, `alter publication supabase_realtime
# add table ...`) is NOT idempotent and would fail outright on a
# table already in the publication.
#
# Safe to re-run: re-marking an already-recorded version is a no-op
# (on conflict do nothing). This script never executes migration SQL,
# only records that it already ran -- if you run this against a
# migration that was NOT actually already applied, that migration will
# be silently skipped forever by supabase-migrate.sh. Only run this
# once, for the exact set of files known to already be live.
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is required}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-supabase/migrations}"

API="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query"

run_query() {
  local sql="$1"
  local body http_status response
  body=$(jq -Rs '{query: .}' <<<"$sql")
  response=$(curl -sS -w '\n%{http_code}' \
    --request POST "$API" \
    --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    --header "Content-Type: application/json" \
    --data-binary "$body")
  http_status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
    echo "::error::Supabase Management API returned HTTP $http_status" >&2
    echo "$body" >&2
    return 1
  fi
  echo "$body"
}

echo "Ensuring supabase_migrations.schema_migrations exists..."
run_query "
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (
    version text primary key,
    name text,
    inserted_at timestamptz not null default now()
  );
" >/dev/null

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

if [ "${#files[@]}" -eq 0 ]; then
  echo "No migration files found in $MIGRATIONS_DIR -- nothing to bootstrap."
  exit 0
fi

values=""
for f in "${files[@]}"; do
  fname=$(basename "$f")
  version="${fname%%_*}"
  name="${fname#*_}"
  name="${name%.sql}"
  version_escaped=$(printf '%s' "$version" | sed "s/'/''/g")
  name_escaped=$(printf '%s' "$name" | sed "s/'/''/g")
  values="${values}('${version_escaped}', '${name_escaped}'),"
done
values="${values%,}"

echo "Marking ${#files[@]} migration(s) as already applied..."
run_query "
  insert into supabase_migrations.schema_migrations (version, name)
  values ${values}
  on conflict (version) do nothing;
" >/dev/null

echo "Confirming..."
run_query "select version, name from supabase_migrations.schema_migrations order by version;"
