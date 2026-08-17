#!/usr/bin/env bash
# supabase-migrate.sh -- applies pending supabase/migrations/*.sql to the
# live project via the Supabase Management API's general SQL-query
# endpoint (POST /v1/projects/{ref}/database/query), authenticated with
# only a personal access token. No CLI, no separate DB password --
# 2026-08-17, operator: "that's decisive evidence from your own
# projects, and it lines up with how Supabase's own MCP tooling
# applies migrations -- token only, no CLI." Supabase's own MCP server
# apply_migration tool works this same way: send SQL to the Management
# API, which executes it and (per Supabase's own docs) tracks it in
# supabase_migrations.schema_migrations. The dedicated
# POST /database/migrations endpoint that does this tracking
# automatically is gated to "select customers" per Supabase's docs, so
# this script does its own bookkeeping against a self-managed tracking
# table with the same name and the columns Supabase's own docs
# describe (version, name, inserted_at) -- not independently verified
# byte-for-byte against the CLI's own DDL, so treat it as compatible in
# spirit, not guaranteed byte-identical if the real CLI is ever adopted
# later.
#
# Required env: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF.
# Optional env: MIGRATIONS_DIR (default: supabase/migrations).
#
# Every migration file is applied inside an explicit BEGIN/COMMIT that
# also inserts its own tracking row -- if the migration SQL fails, the
# transaction rolls back and the tracking row is never written, so a
# failed run never gets silently marked as applied.
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is required}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-supabase/migrations}"

API="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query"

# Runs a SQL string against the Management API. Exits non-zero with the
# API's error body on failure -- never swallows an error silently.
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

echo "Fetching already-applied migration versions..."
applied_json=$(run_query "select version from supabase_migrations.schema_migrations order by version;")
applied_versions=$(echo "$applied_json" | jq -r '.[].version' 2>/dev/null || echo "")

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

if [ "${#files[@]}" -eq 0 ]; then
  echo "No migration files found in $MIGRATIONS_DIR"
  exit 0
fi

applied_count=0
skipped_count=0
for f in "${files[@]}"; do
  fname=$(basename "$f")
  version="${fname%%_*}"
  name="${fname#*_}"
  name="${name%.sql}"

  if grep -qxF "$version" <<<"$applied_versions"; then
    skipped_count=$((skipped_count + 1))
    continue
  fi

  echo "Applying $fname..."
  migration_sql=$(cat "$f")
  version_escaped=$(printf '%s' "$version" | sed "s/'/''/g")
  name_escaped=$(printf '%s' "$name" | sed "s/'/''/g")
  wrapped_sql="begin;
${migration_sql}
insert into supabase_migrations.schema_migrations (version, name) values ('${version_escaped}', '${name_escaped}');
commit;"
  run_query "$wrapped_sql" >/dev/null
  applied_count=$((applied_count + 1))
  echo "  -> applied and recorded as $version"
done

echo ""
echo "Done: $applied_count applied, $skipped_count already up to date."
