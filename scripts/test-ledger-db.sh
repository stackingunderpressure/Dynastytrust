#!/usr/bin/env bash
# Proves the vault_ledger migration against a REAL Postgres: the chain
# can only be extended, never forked, edited, deleted or truncated -- by
# anyone, including the service role -- and the database recomputes each
# hash itself. Starts a throwaway cluster, applies the migration, runs
# the checks, tears it down.
#
# On demand (needs PostgreSQL 13+ installed):  bash scripts/test-ledger-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "[ledger-db] UNVERIFIED: PostgreSQL server binaries not found" >&2; exit 1
fi
DIR="$(mktemp -d)"; PORT=54329
chmod 777 "$DIR"
AS() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$1"; else bash -c "$1"; fi; }
cleanup() { AS "$PGBIN/pg_ctl -D $DIR/data -m immediate stop >/dev/null 2>&1" || true; rm -rf "$DIR"; }
trap cleanup EXIT
AS "$PGBIN/initdb -D $DIR/data -A trust >/dev/null"
AS "$PGBIN/pg_ctl -D $DIR/data -o '-p $PORT -c listen_addresses=127.0.0.1 -k $DIR' -l $DIR/log -w start >/dev/null"
PSQL="psql -h 127.0.0.1 -p $PORT -U postgres -v ON_ERROR_STOP=1 -qAt"

# The slice of Supabase this migration assumes exists.
$PSQL <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table vault_members (vault_id uuid, user_id uuid, status text);
create table vault_events (id uuid primary key default gen_random_uuid(), vault_id uuid, user_id uuid, event_type text, metadata jsonb default '{}');
alter table vault_events enable row level security;
create policy "users_own_vault_events" on vault_events for all using (auth.uid() = user_id);
grant usage on schema public, auth to anon, authenticated, service_role;
grant all on vault_events, vault_members to authenticated, service_role;
SQL
$PSQL -f supabase/migrations/20261110230000_vault_ledger.sql
$PSQL -f supabase/migrations/20261110230000_vault_ledger.sql   # idempotent: applying twice must not error
$PSQL -f supabase/migrations/20261111000000_vault_ledger_anchors.sql
$PSQL -f supabase/migrations/20261111000000_vault_ledger_anchors.sql   # idempotent
$PSQL -c "grant select on vault_ledger, vault_ledger_anchors to authenticated, service_role; grant insert, update, delete on vault_ledger, vault_ledger_anchors to service_role;"

PGPORT=$PORT node scripts/test-ledger-db.mjs
